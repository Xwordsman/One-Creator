import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  Account,
  AutomationJob,
  ContentDocument,
  Feed,
  FeedEntry,
  Material,
  MetricSnapshot,
  PublishTask,
  StudioItem,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { startAutomationWorker } from '@one-creator/server/automation';
import { csvRows } from '@one-creator/server/studio';
import { buildApp } from '../apps/api/src/app.js';

type Handler = (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void;
/** A local HTTP origin standing in for public sources and model services. */
function mockServer(handler: Handler) {
  const hits: string[] = [];
  let origin = '';
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push(request.url ?? '');
      handler(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });
  return {
    hits,
    origin: () => origin,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve(origin);
        }),
      ),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const state = { rssVersion: 1 as 1 | 2, atomFails: false, embedStatus: 0 };
const embedCalls: { model: string; input: string[]; authorization: string }[] = [];

function rss(version: 1 | 2) {
  const hot =
    version === 1
      ? '<item><title>AI 写作 &amp; 选题周报</title><link>https://news.example.com/posts/101?utm_source=rss&amp;id=7#top</link><description>&lt;p&gt;本周 &lt;b&gt;AI 选题&lt;/b&gt; 观察：R&amp;amp;D 投入继续增加&lt;/p&gt;</description><pubDate>Fri, 16 Oct 2026 08:00:00 +0800</pubDate></item>'
      : '<item><title>AI 写作 &amp; 选题周报（更新）</title><link>https://news.example.com/posts/101?utm_source=rss&amp;id=7#comments</link><description>&lt;p&gt;更新后的 AI 选题观察&lt;/p&gt;</description><pubDate>Sat, 17 Oct 2026 09:00:00 +0800</pubDate></item>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>行业热点</title><link>https://news.example.com/</link>
${hot}
<item><title>周末菜谱推荐</title><link>https://news.example.com/posts/102</link><description>家常菜做法</description><pubDate>Thu, 15 Oct 2026 08:00:00 +0800</pubDate></item>
<item><title>AI 选题合作广告</title><link>https://news.example.com/posts/103</link><description>品牌推广</description><pubDate>Thu, 15 Oct 2026 09:00:00 +0800</pubDate></item>
<item><title><![CDATA[视频脚本 & AI 工具清单]]></title><link>/posts/104</link><content:encoded><![CDATA[<p>脚本 <em>选题</em> 与 AI &amp; 剪辑</p>]]></content:encoded></item>
<item><title>没有链接的 AI 选题</title><description>只有标题和正文</description></item>
${version === 2 ? '<item><title>新的 AI 选题日历</title><link>https://news.example.com/posts/105</link><description>十月 AI 选题日历</description><pubDate>Sat, 17 Oct 2026 10:00:00 +0800</pubDate></item>' : ''}
</channel></rss>`;
}
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>创作者博客</title><link rel="self" href="https://blog.example.com/atom.xml"/>
<entry><title type="text">Atom 写作复盘</title><link rel="self" href="https://blog.example.com/entries/1.xml"/><link rel="alternate" type="text/html" href="https://blog.example.com/entries/1?a=1&amp;b=2"/><id>tag:blog,1</id><updated>2026-10-14T09:30:00+08:00</updated><summary type="html">&lt;p&gt;复盘 &lt;strong&gt;要点&lt;/strong&gt;&lt;/p&gt;</summary></entry>
<entry><title>1024</title><link href="https://blog.example.com/entries/1024"/><id>tag:blog,2</id><published>2026-10-13T00:00:00Z</published><updated>2026-10-15T00:00:00Z</updated><content type="html">程序员节的选题</content></entry>
</feed>`;
const jsonFeed = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: '选题灵感',
  items: [
    {
      id: 'j1',
      url: 'https://ideas.example.com/items/1',
      title: 'JSON 选题灵感',
      content_html: '<p>灵感 <b>清单</b> &amp; 素材</p>',
      date_published: '2026-10-12T10:00:00+08:00',
    },
    {
      id: 'j2',
      external_url: 'https://ideas.example.com/external/2',
      title: '外部链接条目',
      content_text: '纯文本正文',
      summary: '摘要不使用',
    },
    { id: 'j3', title: '没有链接', content_text: '应被丢弃' },
  ],
});
const malformed =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>坏数据</title><item><title>未闭合<link>https://bad.example.com/1</link></item></channel></rss>';
const huge = Buffer.concat([
  Buffer.from('<?xml version="1.0"?><rss version="2.0"><channel><title>巨大</title>'),
  Buffer.alloc(5 * 1024 * 1024, ' '),
  Buffer.from('</channel></rss>'),
]);
const coffeeArticle = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>手冲咖啡的萃取笔记</title><meta name="author" content="林小咖"></head>
<body><nav>网站导航 首页 关于我们 联系方式</nav><main><article><h1>手冲咖啡的萃取笔记</h1>
<p>手冲咖啡的风味取决于研磨度、水温和注水节奏，这篇笔记记录了一次完整的萃取实验，供后续写作引用。</p>
<p>实验使用浅烘焙豆子，粉水比一比十五，水温九十二度，分三段注水，总时长两分半，咖啡的酸甜更加平衡。</p>
<p>对比中细研磨与中粗研磨，前者的手冲咖啡口感更饱满，后者更干净清爽，可以根据读者口味给出建议。</p>
</article></main><footer>版权所有 示例站点</footer></body></html>`;
const secretArticle = `<!doctype html><html><head><title>内网机密文档</title></head><body><article><h1>内网机密文档</h1>
<p>这是一份只应在内网访问的文档，如果它被导入素材库，说明来源地址校验失效，测试必须失败。</p>
<p>文档内容包含内部配置说明与访问方式，长度足够让正文提取算法把它识别为文章主体内容。</p></article></body></html>`;

const site = mockServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const send = (
    status: number,
    type: string,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, { 'content-type': type, ...headers });
    response.end(body);
  };
  if (url.pathname === '/rss.xml')
    return send(200, 'application/rss+xml; charset=utf-8', rss(state.rssVersion));
  if (url.pathname === '/atom.xml')
    return state.atomFails ? send(500, 'text/plain', 'down') : send(200, 'application/atom+xml', atom);
  if (url.pathname === '/feed.json') return send(200, 'application/feed+json', jsonFeed);
  if (url.pathname === '/disabled.xml') return send(200, 'application/rss+xml', rss(1));
  if (url.pathname === '/broken.xml') return send(500, 'text/plain', 'boom');
  if (url.pathname === '/malformed.xml') return send(200, 'application/rss+xml', malformed);
  if (url.pathname === '/huge.xml') return send(200, 'application/rss+xml', huge);
  if (url.pathname === '/articles/coffee.html') return send(200, 'text/html; charset=utf-8', coffeeArticle);
  if (url.pathname === '/articles/short.html')
    return send(
      200,
      'text/html; charset=utf-8',
      '<html><head><title>短页</title></head><body><p>太短</p></body></html>',
    );
  if (url.pathname === '/articles/redirect-private')
    return send(302, 'text/plain', '', { location: `${vectors.origin()}/secret` });
  return send(404, 'text/plain', 'missing');
});
const topics = [
  ['咖啡', '拿铁', '浓缩', '手冲'],
  ['茶', '乌龙', '普洱'],
  ['代码', '编程', '函数'],
];
/** Deterministic embeddings: counts of topic words plus a constant dimension. */
const vectorize = (text: string) => [
  ...topics.map((words) => words.reduce((sum, word) => sum + text.split(word).length - 1, 0)),
  0.1,
];
/** Not in integrationOrigins: it doubles as the "private service" that imports must never reach. */
const vectors = mockServer((request, response, body) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && url.pathname.endsWith('/embeddings')) {
    const input = JSON.parse(body) as { model: string; input: string[] };
    embedCalls.push({
      model: input.model,
      input: input.input,
      authorization: request.headers.authorization ?? '',
    });
    if (state.embedStatus) {
      response.writeHead(state.embedStatus, { 'content-type': 'application/json' });
      response.end('{"error":"unavailable"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    // Reverse the order so the client has to sort by index.
    response.end(
      JSON.stringify({
        data: input.input.map((text, index) => ({ index, embedding: vectorize(text) })).reverse(),
        usage: { prompt_tokens: input.input.length * 3, total_tokens: input.input.length * 3 },
      }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(secretArticle);
});
const privateHits = () => vectors.hits.filter((hit) => !hit.endsWith('/embeddings'));

let db: Database;
let app: FastifyInstance;
let config: AppConfig;
let folder: string;
let cookie: string;
let accountA: Account;
let accountB: Account;
const request = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { cookie, 'x-creator-client': 'web', ...headers },
  });
const automation = async (jobId: string) =>
  (await request('GET', `/api/automation/${jobId}`)).json<AutomationJob>();
const startJob = async (payload: Record<string, unknown>, key = id()) => {
  const response = await request('POST', '/api/automation', payload, { 'idempotency-key': key });
  expect(response.statusCode, response.body).toBe(202);
  return response.json<AutomationJob>();
};
/** Run the general automation worker deterministically, including the feed schedule, until nothing is due or queued. */
async function drain() {
  const worker = startAutomationWorker(db, config, 1000000);
  try {
    await expect
      .poll(
        async () => {
          await worker.tick();
          const [{ pending }] = await db.rows<{ pending: number }>(
            `SELECT ((SELECT count(*) FROM automation_jobs WHERE status IN ('queued','running'))+(SELECT count(*) FROM feeds WHERE enabled=true AND "nextAt"<=now()))::int AS pending`,
          );
          return pending;
        },
        { timeout: 30000, interval: 20 },
      )
      .toBe(0);
  } finally {
    await worker.stop();
  }
}
async function settle(jobId: string, status: AutomationJob['status']) {
  const worker = startAutomationWorker(db, config, 1000000);
  try {
    await expect
      .poll(
        async () => {
          await worker.tick();
          return (await automation(jobId)).status;
        },
        { timeout: 30000, interval: 20 },
      )
      .toBe(status);
  } finally {
    await worker.stop();
  }
  return automation(jobId);
}

beforeAll(async () => {
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'discovery-'));
  await vectors.listen();
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'de'.repeat(32),
    production: false,
    workerMode: 'inline',
    // Only the "public" mock site is allowed; the vector mock stays a private address for fetchPublic.
    integrationOrigins: [await site.listen()],
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'discoverer', name: '发现验证', password: 'Discovery-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  accountA = (
    await request('POST', '/api/accounts', { name: '知乎专栏 A', platform: 'zhihu' })
  ).json<Account>();
  accountB = (
    await request('POST', '/api/accounts', { name: '头条号 B', platform: 'toutiao' })
  ).json<Account>();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  await site.close();
  await vectors.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('热点与 RSS 订阅（IDEA-02，模拟来源）', () => {
  const feeds: Record<string, Feed> = {};
  const feedRow = async (feedId: string) =>
    (await request('GET', '/api/feeds?limit=500'))
      .json<{ items: Feed[] }>()
      .items.find((feed) => feed.id === feedId)!;
  const entries = async (feedId: string) =>
    (await request('GET', `/api/feed-entries?feedId=${feedId}&limit=500`)).json<{
      items: (FeedEntry & { sourceKind: string })[];
      total: number;
    }>();
  const refreshJobs = (feedId: string) =>
    db.rows<AutomationJob & { idempotencyKey: string }>(
      `SELECT * FROM automation_jobs WHERE kind='feed_refresh' AND input->'data'->>'feedId'=$1 ORDER BY "createdAt"`,
      [feedId],
    );
  const feedInput = (feed: Feed) => ({
    name: feed.name,
    kind: feed.kind,
    url: feed.url,
    accountId: feed.accountId,
    enabled: feed.enabled,
    include: feed.include,
    exclude: feed.exclude,
    intervalMinutes: feed.intervalMinutes,
  });
  const create = async (payload: Record<string, unknown>) => {
    const response = await request('POST', '/api/feeds', payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Feed>();
  };

  it('RSS 2.0、Atom、JSON Feed 按计划自动抓取，保留来源链接、抓取与发布时间；包含/排除关键词生效；停用来源不抓取', async () => {
    expect(
      (
        await request('POST', '/api/feeds', {
          name: '错误类型',
          kind: 'atom',
          url: `${site.origin()}/atom.xml`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/api/feeds', {
          name: '错误协议',
          kind: 'rss',
          url: 'ftp://example.com/rss.xml',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/api/feeds', {
          name: '间隔太短',
          kind: 'rss',
          url: `${site.origin()}/rss.xml`,
          intervalMinutes: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/api/feeds', {
          name: '未知账号',
          kind: 'rss',
          url: `${site.origin()}/rss.xml`,
          accountId: id(),
        })
      ).statusCode,
    ).toBe(404);
    feeds.rss = await create({
      name: '行业热点 RSS',
      kind: 'rss',
      url: `${site.origin()}/rss.xml`,
      accountId: accountA.id,
      include: ['AI', '选题'],
      exclude: ['广告'],
      intervalMinutes: 30,
    });
    expect(feeds.rss).toMatchObject({
      enabled: true,
      include: ['AI', '选题'],
      exclude: ['广告'],
      intervalMinutes: 30,
      revision: 1,
      error: '',
      lastFetchedAt: null,
      accountId: accountA.id,
    });
    feeds.atom = await create({ name: '博客 Atom', kind: 'rss', url: `${site.origin()}/atom.xml` });
    expect(feeds.atom).toMatchObject({ include: [], exclude: [], intervalMinutes: 60, accountId: null });
    feeds.json = await create({
      name: '灵感 JSON Feed',
      kind: 'json_feed',
      url: `${site.origin()}/feed.json`,
    });
    feeds.disabled = await create({
      name: '已停用来源',
      kind: 'rss',
      url: `${site.origin()}/disabled.xml`,
      enabled: false,
    });
    expect((await request('GET', '/api/feeds?limit=500')).json<{ total: number }>().total).toBe(4);

    // New feeds are due immediately; the automation tick queues one feed_refresh job per enabled feed.
    await drain();
    for (const name of ['rss', 'atom', 'json']) {
      const jobs = await refreshJobs(feeds[name].id);
      expect(jobs, name).toHaveLength(1);
      expect(jobs[0].status, `${name}: ${jobs[0].error}`).toBe('succeeded');
      expect(jobs[0].idempotencyKey).toMatch(new RegExp(`^feed:${feeds[name].id}:1:`));
      const feed = await feedRow(feeds[name].id);
      expect(feed.error).toBe('');
      expect(feed.lastFetchedAt).toBeTruthy();
      expect(Date.parse(feed.nextAt)).toBeGreaterThan(Date.now() + (feed.intervalMinutes - 5) * 60000);
    }
    expect(await refreshJobs(feeds.disabled.id)).toHaveLength(0);
    expect(site.hits).not.toContain('/disabled.xml');
    expect((await feedRow(feeds.disabled.id)).lastFetchedAt).toBeNull();

    const [rssJob] = await refreshJobs(feeds.rss.id);
    // Two items pass the filters, the recipe misses the include words, the advert hits the exclude word; the item without a link is not stored.
    expect(rssJob.result).toMatchObject({ added: 2, updated: 0, filtered: 2, scanned: 4 });
    const rssEntries = (await entries(feeds.rss.id)).items;
    expect(rssEntries).toHaveLength(2);
    const hot = rssEntries.find(
      (entry) => entry.url === 'https://news.example.com/posts/101?utm_source=rss&id=7',
    )!;
    expect(hot).toMatchObject({
      title: 'AI 写作 & 选题周报',
      body: '本周 AI 选题 观察：R&D 投入继续增加',
      publishedAt: '2026-10-16T00:00:00.000Z',
      feedName: '行业热点 RSS',
      sourceKind: 'rss',
    });
    expect(Date.parse(hot.fetchedAt)).toBeGreaterThan(Date.now() - 120000);
    const relative = rssEntries.find((entry) => entry.url === `${site.origin()}/posts/104`)!;
    expect(relative).toMatchObject({
      title: '视频脚本 & AI 工具清单',
      body: '脚本 选题 与 AI & 剪辑',
      publishedAt: null,
    });
    expect(rssEntries.some((entry) => entry.url === feeds.rss.url)).toBe(false);

    const atomEntries = (await entries(feeds.atom.id)).items;
    expect(
      atomEntries.map((entry) => [entry.title, entry.url, entry.body, entry.publishedAt]).sort(),
    ).toEqual([
      ['1024', 'https://blog.example.com/entries/1024', '程序员节的选题', '2026-10-13T00:00:00.000Z'],
      [
        'Atom 写作复盘',
        'https://blog.example.com/entries/1?a=1&b=2',
        '复盘 要点',
        '2026-10-14T01:30:00.000Z',
      ],
    ]);
    const jsonEntries = (await entries(feeds.json.id)).items;
    expect(
      jsonEntries.map((entry) => [entry.title, entry.url, entry.body, entry.publishedAt]).sort(),
    ).toEqual([
      ['JSON 选题灵感', 'https://ideas.example.com/items/1', '灵感 清单 & 素材', '2026-10-12T02:00:00.000Z'],
      ['外部链接条目', 'https://ideas.example.com/external/2', '纯文本正文', null],
    ]);
    // Entries of an account-bound feed stay out of another account's view; shared feeds stay visible.
    const forB = (await request('GET', `/api/feed-entries?accountId=${accountB.id}&limit=500`)).json<{
      items: FeedEntry[];
    }>().items;
    expect(forB.map((entry) => entry.feedId).sort()).toEqual(
      [feeds.atom.id, feeds.atom.id, feeds.json.id, feeds.json.id].sort(),
    );

    // Nothing is due any more: another tick does not fetch again.
    const fetched = site.hits.length;
    await drain();
    expect(site.hits.length).toBe(fetched);
    expect(await refreshJobs(feeds.rss.id)).toHaveLength(1);
  });

  it('手动刷新需要请求编号且可重放；重复抓取不重复入库，只更新有变化的条目', async () => {
    const before = (await entries(feeds.rss.id)).items;
    const hotBefore = before.find((entry) => entry.url.includes('/posts/101'))!;
    const scriptBefore = before.find((entry) => entry.url.endsWith('/posts/104'))!;
    const refreshUrl = `/api/feeds/${feeds.rss.id}/refresh`;
    expect((await request('POST', refreshUrl, {})).statusCode).toBe(400);
    state.rssVersion = 2;
    const key = id();
    const first = await request('POST', refreshUrl, {}, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(202);
    expect((await request('POST', refreshUrl, {}, { 'idempotency-key': key })).json().id).toBe(
      first.json().id,
    );
    const done = await settle(first.json().id, 'succeeded');
    expect(done.result).toMatchObject({ added: 1, updated: 1, unchanged: 1, filtered: 2, scanned: 5 });
    const after = (await entries(feeds.rss.id)).items;
    expect(after).toHaveLength(3);
    const hot = after.find(
      (entry) => entry.url === 'https://news.example.com/posts/101?utm_source=rss&id=7',
    )!;
    expect(hot).toMatchObject({
      id: hotBefore.id,
      title: 'AI 写作 & 选题周报（更新）',
      body: '更新后的 AI 选题观察',
      publishedAt: '2026-10-17T01:00:00.000Z',
    });
    expect(Date.parse(hot.fetchedAt)).toBeGreaterThan(Date.parse(hotBefore.fetchedAt));
    const script = after.find((entry) => entry.url.endsWith('/posts/104'))!;
    expect(script).toMatchObject({
      id: scriptBefore.id,
      title: scriptBefore.title,
      fetchedAt: scriptBefore.fetchedAt,
    });
    expect(after.find((entry) => entry.url === 'https://news.example.com/posts/105')).toMatchObject({
      title: '新的 AI 选题日历',
      publishedAt: '2026-10-17T02:00:00.000Z',
    });

    const again = await settle(
      (await request('POST', refreshUrl, {}, { 'idempotency-key': id() })).json().id,
      'succeeded',
    );
    expect(again.result).toMatchObject({ added: 0, updated: 0, unchanged: 3, filtered: 2 });
    expect((await entries(feeds.rss.id)).total).toBe(3);

    // A disabled feed is not fetched even when refreshed by hand.
    const skipped = await settle(
      (
        await request('POST', `/api/feeds/${feeds.disabled.id}/refresh`, {}, { 'idempotency-key': id() })
      ).json().id,
      'succeeded',
    );
    expect(skipped.result).toMatchObject({ skipped: true, reason: '来源已停用' });
    expect(site.hits).not.toContain('/disabled.xml');
  });

  it('来源失败（HTTP 500、XML 损坏、内容超限、内网地址）只记录在该来源上，其他来源照常更新，历史条目仍可查看', async () => {
    const failing: Record<string, [string, string]> = {
      broken: [`${site.origin()}/broken.xml`, '来源返回 HTTP 500'],
      malformed: [`${site.origin()}/malformed.xml`, '来源不是有效 RSS / Atom 文档'],
      huge: [`${site.origin()}/huge.xml`, '来源内容超过导入限制'],
      private: [`${vectors.origin()}/internal.xml`, '该来源不是可抓取的公网地址'],
    };
    for (const [name, [url]] of Object.entries(failing))
      feeds[name] = await create({ name: `失败来源 ${name}`, kind: 'rss', url });
    // The healthy JSON feed comes due in the same round.
    await db.rows(`UPDATE feeds SET "nextAt"=now()-interval '1 minute' WHERE id=$1`, [feeds.json.id]);
    await drain();
    for (const [name, [, message]] of Object.entries(failing)) {
      const feed = await feedRow(feeds[name].id);
      expect(feed.error, name).toContain(message);
      expect(feed.lastFetchedAt, name).toBeTruthy();
      expect(Date.parse(feed.nextAt), name).toBeGreaterThan(Date.now() + 10 * 60000);
      const [job] = await refreshJobs(feeds[name].id);
      expect(job.status, name).toBe('failed');
      expect(job.error, name).toContain(message);
      expect((await entries(feeds[name].id)).total, name).toBe(0);
    }
    expect(privateHits()).toHaveLength(0);
    const jsonJobs = await refreshJobs(feeds.json.id);
    expect(jsonJobs).toHaveLength(2);
    expect(jsonJobs.map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
    expect((await feedRow(feeds.json.id)).error).toBe('');

    // A feed that worked before keeps its history while it fails, and recovers on the next refresh.
    state.atomFails = true;
    const failed = await settle(
      (await request('POST', `/api/feeds/${feeds.atom.id}/refresh`, {}, { 'idempotency-key': id() })).json()
        .id,
      'failed',
    );
    expect(failed.error).toBe('来源返回 HTTP 500');
    expect((await feedRow(feeds.atom.id)).error).toBe('来源返回 HTTP 500');
    expect((await entries(feeds.atom.id)).total).toBe(2);
    state.atomFails = false;
    await settle(
      (await request('POST', `/api/feeds/${feeds.atom.id}/refresh`, {}, { 'idempotency-key': id() })).json()
        .id,
      'succeeded',
    );
    expect((await feedRow(feeds.atom.id)).error).toBe('');
    expect((await entries(feeds.atom.id)).total).toBe(2);
  });

  it('修改关键词与启停立即生效，旧版本修改被拒绝；不同来源独立启停', async () => {
    const rssFeed = await feedRow(feeds.rss.id);
    expect(
      (
        await request('PUT', `/api/feeds/${rssFeed.id}`, {
          ...feedInput(rssFeed),
          exclude: ['广告', '日历'],
          expectedRevision: rssFeed.revision + 1,
        })
      ).statusCode,
    ).toBe(409);
    const updated = await request('PUT', `/api/feeds/${rssFeed.id}`, {
      ...feedInput(rssFeed),
      exclude: ['广告', '日历'],
      expectedRevision: rssFeed.revision,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 2, exclude: ['广告', '日历'] });
    const disabled = await feedRow(feeds.disabled.id);
    expect(
      (
        await request('PUT', `/api/feeds/${disabled.id}`, {
          ...feedInput(disabled),
          enabled: true,
          expectedRevision: disabled.revision,
        })
      ).statusCode,
    ).toBe(200);
    const json = await feedRow(feeds.json.id);
    expect(
      (
        await request('PUT', `/api/feeds/${json.id}`, {
          ...feedInput(json),
          enabled: false,
          expectedRevision: json.revision,
        })
      ).statusCode,
    ).toBe(200);
    const jsonHits = site.hits.filter((hit) => hit === '/feed.json').length;

    await drain();
    const rssJobs = await refreshJobs(feeds.rss.id);
    const latest = rssJobs[rssJobs.length - 1];
    expect(latest.idempotencyKey).toMatch(new RegExp(`^feed:${feeds.rss.id}:2:`));
    // The calendar item is now excluded; previously stored entries stay in history.
    expect(latest.result).toMatchObject({ added: 0, updated: 0, unchanged: 2, filtered: 3 });
    expect((await entries(feeds.rss.id)).total).toBe(3);
    const [enabledJob] = await refreshJobs(feeds.disabled.id).then((jobs) =>
      jobs.filter((job) => job.idempotencyKey.startsWith('feed:')),
    );
    expect(enabledJob.status).toBe('succeeded');
    expect(enabledJob.result).toMatchObject({ added: 4, filtered: 0, scanned: 4 });
    expect(site.hits).toContain('/disabled.xml');
    expect(site.hits.filter((hit) => hit === '/feed.json').length).toBe(jsonHits);
    expect((await entries(feeds.json.id)).total).toBe(2);
  });
});

describe('网页正文提取与批量导入（MAT-05，模拟网页）', () => {
  const allMaterials = async () =>
    (await request('GET', '/api/materials?limit=500')).json<{ items: Material[]; total: number }>();
  let coffeeId: string;
  let coffeeBody: string;
  let missingUrl: string;

  it('网页用 Readability 提取标题、正文与来源；逐项报告新建、复用与失败；内网与环回地址被拒绝', async () => {
    const coffee = `${site.origin()}/articles/coffee.html`;
    missingUrl = `${site.origin()}/articles/missing.html`;
    const blocked = [
      `${site.origin()}/articles/redirect-private`,
      `${vectors.origin()}/secret`,
      site.origin().replace('127.0.0.1', 'localhost') + '/articles/coffee.html',
      'http://10.0.0.8/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:9/secret',
    ];
    const urls = [
      coffee,
      `${coffee}#comments`,
      `${site.origin()}/articles/short.html`,
      missingUrl,
      ...blocked,
      'file:///etc/passwd',
      'not a url',
    ];
    const articles = [
      {
        title: '旧文：城市骑行路线',
        body: '记录一次城市骑行路线，从江边出发经过老城区，沿途有很多值得拍照的地方。',
        url: 'https://old.example.com/posts/ride',
        author: '旧作者',
        sourceDate: '2025-05-01',
        tags: ['历史文章'],
      },
      { title: '旧文：读书笔记', body: '这是一篇没有来源链接的读书笔记，正文用于按内容去重。' },
      { title: '', body: '缺少标题的条目' },
      { title: '同一正文换个标题', body: '这是一篇没有来源链接的读书笔记，正文用于按内容去重。' },
    ];
    const payload = { kind: 'import', accountId: accountA.id, data: { urls, articles } };
    expect(
      (
        await request(
          'POST',
          '/api/automation',
          { kind: 'import', accountId: accountA.id, data: {} },
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(400);
    const key = id();
    const job = await startJob(payload, key);
    expect((await startJob(payload, key)).id).toBe(job.id);
    expect(
      (
        await request(
          'POST',
          '/api/automation',
          { ...payload, data: { urls: [coffee] } },
          { 'idempotency-key': key },
        )
      ).statusCode,
    ).toBe(409);
    const done = await settle(job.id, 'succeeded');
    const results = (
      done.result.results as {
        index: number;
        status: string;
        error?: string;
        materialId?: string;
        title?: string;
      }[]
    ).sort((a, b) => a.index - b.index);
    expect(results).toHaveLength(urls.length + articles.length);
    expect(done.result).toMatchObject({ created: 3, reused: 2, failed: 11 });
    const at = (index: number) => results.find((result) => result.index === index)!;
    expect(at(0)).toMatchObject({ status: 'created', title: '手冲咖啡的萃取笔记' });
    coffeeId = at(0).materialId!;
    [{ body: coffeeBody }] = await db.rows<{ body: string }>('SELECT body FROM materials WHERE id=$1', [
      coffeeId,
    ]);
    expect(at(1)).toMatchObject({ status: 'reused', materialId: coffeeId });
    expect(at(2)).toMatchObject({ status: 'failed', error: '没有提取到足够的文章正文，可在素材库手工补录' });
    expect(at(3)).toMatchObject({ status: 'failed', error: '来源返回 HTTP 404' });
    for (let index = 4; index < 4 + blocked.length; index++)
      expect(at(index).status, urls[index]).toBe('failed');
    for (let index = 4; index < 4 + blocked.length; index++)
      expect(at(index).error, urls[index]).toContain('该来源不是可抓取的公网地址');
    expect(at(4 + blocked.length)).toMatchObject({
      status: 'failed',
      error: '来源只支持无内嵌凭据的 HTTP(S) 地址',
    });
    expect(at(5 + blocked.length).status).toBe('failed');
    const first = urls.length;
    expect(at(first)).toMatchObject({ status: 'created', title: '旧文：城市骑行路线' });
    expect(at(first + 1)).toMatchObject({ status: 'created', title: '旧文：读书笔记' });
    expect(at(first + 2)).toMatchObject({
      status: 'failed',
      error: '内容格式或读取失败，请检查标题、正文和来源地址',
    });
    expect(at(first + 3)).toMatchObject({
      status: 'reused',
      materialId: at(first + 1).materialId,
      title: '旧文：读书笔记',
    });
    // Nothing reached the private service, including through the public redirect.
    expect(privateHits()).toHaveLength(0);

    const { items } = await allMaterials();
    const material = items.find((item) => item.id === coffeeId)!;
    expect(material).toMatchObject({
      title: '手冲咖啡的萃取笔记',
      url: coffee,
      author: '林小咖',
      accountId: accountA.id,
      kind: 'text',
    });
    expect(material.body).toContain('粉水比一比十五，水温九十二度');
    expect(material.body).toContain('后者更干净清爽');
    expect(material.body).not.toContain('网站导航');
    expect(material.body).not.toContain('版权所有');
    expect(items.find((item) => item.id === at(first).materialId)).toMatchObject({
      url: 'https://old.example.com/posts/ride',
      author: '旧作者',
      sourceDate: '2025-05-01',
      tags: ['历史文章'],
      accountId: accountA.id,
    });
    expect(items.filter((item) => item.url === coffee)).toHaveLength(1);
  });

  it('失败项可手工补录；再次导入同一网页、同一链接或相同正文复用已有素材，不会多出副本', async () => {
    const manual = await request('POST', '/api/materials', {
      title: '补录的页面',
      body: '手工补录的正文内容。',
      url: missingUrl,
      accountId: accountA.id,
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const before = (await allMaterials()).total;
    const job = await startJob({
      kind: 'import',
      accountId: accountA.id,
      data: {
        urls: [`${site.origin()}/articles/coffee.html`],
        articles: [
          { title: '补录页面的再次导入', body: '另一份正文', url: `${missingUrl}#section` },
          {
            title: '旧文：城市骑行路线（重复）',
            body: '内容不同但链接相同',
            url: 'https://old.example.com/posts/ride',
          },
          { title: '读书笔记再导入', body: '这是一篇没有来源链接的读书笔记，正文用于按内容去重。' },
          // The same text under a new address is still the same material.
          { title: '咖啡文章的转载', body: coffeeBody, url: 'https://mirror.example.com/coffee' },
        ],
      },
    });
    const done = await settle(job.id, 'succeeded');
    expect(done.result).toMatchObject({ created: 0, reused: 5, failed: 0 });
    expect(
      (done.result.results as { index: number; materialId: string }[]).find((row) => row.index === 4)
        ?.materialId,
    ).toBe(coffeeId);
    const results = (done.result.results as { index: number; materialId: string }[]).sort(
      (a, b) => a.index - b.index,
    );
    expect(results[0].materialId).toBe(coffeeId);
    expect(results[1].materialId).toBe(manual.json().id);
    expect((await allMaterials()).total).toBe(before);
  });
});

describe('语义检索与写作资料召回（MAT-06，模拟向量服务）', () => {
  type Hit = {
    materialId: string;
    title: string;
    url: string;
    body: string;
    revision: number;
    score?: number;
  };
  type Search = { mode: 'semantic' | 'keyword'; model?: string; reason?: string; items: Hit[] };
  const search = async (q: string, query = '', headers: Record<string, string> = {}) => {
    const response = await request(
      'GET',
      `/api/materials/search?q=${encodeURIComponent(q)}${query}`,
      undefined,
      headers,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Search>();
  };
  const material = async (payload: Record<string, unknown>) => {
    const response = await request('POST', '/api/materials', payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Material>();
  };
  const m: Record<string, Material> = {};
  let fingerprint = '';

  it('未配置向量服务时检索回退为关键词并说明原因，重建任务明确失败', async () => {
    m.shared = await material({
      title: '咖啡入门笔记',
      body: '咖啡豆的烘焙程度决定风味，浓缩咖啡需要更细的研磨，手冲则强调注水节奏。',
    });
    m.tea = await material({
      title: '乌龙茶笔记',
      body: '乌龙茶的焙火与普洱的陈化各有特点，冲泡时注意水温。',
    });
    m.mixed = await material({ title: '下午茶搭配', body: '下午茶可以准备一杯咖啡，也可以选择乌龙茶。' });
    m.coffeeA = await material({
      title: '账号 A 的咖啡选题',
      body: '账号 A 的咖啡选题，聊聊浓缩和手冲的区别。',
      accountId: accountA.id,
    });
    m.coffeeB = await material({
      title: '账号 B 的私有咖啡配方',
      body: '账号 B 的咖啡配方，只给 B 账号使用。',
      accountId: accountB.id,
    });
    m.long = await material({ title: '长文写作资料', body: `咖啡与写作的关系：${'写'.repeat(1500)}` });
    m.archived = await material({
      title: '已归档的咖啡资料',
      body: '咖啡归档内容，不应被检索。',
      archived: true,
    });

    const result = await search('咖啡');
    expect(result.mode).toBe('keyword');
    expect(result.reason).toMatch(/^请先在设置中配置.*(embedding|向量检索).*服务$/);
    const ids = result.items.map((item) => item.materialId);
    expect(ids).toEqual(expect.arrayContaining([m.shared.id, m.coffeeA.id, m.coffeeB.id, m.mixed.id]));
    expect(ids).not.toContain(m.archived.id);
    expect(ids).not.toContain(m.tea.id);
    const failed = await settle((await startJob({ kind: 'embedding_rebuild', data: {} })).id, 'failed');
    expect(failed.error).toBe(result.reason);
    expect(embedCalls).toHaveLength(0);
  });

  it('配置向量服务并重建索引后，按相似度召回片段并给出素材出处与版本；按账号与授权范围过滤', async () => {
    const providerUrl = `${vectors.origin()}/v1`;
    expect(
      (
        await request('PUT', '/api/settings/providers/embedding', {
          name: '本地向量',
          baseUrl: providerUrl,
          model: 'mock-embed-v1',
          expectedRevision: 0,
        })
      ).json().code,
    ).toBe('KEY_REQUIRED');
    expect(
      (
        await request('PUT', '/api/settings/providers/embedding', {
          name: '本地向量',
          baseUrl: `${providerUrl}?x=1`,
          model: 'mock-embed-v1',
          apiKey: 'k',
          expectedRevision: 0,
        })
      ).statusCode,
    ).toBe(400);
    const saved = await request('PUT', '/api/settings/providers/embedding', {
      name: '本地向量',
      baseUrl: providerUrl,
      model: 'mock-embed-v1',
      apiKey: 'embed-secret-key',
      expectedRevision: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      capability: 'embedding',
      model: 'mock-embed-v1',
      baseUrl: providerUrl,
      hasKey: true,
      revision: 1,
    });
    expect(saved.body).not.toContain('embed-secret-key');
    const tested = await request('POST', '/api/settings/providers/embedding/test', {});
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true, verified: true, dimensions: 4 });

    const noIndex = await search('拿铁');
    expect(noIndex).toMatchObject({
      mode: 'keyword',
      reason: '当前模型还没有可用索引，请重建语义索引',
      items: [],
    });

    const calls = embedCalls.length;
    const job = await startJob({ kind: 'embedding_rebuild', data: {} });
    const done = await settle(job.id, 'succeeded');
    expect(done.result).toMatchObject({ model: 'mock-embed-v1', skipped: [], message: '语义索引已就绪' });
    fingerprint = done.result.modelFingerprint as string;
    const completed = done.result.completed as { id: string; revision: number; chunks: number }[];
    expect(completed.find((item) => item.id === m.long.id)).toEqual({
      id: m.long.id,
      revision: 1,
      chunks: 3,
    });
    expect(completed.find((item) => item.id === m.shared.id)).toEqual({
      id: m.shared.id,
      revision: 1,
      chunks: 1,
    });
    expect(completed.some((item) => item.id === m.archived.id)).toBe(false);
    const rebuildCalls = embedCalls.slice(calls);
    expect(rebuildCalls.length).toBe(completed.length);
    expect(
      rebuildCalls.every(
        (call) => call.model === 'mock-embed-v1' && call.authorization === 'Bearer embed-secret-key',
      ),
    ).toBe(true);

    // "拿铁" appears in no material: keyword search finds nothing, semantic search finds the coffee notes.
    const result = await search('拿铁');
    expect(result.mode).toBe('semantic');
    expect(result.model).toBe('mock-embed-v1');
    const scores = result.items.map((item) => item.score!);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(0.99);
    const coffee = [m.shared.id, m.coffeeA.id, m.coffeeB.id, m.long.id];
    const rank = (materialId: string) => result.items.findIndex((item) => item.materialId === materialId);
    for (const materialId of coffee) expect(rank(materialId)).toBeGreaterThanOrEqual(0);
    for (const materialId of coffee) expect(rank(materialId)).toBeLessThan(rank(m.mixed.id));
    expect(rank(m.mixed.id)).toBeLessThan(rank(m.tea.id));
    expect(rank(m.tea.id)).toBe(result.items.length - 1);
    expect(rank(m.archived.id)).toBe(-1);
    expect(result.items.find((item) => item.materialId === m.shared.id)).toMatchObject({
      title: '咖啡入门笔记',
      url: '',
      body: m.shared.body,
      revision: 1,
    });
    const longChunks = result.items.filter((item) => item.materialId === m.long.id);
    expect(longChunks).toHaveLength(3);
    expect(longChunks[0].body.startsWith('咖啡与写作的关系')).toBe(true);
    expect(longChunks[0].score!).toBeGreaterThan(0.99);
    expect(longChunks.slice(1).every((chunk) => chunk.score! < 0.2 && chunk.body.length <= 800)).toBe(true);

    const forA = (await search('拿铁', `&accountId=${accountA.id}`)).items.map((item) => item.materialId);
    expect(forA).toEqual(expect.arrayContaining([m.shared.id, m.coffeeA.id]));
    expect(forA).not.toContain(m.coffeeB.id);
    const forB = (await search('拿铁', `&accountId=${accountB.id}`)).items.map((item) => item.materialId);
    expect(forB).toEqual(expect.arrayContaining([m.shared.id, m.coffeeB.id]));
    expect(forB).not.toContain(m.coffeeA.id);

    // A member authorized for account A never sees account B's chunks.
    const member = await request('POST', '/api/members', {
      username: 'scoped-writer',
      password: 'Scoped-Writer-2026',
      name: '限定编辑',
      role: 'editor',
      accountIds: [accountA.id],
    });
    expect(member.statusCode, member.body).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-creator-client': 'web' },
      payload: { username: 'scoped-writer', password: 'Scoped-Writer-2026' },
    });
    expect(login.statusCode).toBe(200);
    const memberCookie = { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; ') };
    const scoped = await search('拿铁', '', memberCookie);
    expect(scoped.mode).toBe('semantic');
    expect(scoped.items.map((item) => item.materialId)).toEqual(
      expect.arrayContaining([m.shared.id, m.coffeeA.id]),
    );
    expect(scoped.items.some((item) => item.materialId === m.coffeeB.id)).toBe(false);
    expect(
      (await request('GET', `/api/materials/search?q=x&accountId=${accountB.id}`, undefined, memberCookie))
        .statusCode,
    ).toBe(404);
  });

  it('向量服务失败时回退关键词并说明原因；素材修改后旧片段不再召回，重建只补新版本；更换模型需要可追踪的重建', async () => {
    state.embedStatus = 503;
    const down = await search('咖啡', `&accountId=${accountA.id}`);
    expect(down.mode).toBe('keyword');
    expect(down.reason).toMatch(/^服务返回 HTTP 503/);
    expect(down.items.map((item) => item.materialId)).toEqual(
      expect.arrayContaining([m.shared.id, m.coffeeA.id]),
    );
    expect(down.items.some((item) => [m.coffeeB.id, m.archived.id].includes(item.materialId))).toBe(false);
    expect((await search('拿铁')).items).toEqual([]);
    state.embedStatus = 401;
    expect((await search('咖啡')).reason).toBe('服务拒绝访问，请核对 API Key 和模型权限');
    state.embedStatus = 0;

    const edited = await request('PUT', `/api/materials/${m.shared.id}`, {
      title: '茶饮入门笔记',
      body: '普洱茶的冲泡要点与乌龙的区别。',
      expectedRevision: 1,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().revision).toBe(2);
    const stale = await search('拿铁');
    expect(stale.mode).toBe('semantic');
    expect(stale.items.some((item) => item.materialId === m.shared.id)).toBe(false);
    expect((await search('普洱')).items.some((item) => item.materialId === m.shared.id)).toBe(false);

    const calls = embedCalls.length;
    const refreshed = await settle((await startJob({ kind: 'embedding_rebuild', data: {} })).id, 'succeeded');
    expect(refreshed.result.modelFingerprint).toBe(fingerprint);
    expect(embedCalls.slice(calls).map((call) => call.input)).toEqual([['普洱茶的冲泡要点与乌龙的区别。']]);
    const tea = await search('普洱');
    expect(tea.items.find((item) => item.materialId === m.shared.id)).toMatchObject({
      title: '茶饮入门笔记',
      revision: 2,
      body: '普洱茶的冲泡要点与乌龙的区别。',
    });

    const changed = await request('PUT', '/api/settings/providers/embedding', {
      name: '本地向量',
      baseUrl: `${vectors.origin()}/v1`,
      model: 'mock-embed-v2',
      expectedRevision: 1,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await search('拿铁')).toMatchObject({
      mode: 'keyword',
      reason: '当前模型还没有可用索引，请重建语义索引',
    });
    const before = embedCalls.length;
    const rebuilt = await settle((await startJob({ kind: 'embedding_rebuild', data: {} })).id, 'succeeded');
    expect(rebuilt.result.model).toBe('mock-embed-v2');
    expect(rebuilt.result.modelFingerprint).not.toBe(fingerprint);
    expect(embedCalls.length).toBeGreaterThan(before);
    expect(embedCalls.slice(before).every((call) => call.model === 'mock-embed-v2')).toBe(true);
    expect(await search('拿铁')).toMatchObject({ mode: 'semantic', model: 'mock-embed-v2' });
    const history = (await request('GET', '/api/automation?kind=embedding_rebuild&limit=100')).json<{
      items: AutomationJob[];
    }>().items;
    expect(history.map((job) => job.status).sort()).toEqual([
      'failed',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  });

  it('建索引期间素材被修改时跳过该素材并提示重新发起，旧版本片段不会被当作新内容召回', async () => {
    const job = await startJob({ kind: 'embedding_rebuild', data: { materialIds: [m.tea.id, m.mixed.id] } });
    expect(
      (
        await request('PUT', `/api/materials/${m.tea.id}`, {
          title: '乌龙茶笔记',
          body: '这篇改成了编程函数的说明。',
          expectedRevision: 1,
        })
      ).statusCode,
    ).toBe(200);
    const done = await settle(job.id, 'succeeded');
    expect(done.result).toMatchObject({
      skipped: [m.tea.id],
      message: '部分素材在建索引期间改变，请再发起重建',
    });
    expect((await search('普洱')).items.some((item) => item.materialId === m.tea.id)).toBe(false);
  });
});

describe('手工指标与 CSV（DAT-01）及数据看板（DAT-03）', () => {
  const publishedAt = '2026-09-01T08:00:00+08:00';
  async function plan(account: Account, title: string, extra: Record<string, unknown> = {}) {
    const doc = await request('POST', '/api/documents', {
      title,
      body: `${title} 的正文。`,
      accountId: account.id,
      ...extra,
    });
    expect(doc.statusCode, doc.body).toBe(201);
    const document = doc.json<ContentDocument>();
    const created = await request(
      'POST',
      '/api/publishing',
      { documentId: document.id, expectedRevision: document.revision },
      { 'idempotency-key': id() },
    );
    expect(created.statusCode, created.body).toBe(201);
    return created.json<PublishTask>();
  }
  async function published(
    account: Account,
    title: string,
    url: string,
    extra: Record<string, unknown> = {},
  ) {
    const task = await plan(account, title, extra);
    const recorded = await request('POST', `/api/publishing/${task.id}/record`, { url, publishedAt });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json().status).toBe('published');
    return recorded.json<PublishTask>();
  }
  const metric = (payload: Record<string, unknown>) => request('POST', '/api/metrics', payload);
  type Recorded = { status: string; snapshot: MetricSnapshot };
  const unknown = {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    favorites: null,
    followers: null,
    completionRate: null,
  };
  let p1: PublishTask;
  let p2: PublishTask;
  let unpublished: PublishTask;

  it('手工录入：空值保持未知而不是 0；累计与增量口径分开；增量区间不能重叠；未发布的内容不能录入', async () => {
    p1 = await published(accountA, '指标文章一', 'https://zhuanlan.zhihu.com/p/1001');
    p2 = await published(accountA, '指标文章二', 'https://zhuanlan.zhihu.com/p/1002');
    unpublished = await plan(accountA, '尚未发布的文章');
    expect(unpublished.status).toBe('waiting_user');

    const created = await metric({
      publishTaskId: p1.id,
      capturedAt: '2026-10-10T12:00:00+08:00',
      basis: 'cumulative',
      values: { views: 100, likes: null, comments: 0 },
    });
    expect(created.statusCode, created.body).toBe(200);
    const first = created.json<Recorded>();
    expect(first.status).toBe('created');
    expect(first.snapshot).toMatchObject({
      basis: 'cumulative',
      periodStart: null,
      source: 'manual',
      revision: 1,
      accountId: accountA.id,
      capturedAt: '2026-10-10T04:00:00.000Z',
    });
    expect(first.snapshot.values).toEqual({ ...unknown, views: 100, comments: 0 });
    expect(
      (
        await metric({
          publishTaskId: p1.id,
          capturedAt: '2026-10-10T04:00:00Z',
          basis: 'cumulative',
          values: { views: 100, comments: 0 },
        })
      ).json<Recorded>(),
    ).toMatchObject({ status: 'reused', snapshot: { id: first.snapshot.id, revision: 1 } });

    const identity = {
      publishTaskId: p1.id,
      capturedAt: '2026-10-10T12:00:00+08:00',
      basis: 'cumulative' as const,
    };
    const put = await request('PUT', `/api/metrics/${first.snapshot.id}`, {
      ...identity,
      values: { views: 120, likes: 8, comments: null },
      expectedRevision: 1,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json<Recorded>()).toMatchObject({
      status: 'updated',
      snapshot: { id: first.snapshot.id, revision: 2, values: { ...unknown, views: 120, likes: 8 } },
    });
    expect(
      (
        await request('PUT', `/api/metrics/${first.snapshot.id}`, {
          ...identity,
          values: { views: 130 },
          expectedRevision: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request('PUT', `/api/metrics/${first.snapshot.id}`, {
          ...identity,
          capturedAt: '2026-10-11T12:00:00+08:00',
          values: { views: 130 },
          expectedRevision: 2,
        })
      ).json().code,
    ).toBe('METRIC_IDENTITY');

    const period = (
      publishTaskId: string,
      periodStart: string,
      capturedAt: string,
      values: Record<string, number | null>,
    ) => metric({ publishTaskId, capturedAt, basis: 'period', periodStart, values });
    const day1 = await period(p1.id, '2026-10-01T00:00:00+08:00', '2026-10-02T00:00:00+08:00', {
      views: 10,
      likes: null,
    });
    expect(day1.statusCode, day1.body).toBe(200);
    expect(day1.json<Recorded>().snapshot).toMatchObject({
      basis: 'period',
      periodStart: '2026-09-30T16:00:00.000Z',
      values: { ...unknown, views: 10 },
    });
    expect(
      (
        await period(p1.id, '2026-10-02T00:00:00+08:00', '2026-10-03T00:00:00+08:00', { views: 12 })
      ).json<Recorded>().status,
    ).toBe('created');
    for (const [start, end] of [
      ['2026-10-01T12:00:00+08:00', '2026-10-02T12:00:00+08:00'],
      ['2026-09-30T00:00:00+08:00', '2026-10-04T00:00:00+08:00'],
      ['2026-10-02T06:00:00+08:00', '2026-10-02T18:00:00+08:00'],
    ]) {
      const overlap = await period(p1.id, start, end, { views: 1 });
      expect(overlap.statusCode, `${start}~${end}`).toBe(400);
      expect(overlap.json().code).toBe('METRIC_OVERLAP');
    }
    // The same period posted again is reused; a correction updates it in place.
    expect(
      (
        await period(p1.id, '2026-10-02T00:00:00+08:00', '2026-10-03T00:00:00+08:00', { views: 12 })
      ).json<Recorded>().status,
    ).toBe('reused');
    expect(
      (
        await period(p1.id, '2026-10-02T00:00:00+08:00', '2026-10-03T00:00:00+08:00', { views: 15 })
      ).json<Recorded>(),
    ).toMatchObject({ status: 'updated', snapshot: { revision: 2 } });
    // Overlap is checked per publication, and cumulative snapshots never conflict with periods.
    expect(
      (
        await period(p2.id, '2026-10-01T12:00:00+08:00', '2026-10-02T12:00:00+08:00', { views: 3 })
      ).json<Recorded>().status,
    ).toBe('created');
    expect(
      (
        await metric({
          publishTaskId: p1.id,
          capturedAt: '2026-10-02T00:00:00+08:00',
          basis: 'cumulative',
          values: { views: 40 },
        })
      ).json<Recorded>().status,
    ).toBe('created');
    for (const [periodStart, capturedAt] of [
      [null, '2026-10-06T00:00:00+08:00'],
      ['2026-10-07T00:00:00+08:00', '2026-10-06T00:00:00+08:00'],
    ])
      expect(
        (
          await metric({
            publishTaskId: p1.id,
            capturedAt,
            basis: 'period',
            periodStart,
            values: { views: 1 },
          })
        ).json().code,
      ).toBe('METRIC_PERIOD');

    const rejected = await metric({
      publishTaskId: unpublished.id,
      capturedAt: '2026-10-10T12:00:00+08:00',
      basis: 'cumulative',
      values: { views: 1 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('PUBLICATION_REQUIRED');
    expect(
      (
        await metric({
          publishTaskId: id(),
          capturedAt: '2026-10-10T12:00:00+08:00',
          basis: 'cumulative',
          values: { views: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await metric({
          publishTaskId: p1.id,
          capturedAt: new Date(Date.now() + 3600000).toISOString(),
          basis: 'cumulative',
          values: { views: 1 },
        })
      ).json().code,
    ).toBe('METRIC_TIME');
    expect(
      (
        await metric({
          publishTaskId: p1.id,
          capturedAt: '2026-10-11T12:00:00+08:00',
          basis: 'cumulative',
          values: { views: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await metric({
          publishTaskId: p1.id,
          capturedAt: '2026-10-11T12:00:00+08:00',
          basis: 'cumulative',
          values: { completionRate: 120 },
        })
      ).statusCode,
    ).toBe(400);
    const listed = (await request('GET', `/api/metrics?publishTaskId=${p1.id}`)).json<{
      items: (MetricSnapshot & { title: string; url: string })[];
      total: number;
    }>();
    expect(listed.total).toBe(4);
    expect(listed.items.find((item) => item.id === first.snapshot.id)).toMatchObject({
      title: '指标文章一',
      url: 'https://zhuanlan.zhihu.com/p/1001',
      values: { ...unknown, views: 120, likes: 8 },
    });
  });

  it('CSV 导入逐行报告，相同快照重复导入不重复累计；导出保留空值与口径，可原样导回', async () => {
    const header =
      'publishTaskId,url,capturedAt,basis,periodStart,views,likes,comments,shares,favorites,followers,completionRate';
    const csv = [
      header,
      `${p2.id},,2026-10-12T12:00:00+08:00,cumulative,,300,,0,,,,55.5`,
      ',https://zhuanlan.zhihu.com/p/1001,2026-10-12T12:00:00+08:00,cumulative,, 120 ,9,,,,,',
      `${unpublished.id},,2026-10-12T12:00:00+08:00,cumulative,,10,,,,,,`,
      ',https://zhuanlan.zhihu.com/p/404,2026-10-12T12:00:00+08:00,cumulative,,10,,,,,,',
      `${p2.id},,2026-10-13T12:00:00+08:00,cumulative,,abc,,,,,,`,
      `${p1.id},,2026-10-02T12:00:00+08:00,period,2026-10-01T12:00:00+08:00,5,,,,,,`,
      `${p1.id},,2026-10-05T12:00:00+08:00,period,2026-10-04T12:00:00+08:00,7,1,,,,,`,
      `${p2.id},,2026-10-12T12:00:00+08:00,cumulative,,300,,0,,,,55.5`,
    ].join('\r\n');
    const total = async () =>
      (await request('GET', '/api/metrics?limit=500')).json<{ total: number }>().total;
    const before = await total();
    const imported = await request('POST', '/api/metrics/import', { csv });
    expect(imported.statusCode, imported.body).toBe(200);
    const results = imported.json<{
      results: { row: number; status: string; error?: string }[];
      limited: boolean;
    }>();
    expect(results.limited).toBe(false);
    expect(results.results.map(({ row, status, error }) => [row, status, error ?? ''])).toEqual([
      [2, 'created', ''],
      [3, 'created', ''],
      [4, 'failed', '请先记录实际发布结果，再录入表现指标'],
      [5, 'failed', '未找到对应发布记录，请先回填链接或填写 publishTaskId'],
      [6, 'failed', '字段格式错误，请检查数字、时间与口径'],
      [7, 'failed', '同一内容的增量统计区间不能重叠，避免重复累计'],
      [8, 'created', ''],
      [9, 'reused', ''],
    ]);
    expect(await total()).toBe(before + 3);
    const again = (await request('POST', '/api/metrics/import', { csv })).json<{
      results: { row: number; status: string }[];
    }>();
    expect(again.results.map((result) => result.status)).toEqual([
      'reused',
      'reused',
      'failed',
      'failed',
      'failed',
      'failed',
      'reused',
      'reused',
    ]);
    expect(await total()).toBe(before + 3);
    const viaUrl = (await request('GET', `/api/metrics?publishTaskId=${p1.id}`))
      .json<{ items: MetricSnapshot[] }>()
      .items.find((item) => item.capturedAt === '2026-10-12T04:00:00.000Z')!;
    expect(viaUrl).toMatchObject({
      source: 'csv',
      basis: 'cumulative',
      values: { ...unknown, views: 120, likes: 9 },
    });

    const exported = await request('GET', '/api/metrics/export');
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body.startsWith('\uFEFF')).toBe(true);
    const rows = csvRows(exported.body);
    expect(rows[0]).toEqual([
      'publishTaskId',
      'capturedAt',
      'basis',
      'periodStart',
      'views',
      'likes',
      'comments',
      'shares',
      'favorites',
      'followers',
      'completionRate',
    ]);
    expect(rows).toHaveLength(1 + (await total()));
    expect(rows).toContainEqual([
      p2.id,
      '2026-10-12T04:00:00.000Z',
      'cumulative',
      '',
      '300',
      '',
      '0',
      '',
      '',
      '',
      '55.5',
    ]);
    expect(rows).toContainEqual([
      p1.id,
      '2026-10-02T16:00:00.000Z',
      'period',
      '2026-10-01T16:00:00.000Z',
      '15',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    const roundTrip = (await request('POST', '/api/metrics/import', { csv: exported.body })).json<{
      results: { status: string }[];
    }>();
    expect(roundTrip.results).toHaveLength(rows.length - 1);
    expect(roundTrip.results.every((result) => result.status === 'reused')).toBe(true);
    expect(await total()).toBe(before + 3);
  });

  it('看板按账号、平台、栏目、时间筛选；累计只取每篇最后一次快照，增量单独加总；缺失值单独计数；无数据时为真实空态', async () => {
    const zhihu = (
      await request('POST', '/api/accounts', { name: '看板知乎号', platform: 'zhihu' })
    ).json<Account>();
    const toutiao = (
      await request('POST', '/api/accounts', { name: '看板头条号', platform: 'toutiao' })
    ).json<Account>();
    const idea = await request('POST', '/api/ideas', { title: '栏目选题', accountId: zhihu.id });
    expect(idea.statusCode, idea.body).toBe(201);
    const x1 = await published(zhihu, '看板文章 X1', 'https://zhuanlan.zhihu.com/p/2001');
    const x2 = await published(zhihu, '看板文章 X2', 'https://zhuanlan.zhihu.com/p/2002', {
      ideaId: idea.json().id,
    });
    const y1 = await published(toutiao, '看板文章 Y1', 'https://www.toutiao.com/article/3001/');
    const series = await request('POST', '/api/studio/items', {
      kind: 'series',
      name: '每周栏目',
      data: { entries: [{ ideaId: idea.json().id, date: '2026-09-01' }] },
    });
    expect(series.statusCode, series.body).toBe(201);
    const dictionary = (
      await request('POST', '/api/studio/items', { kind: 'dictionary', name: '审校词典', data: {} })
    ).json<StudioItem>();
    for (const payload of [
      {
        publishTaskId: x1.id,
        capturedAt: '2026-09-03T12:00:00+08:00',
        basis: 'cumulative',
        values: { views: 100, likes: 5, comments: 2 },
      },
      {
        publishTaskId: x1.id,
        capturedAt: '2026-09-05T12:00:00+08:00',
        basis: 'cumulative',
        values: { views: 150, likes: null, comments: 4, completionRate: 35 },
      },
      {
        publishTaskId: x1.id,
        capturedAt: '2026-09-04T12:00:00+08:00',
        basis: 'period',
        periodStart: '2026-09-03T12:00:00+08:00',
        values: { views: 20, likes: 2 },
      },
      {
        publishTaskId: x1.id,
        capturedAt: '2026-09-05T12:00:00+08:00',
        basis: 'period',
        periodStart: '2026-09-04T12:00:00+08:00',
        values: { views: 30, likes: null },
      },
      {
        publishTaskId: x2.id,
        capturedAt: '2026-09-04T12:00:00+08:00',
        basis: 'cumulative',
        values: { views: 50, likes: 4, comments: 1 },
      },
      {
        publishTaskId: y1.id,
        capturedAt: '2026-09-04T18:00:00+08:00',
        basis: 'cumulative',
        values: { views: 30, completionRate: 40 },
      },
    ]) {
      const response = await metric(payload);
      expect(response.statusCode, response.body).toBe(200);
    }
    type Summary = Record<
      string,
      { label: string; knownTotal: number | null; missing: number; samples: number }
    >;
    type Board = {
      latest: (MetricSnapshot & { title: string; platform: string; accountName: string })[];
      periods: MetricSnapshot[];
      cumulativeSummary: Summary;
      periodSummary: Summary;
      definitions: string;
      range: { rows: number; limited: boolean };
    };
    const board = async (filter: Record<string, string>) => {
      const response = await request('GET', `/api/analytics?${new URLSearchParams(filter).toString()}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<Board>();
    };
    const september = { from: '2026-09-01T00:00:00+08:00', to: '2026-10-01T00:00:00+08:00' };

    const all = await board(september);
    expect(all.range).toMatchObject({ rows: 6, limited: false });
    expect(all.latest.map((row) => row.publishTaskId).sort()).toEqual([x1.id, x2.id, y1.id].sort());
    expect(all.latest.find((row) => row.publishTaskId === x1.id)).toMatchObject({
      capturedAt: '2026-09-05T04:00:00.000Z',
      title: '看板文章 X1',
      platform: 'zhihu',
      accountName: '看板知乎号',
    });
    expect(all.cumulativeSummary.views).toEqual({
      label: '阅读/播放',
      knownTotal: 230,
      missing: 0,
      samples: 3,
    });
    expect(all.cumulativeSummary.likes).toMatchObject({ knownTotal: 4, missing: 2, samples: 3 });
    expect(all.cumulativeSummary.comments).toMatchObject({ knownTotal: 5, missing: 1, samples: 3 });
    expect(all.cumulativeSummary.shares).toMatchObject({ knownTotal: null, missing: 3, samples: 3 });
    expect(all.cumulativeSummary.completionRate).toMatchObject({ knownTotal: null, missing: 1, samples: 3 });
    expect(all.periods).toHaveLength(2);
    expect(all.periodSummary.views).toMatchObject({ knownTotal: 50, missing: 0, samples: 2 });
    expect(all.periodSummary.likes).toMatchObject({ knownTotal: 2, missing: 1, samples: 2 });
    expect(all.periodSummary.shares).toMatchObject({ knownTotal: null, missing: 2, samples: 2 });
    expect(all.definitions).toContain('累计值每篇只取筛选范围内最后一次快照');
    expect(all.definitions).toContain('增量值单列，不与累计相加');
    expect(all.definitions).toContain('空值代表缺失，不是零');
    expect(all.definitions).toContain('跨平台阅读/播放口径可能不同');

    expect((await board({ ...september, accountId: zhihu.id })).cumulativeSummary.views.knownTotal).toBe(200);
    const onlyToutiao = await board({ accountId: toutiao.id });
    expect(onlyToutiao.cumulativeSummary.views).toMatchObject({ knownTotal: 30, samples: 1 });
    expect(onlyToutiao.periodSummary.views).toEqual({
      label: '阅读/播放',
      knownTotal: null,
      missing: 0,
      samples: 0,
    });
    expect((await board({ ...september, platform: 'toutiao' })).cumulativeSummary.views.knownTotal).toBe(30);
    const zhihuBoard = await board({ ...september, platform: 'zhihu' });
    expect(zhihuBoard.cumulativeSummary.views.knownTotal).toBe(200);
    expect(zhihuBoard.periodSummary.views.knownTotal).toBe(50);
    // A narrower window changes which snapshot is "latest" for each publication.
    const early = await board({ from: september.from, to: '2026-09-05T00:00:00+08:00', accountId: zhihu.id });
    expect(early.cumulativeSummary.views.knownTotal).toBe(150);
    expect(early.periodSummary.views).toMatchObject({ knownTotal: 20, samples: 1 });
    const late = await board({ from: '2026-09-04T13:00:00+08:00', to: september.to, accountId: zhihu.id });
    expect(late.cumulativeSummary.views).toMatchObject({ knownTotal: 150, samples: 1 });
    expect(late.periodSummary.views).toMatchObject({ knownTotal: 30, samples: 1 });
    const seriesBoard = await board({ seriesId: series.json().id });
    expect(seriesBoard.latest.map((row) => row.publishTaskId)).toEqual([x2.id]);
    expect(seriesBoard.cumulativeSummary.views.knownTotal).toBe(50);
    expect((await request('GET', `/api/analytics?seriesId=${dictionary.id}`)).statusCode).toBe(400);

    const empty = await board({ platform: 'bilibili' });
    expect(empty).toMatchObject({ latest: [], periods: [], range: { rows: 0 } });
    expect(empty.cumulativeSummary.views).toEqual({
      label: '阅读/播放',
      knownTotal: null,
      missing: 0,
      samples: 0,
    });
    expect(empty.definitions).toContain('空值代表缺失');
  });
});
