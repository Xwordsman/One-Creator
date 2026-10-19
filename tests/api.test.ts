import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';
import type { FastifyInstance } from 'fastify';
import type { ContentDocument, Persona, Account, AIJob, Asset, Idea, Material } from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { migrate, openDatabase, type Database } from '@one-creator/server/database';
import { migrations } from '@one-creator/server/migrations';
import { id, insert } from '@one-creator/server/records';
import { hashPassword, tokenHash } from '@one-creator/server/crypto';
import { startWorker } from '@one-creator/server/jobs';
import { createBackup, restoreBackup } from '@one-creator/server/backup';
import { buildApp } from '../apps/api/src/app.js';

let app: FastifyInstance;
let db: Database;
let config: AppConfig;
let folder: string;
let cookie: string;
let workspaceId: string;
let otherCookie: string;
let otherWorkspace: string;
let mockServer: Server;
let mockUrl: string;
let modelStatus = 200;
const tempBase = path.resolve('.data/test-temp');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
async function uploadImage() {
  const boundary = 'creator-test-upload';
  return app.inject({
    method: 'POST',
    url: '/api/assets',
    headers: { ...clientHeader, cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const clientHeader = { 'x-creator-client': 'web' };
const request = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown> | undefined,
    headers: { ...clientHeader, cookie, ...headers },
  });
async function createPersona(name = '技术作者') {
  const result = await request('POST', '/api/personas', {
    name,
    tone: '严谨、平实',
    audience: '独立开发者',
    positioning: '技术实践',
    avoid: '绝对化表达',
  });
  expect(result.statusCode).toBe(201);
  return result.json<Persona>();
}
async function createAccount(name: string, platform = 'wechat', personaId: string | null = null) {
  const result = await request('POST', '/api/accounts', { name, platform, personaId });
  expect(result.statusCode).toBe(201);
  return result.json<Account>();
}
async function createDoc(accountId: string | null = null, extra: Record<string, unknown> = {}) {
  const result = await request('POST', '/api/documents', {
    title: '我的第一篇文章',
    body: '正文包含一个清晰观点。',
    accountId,
    ...extra,
  });
  expect(result.statusCode).toBe(201);
  return result.json<ContentDocument>();
}

beforeAll(async () => {
  await mkdir(tempBase, { recursive: true });
  folder = await mkdtemp(path.join(tempBase, 'one-creator-test-'));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'ab'.repeat(32),
    production: false,
    workerMode: 'inline',
    origin: 'http://localhost:5173',
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const bootstrap = await app.inject('/api/auth/bootstrap');
  expect(bootstrap.json().needsSetup).toBe(true);
  const setupResults = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: clientHeader,
        payload: { username: 'creator', password: 'Creator-Password-2026', name: '创作者' },
      }),
    ),
  );
  expect(setupResults.map((result) => result.statusCode).sort()).toEqual([201, 409]);
  const setup = setupResults.find((result) => result.statusCode === 201)!;
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  workspaceId = setup.json().workspaceId;
  otherWorkspace = id();
  await insert(db, 'workspaces', { id: otherWorkspace, name: '隔离空间' });
  await insert(db, 'users', {
    id: id(),
    workspaceId: otherWorkspace,
    username: 'other',
    name: '其他用户',
    passwordHash: await hashPassword('Other-Password-2026'),
  });
  const other = await request('POST', '/api/auth/login', {
    username: 'other',
    password: 'Other-Password-2026',
  });
  otherCookie = other.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  mockServer = createServer((req, response) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer test-provider-secret') {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(modelStatus, { 'Content-Type': 'application/json' });
      if (modelStatus !== 200) {
        response.end(JSON.stringify({ error: 'test-provider-secret must not appear in client errors' }));
        return;
      }
      const body = JSON.parse(raw);
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: body.max_tokens ? 'OK' : '## 生成结果\n\n一段经过编辑的测试正文。' } },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}/v1`;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (mockServer) await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('初始化与访问边界', () => {
  it('初始化只允许一次，并保护业务资源', async () => {
    expect((await app.inject('/api/accounts')).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/bootstrap')).json().user.workspaceId).toBe(workspaceId);
    expect(
      (
        await request('POST', '/api/auth/setup', {
          username: 'third',
          password: 'Third-Password-2026',
          name: '第三人',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('POST', '/api/auth/login', { username: 'creator', password: 'wrong-password' }))
        .statusCode,
    ).toBe(401);
  });
  it('拒绝跨来源写入，并使退出后的会话失效', async () => {
    expect(
      (
        await request(
          'POST',
          '/api/accounts',
          { name: '越权', platform: 'wechat' },
          { origin: 'https://elsewhere.example' },
        )
      ).statusCode,
    ).toBe(403);
    const login = await request('POST', '/api/auth/login', {
      username: 'creator',
      password: 'Creator-Password-2026',
    });
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    const temporary = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    expect((await request('POST', '/api/auth/logout', {}, { cookie: temporary })).statusCode).toBe(200);
    expect((await request('GET', '/api/accounts', undefined, { cookie: temporary })).statusCode).toBe(401);
  });
  it('过期会话被拒绝', async () => {
    const login = await request('POST', '/api/auth/login', {
      username: 'creator',
      password: 'Creator-Password-2026',
    });
    const session = login.cookies[0];
    await db.rows('UPDATE sessions SET "expiresAt"=now()-interval \'1 second\' WHERE hash=$1', [
      tokenHash(session.value),
    ]);
    expect(
      (await request('GET', '/api/documents', undefined, { cookie: `${session.name}=${session.value}` }))
        .statusCode,
    ).toBe(401);
  });
});

describe('部署配置', () => {
  it('缺少或错误的必要配置给出具体原因', async () => {
    await expect(loadConfig({ dataDir: folder, production: true })).rejects.toThrow('ENCRYPTION_KEY');
    await expect(
      loadConfig({ dataDir: folder, production: true, encryptionKey: 'ab'.repeat(32) }),
    ).rejects.toThrow('DATABASE_URL');
    await expect(loadConfig({ dataDir: folder, encryptionKey: 'short' })).rejects.toThrow('64 位十六进制');
    await expect(
      loadConfig({ dataDir: folder, encryptionKey: 'ab'.repeat(32), origin: 'http://localhost:5173/app' }),
    ).rejects.toThrow('APP_ORIGIN');
  });
});

describe('账号、风格与素材', () => {
  it('同平台多账号独立，人设可覆盖且保留旧版本', async () => {
    const persona = await createPersona();
    const first = await createAccount('科技观察', 'wechat', persona.id);
    const second = await createAccount('生活记录', 'wechat', persona.id);
    expect(first.id).not.toBe(second.id);
    const changed = await request('PUT', `/api/accounts/${first.id}`, {
      ...first,
      preferences: { tone: '轻松直接' },
    });
    expect(changed.statusCode).toBe(200);
    const context = (await request('GET', `/api/accounts/${first.id}/context`)).json();
    expect(context.preferences.tone).toBe('轻松直接');
    expect(context.preferenceSources.tone).toBe('账号专属设置');
    const doc = await createDoc(first.id);
    await request('PUT', `/api/personas/${persona.id}`, {
      ...persona,
      tone: '全新风格',
      expectedRevision: 1,
    });
    expect((await request('GET', `/api/documents/${doc.id}`)).json().context.persona.revision).toBe(1);
    const revisions = (await request('GET', `/api/personas/${persona.id}/revisions`)).json();
    expect(revisions).toHaveLength(2);
    expect(revisions[1].data.tone).toBe('严谨、平实');
  });
  it('拒绝跨工作空间对象及其他账号的私有素材引用', async () => {
    const first = await createAccount('资料账号 A');
    const second = await createAccount('资料账号 B');
    const privateMaterial = (
      await request('POST', '/api/materials', {
        title: '私有样文',
        body: 'A 的独有表达',
        accountId: first.id,
      })
    ).json();
    expect(
      (
        await request('POST', '/api/documents', {
          title: '错误引用',
          accountId: second.id,
          materialIds: [privateMaterial.id],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request('PUT', `/api/accounts/${first.id}`, first, { cookie: otherCookie })).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          '/api/documents',
          { title: '跨空间引用', accountId: first.id },
          { cookie: otherCookie },
        )
      ).statusCode,
    ).toBe(404);
    expect((await request('GET', '/api/accounts', undefined, { cookie: otherCookie })).json().total).toBe(0);
  });
  it('素材可检索，引用内容保留当时的来源版本', async () => {
    const material = (
      await request('POST', '/api/materials', {
        title: '测试资料来源',
        body: '初始资料内容',
        tags: ['复用资料'],
        url: 'https://example.com/source',
      })
    ).json();
    const doc = await createDoc(null, { materialIds: [material.id] });
    await request('PUT', `/api/materials/${material.id}`, {
      ...material,
      body: '修改后的资料',
      expectedRevision: 1,
    });
    expect((await request('GET', '/api/materials?q=' + encodeURIComponent('复用资料'))).json().total).toBe(1);
    const saved = (await request('GET', `/api/documents/${doc.id}`)).json();
    expect(saved.context.citations[0].body).toBe('初始资料内容');
    expect(saved.context.citations[0].revision).toBe(1);
  });
  it('平台、灵感状态和素材类型筛选同时作用于结果与数量', async () => {
    const a = await createAccount('筛选 A', 'xiaohongshu');
    await createAccount('筛选 B', 'wechat');
    const filtered = (
      await request('GET', '/api/accounts?platform=xiaohongshu&q=' + encodeURIComponent('筛选'))
    ).json();
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].id).toBe(a.id);
    const categorized = await createAccount('分类账号', 'toutiao');
    await request('PUT', `/api/accounts/${categorized.id}`, { ...categorized, category: '读书笔记' });
    const byCategory = (
      await request('GET', '/api/accounts?category=' + encodeURIComponent('读书笔记'))
    ).json();
    expect(byCategory.items.map((item: Account) => item.id)).toEqual([categorized.id]);
    expect(byCategory.total).toBe(1);
    expect((await request('GET', '/api/accounts/categories')).json()).toContain('读书笔记');
    await request('POST', '/api/ideas', { title: '筛选灵感 A', status: 'parked' });
    await request('POST', '/api/ideas', { title: '筛选灵感 B', status: 'inbox' });
    const ideas = (await request('GET', '/api/ideas?status=parked')).json();
    expect(ideas.items.every((item: { status: string }) => item.status === 'parked')).toBe(true);
    expect(ideas.total).toBe(1);
    await request('POST', '/api/materials', {
      title: '筛选链接',
      kind: 'link',
      url: 'https://example.com/link',
    });
    const materials = (await request('GET', '/api/materials?kind=link')).json();
    expect(materials.total).toBe(1);
    expect(materials.items[0].kind).toBe('link');
  });
  it('图片去重、鉴权读取和发布包中的附件顺序一致', async () => {
    const uploaded = await uploadImage();
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json<Asset>();
    expect(asset.duplicate).toBeUndefined();
    const repeated = await uploadImage();
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().id).toBe(asset.id);
    expect(repeated.json().duplicate).toBe(true);
    expect(
      (await request('GET', `/api/assets/${asset.id}`, undefined, { cookie: otherCookie })).statusCode,
    ).toBe(404);
    const binary = await request('GET', `/api/assets/${asset.id}`);
    expect(binary.rawPayload.equals(png)).toBe(true);
    const doc = await createDoc(null, { assetIds: [asset.id], coverAssetId: asset.id });
    const archive = unzipSync((await request('GET', `/api/documents/${doc.id}/export`)).rawPayload);
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.imageOrder).toEqual([`images/${asset.storageKey}`]);
    expect(Buffer.from(archive[`images/${asset.storageKey}`]).equals(png)).toBe(true);
    expect(strFromU8(archive['article.html'])).toContain(`images/${asset.storageKey}`);
    const imageMaterial = (
      await request('POST', '/api/materials', { title: '配图素材', kind: 'image', assetId: asset.id })
    ).json<Material>();
    const references = (await request('GET', `/api/materials/${imageMaterial.id}/references`)).json();
    expect(references.documents.map((item: { id: string }) => item.id)).toContain(doc.id);
  });
  it('灵感关联素材遵循账号范围，开始写作时成为文稿引用', async () => {
    const own = await createAccount('灵感账号 A');
    const other = await createAccount('灵感账号 B');
    const shared = (
      await request('POST', '/api/materials', {
        title: '共享观察',
        body: '共享内容',
        sourceDate: '2026-09-30',
      })
    ).json<Material>();
    expect(shared.sourceDate).toBe('2026-09-30');
    expect(
      (await request('POST', '/api/materials', { title: '错误日期', sourceDate: '2026/09/30' })).statusCode,
    ).toBe(400);
    const owned = (
      await request('POST', '/api/materials', { title: '账号 A 的样文', body: 'A 的表达', accountId: own.id })
    ).json<Material>();
    const foreign = (
      await request('POST', '/api/materials', {
        title: '账号 B 的样文',
        body: 'B 的表达',
        accountId: other.id,
      })
    ).json<Material>();
    expect(
      (
        await request('POST', '/api/ideas', {
          title: '越界关联',
          accountId: own.id,
          materialIds: [foreign.id],
        })
      ).statusCode,
    ).toBe(400);
    const idea = (
      await request('POST', '/api/ideas', {
        title: '带素材的灵感',
        accountId: own.id,
        materialIds: [shared.id, owned.id],
      })
    ).json<Idea>();
    expect(idea.materialIds).toEqual([shared.id, owned.id]);
    expect((await request('PUT', `/api/ideas/${idea.id}`, { ...idea, accountId: other.id })).statusCode).toBe(
      400,
    );
    const doc = await createDoc(own.id, { ideaId: idea.id, materialIds: idea.materialIds });
    expect(doc.context.citations.map((citation) => citation.title)).toEqual(['共享观察', '账号 A 的样文']);
    const references = (await request('GET', `/api/materials/${shared.id}/references`)).json();
    const scoped = (
      await request('GET', `/api/materials?accountId=${own.id}&q=${encodeURIComponent('样文')}`)
    ).json();
    expect(scoped.items.map((item: Material) => item.id)).toEqual([owned.id]);
    const sharedOnly = (
      await request('GET', `/api/materials?shared=true&q=${encodeURIComponent('观察')}`)
    ).json();
    expect(sharedOnly.items.map((item: Material) => item.id)).toEqual([shared.id]);
    expect(references.ideas[0].id).toBe(idea.id);
    expect(references.documents[0].id).toBe(doc.id);
  });
});

describe('内容修订与发布快照', () => {
  it('并发版本冲突可见，恢复旧稿会生成新版本', async () => {
    const doc = await createDoc();
    const updated = await request('PUT', `/api/documents/${doc.id}`, {
      ...doc,
      body: '第二版正文',
      expectedRevision: 1,
    });
    expect(updated.json().revision).toBe(2);
    expect(
      (await request('PUT', `/api/documents/${doc.id}`, { ...doc, body: '迟到写入', expectedRevision: 1 }))
        .statusCode,
    ).toBe(409);
    const restored = await request('POST', `/api/documents/${doc.id}/restore`, {
      revision: 1,
      expectedRevision: 2,
    });
    expect(restored.json().revision).toBe(3);
    expect(restored.json().body).toBe(doc.body);
    expect((await request('GET', `/api/documents/${doc.id}/revisions`)).json()).toHaveLength(3);
  });
  it('派生版本相互独立，母稿更新产生过期标记', async () => {
    const doc = await createDoc();
    const account = await createAccount('平台版本账号', 'xiaohongshu');
    const variant = (
      await request('POST', `/api/documents/${doc.id}/variants`, {
        accountId: account.id,
        expectedRevision: 1,
      })
    ).json();
    expect(variant.sourceId).toBe(doc.id);
    expect(variant.sourceRevision).toBe(1);
    await request('PUT', `/api/documents/${doc.id}`, { ...doc, body: '母稿新内容', expectedRevision: 1 });
    const actual = (await request('GET', `/api/documents/${variant.id}`)).json();
    expect(actual.body).toBe(doc.body);
    expect(actual.sourceOutdated).toBe(true);
  });
  it('发布计划去重、冻结内容，人工回填与取消保持正确状态', async () => {
    const account = await createAccount('发布测试');
    const doc = await createDoc(account.id);
    const input = {
      documentId: doc.id,
      expectedRevision: 1,
      scheduledAt: '2027-01-01T04:00:00.000Z',
      timezone: 'Asia/Shanghai',
    };
    const headers = { 'idempotency-key': id() };
    const results = await Promise.all([
      request('POST', '/api/publishing', input, headers),
      request('POST', '/api/publishing', input, headers),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    expect(results[0].json().id).toBe(results[1].json().id);
    const task = results[0].json();
    const moved = await request('PUT', `/api/publishing/${task.id}`, {
      scheduledAt: '2027-01-02T04:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().scheduledAt).toBe('2027-01-02T04:00:00.000Z');
    expect(moved.json().status).toBe('planned');
    const inRange = await request(
      'GET',
      '/api/publishing?from=2027-01-01T00%3A00%3A00Z&to=2027-02-01T00%3A00%3A00Z',
    );
    expect(inRange.json().items.some((item: { id: string }) => item.id === task.id)).toBe(true);
    const outside = await request('GET', '/api/publishing?from=2028-01-01T00%3A00%3A00Z');
    expect(outside.json().total).toBe(0);
    expect(
      (await request('GET', '/api/publishing?platform=wechat'))
        .json()
        .items.some((item: { id: string }) => item.id === task.id),
    ).toBe(true);
    expect(
      (await request('GET', '/api/publishing?platform=xiaohongshu'))
        .json()
        .items.some((item: { id: string }) => item.id === task.id),
    ).toBe(false);
    await request('PUT', `/api/documents/${doc.id}`, {
      ...doc,
      body: '继续修改后的内容',
      expectedRevision: 1,
    });
    const exported = await request('GET', `/api/publishing/${task.id}/export`);
    const files = unzipSync(exported.rawPayload);
    expect(strFromU8(files['article.md'])).toContain(doc.body);
    expect(strFromU8(files['article.md'])).not.toContain('继续修改');
    expect(
      (
        await request('POST', `/api/publishing/${task.id}/record`, {
          url: 'https://example.com/article',
          publishedAt: '2099-01-01T00:00:00Z',
        })
      ).statusCode,
    ).toBe(400);
    const recorded = await request('POST', `/api/publishing/${task.id}/record`, {
      url: 'https://example.com/article',
      publishedAt: new Date().toISOString(),
    });
    expect(recorded.json().resultSource).toBe('user_recorded');
    expect(recorded.json().status).toBe('published');
    expect((await request('POST', `/api/publishing/${task.id}/cancel`, {})).statusCode).toBe(409);
    expect(
      (await request('PUT', `/api/publishing/${task.id}`, { scheduledAt: null, timezone: 'Asia/Shanghai' }))
        .statusCode,
    ).toBe(409);
    await request('PUT', `/api/accounts/${account.id}`, { ...account, active: false });
    expect(
      (
        await request(
          'POST',
          '/api/publishing',
          { ...input, expectedRevision: 2 },
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('真实 HTTP 模型适配与持久化任务', () => {
  it('模型配置不返回密钥，服务错误不泄漏上游响应', async () => {
    const result = await request('PUT', '/api/settings/model', {
      name: '测试服务',
      baseUrl: mockUrl,
      model: 'test-model',
      apiKey: 'test-provider-secret',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('test-provider-secret');
    expect(result.json().hasKey).toBe(true);
    expect((await request('POST', '/api/settings/model/test', {})).json().ok).toBe(true);
    expect(
      (
        await request('PUT', '/api/settings/model', {
          name: '其他地址',
          baseUrl: 'https://example.com/v1',
          model: 'test',
        })
      ).statusCode,
    ).toBe(400);
    modelStatus = 401;
    const failed = await request('POST', '/api/settings/model/test', {});
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('test-provider-secret');
    modelStatus = 200;
  });
  it('AI 结果可查询，迟到结果不能覆盖人工新稿', async () => {
    const doc = await createDoc();
    const headers = { 'idempotency-key': id() };
    const input = { documentId: doc.id, expectedRevision: 1, kind: 'draft' };
    const queued = await request('POST', '/api/jobs', input, headers);
    expect(queued.statusCode).toBe(202);
    const job = queued.json<AIJob>();
    expect((await request('POST', '/api/jobs', input, headers)).json().id).toBe(job.id);
    const worker = startWorker(db, config, 100000);
    try {
      await expect
        .poll(async () => (await request('GET', `/api/jobs/${job.id}`)).json().status, { timeout: 15000 })
        .toBe('succeeded');
    } finally {
      await worker.stop();
    }
    expect((await request('GET', `/api/jobs/${job.id}`)).json().usage.prompt_tokens).toBe(20);
    await request('PUT', `/api/documents/${doc.id}`, {
      ...doc,
      body: '我已经写了更好的内容',
      expectedRevision: 1,
    });
    expect((await request('POST', `/api/jobs/${job.id}/apply`, { expectedRevision: 2 })).statusCode).toBe(
      409,
    );
    expect((await request('GET', `/api/documents/${doc.id}`)).json().body).toBe('我已经写了更好的内容');
  });
  it('未改动的稿件可以采用结果，取消与中断不会自动重跑', async () => {
    const doc = await createDoc();
    const job = (
      await request(
        'POST',
        '/api/jobs',
        { documentId: doc.id, expectedRevision: 1, kind: 'outline' },
        { 'idempotency-key': id() },
      )
    ).json<AIJob>();
    const worker = startWorker(db, config, 100000);
    try {
      await expect
        .poll(async () => (await request('GET', `/api/jobs/${job.id}`)).json().status, { timeout: 15000 })
        .toBe('succeeded');
    } finally {
      await worker.stop();
    }
    const saved = await request('POST', `/api/jobs/${job.id}/apply`, { expectedRevision: 1 });
    expect(saved.json().outline).toContain('生成结果');
    expect(saved.json().revision).toBe(2);
    expect((await request('POST', `/api/jobs/${job.id}/apply`, { expectedRevision: 1 })).statusCode).toBe(
      409,
    );
    const cancelled = (
      await request(
        'POST',
        '/api/jobs',
        { documentId: doc.id, expectedRevision: 2, kind: 'draft' },
        { 'idempotency-key': id() },
      )
    ).json<AIJob>();
    expect((await request('POST', `/api/jobs/${cancelled.id}/cancel`, {})).json().status).toBe('cancelled');
    const interrupted = (
      await request(
        'POST',
        '/api/jobs',
        { documentId: doc.id, expectedRevision: 2, kind: 'draft' },
        { 'idempotency-key': id() },
      )
    ).json<AIJob>();
    await db.rows(
      `UPDATE jobs SET status='running',"leaseToken"=$1,"leaseUntil"=now()-interval '1 second' WHERE id=$2`,
      [id(), interrupted.id],
    );
    const recover = startWorker(db, config, 100000);
    try {
      await expect
        .poll(async () => (await request('GET', `/api/jobs/${interrupted.id}`)).json().status, {
          timeout: 10000,
        })
        .toBe('failed');
    } finally {
      await recover.stop();
    }
  });
  it('开头备选只作为候选结果，不能直接覆盖正文', async () => {
    const doc = await createDoc();
    const job = (
      await request(
        'POST',
        '/api/jobs',
        { documentId: doc.id, expectedRevision: 1, kind: 'opening' },
        { 'idempotency-key': id() },
      )
    ).json<AIJob>();
    const worker = startWorker(db, config, 100000);
    try {
      await expect
        .poll(async () => (await request('GET', `/api/jobs/${job.id}`)).json().status, { timeout: 15000 })
        .toBe('succeeded');
    } finally {
      await worker.stop();
    }
    const applied = await request('POST', `/api/jobs/${job.id}/apply`, { expectedRevision: 1 });
    expect(applied.statusCode).toBe(400);
    expect(applied.json().code).toBe('CHOICE_REQUIRED');
    expect((await request('GET', `/api/documents/${doc.id}`)).json().body).toBe(doc.body);
  });
});

describe('备份与干净实例恢复', () => {
  it('保留数据和素材，校验密钥，且不覆盖已有实例', async () => {
    const backup = await createBackup(db, config, workspaceId);
    const unzipped = unzipSync(backup);
    const data = JSON.parse(strFromU8(unzipped['data.json']));
    expect(strFromU8(unzipped['data.json'])).not.toContain('test-provider-secret');
    expect(data.tables.providers[0].keyCipher).toBeTruthy();
    expect(data.tables.workspaces).toHaveLength(1);
    expect(data.tables.workspaces[0].id).toBe(workspaceId);
    expect(data.tables.sessions).toBeUndefined();
    const restoreFolder = await mkdtemp(path.join(tempBase, 'one-creator-restore-'));
    const restoreConfig = await loadConfig({ ...config, dataDir: restoreFolder });
    const restored = await openDatabase(restoreConfig, true);
    try {
      await expect(
        restoreBackup(restored, { ...restoreConfig, encryptionKey: 'cd'.repeat(32) }, backup),
      ).rejects.toThrow('密钥不匹配');
      const result = await restoreBackup(restored, restoreConfig, backup);
      expect(result.documents).toBeGreaterThan(0);
      expect(result.assets).toBeGreaterThan(0);
      const [asset] = await restored.rows<Asset>('SELECT * FROM assets LIMIT 1');
      expect((await readFile(path.join(restoreFolder, 'assets', asset.storageKey))).equals(png)).toBe(true);
      const rows = await restored.rows<{ count: number }>('SELECT count(*)::int AS count FROM documents');
      expect(rows[0].count).toBe(result.documents);
      await expect(restoreBackup(restored, restoreConfig, backup)).rejects.toThrow('空实例');
    } finally {
      await restored.close();
      await rm(restoreFolder, { recursive: true, force: true });
    }
  });
  it('落盘数据库关闭后重新打开仍可读取数据与迁移版本', async () => {
    const persistentDir = await mkdtemp(path.join(tempBase, 'one-creator-persistence-'));
    const settings = { ...config, dataDir: persistentDir };
    let persistent = await openDatabase(settings);
    const workspace = id();
    try {
      await insert(persistent, 'workspaces', { id: workspace, name: '持久化验证' });
      await persistent.close();
      persistent = await openDatabase(settings);
      expect(
        (await persistent.rows<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [workspace]))[0]
          .name,
      ).toBe('持久化验证');
      expect((await persistent.rows('SELECT * FROM schema_migrations')).length).toBe(migrations.length);
    } finally {
      await persistent.close();
      await rm(persistentDir, { recursive: true, force: true });
    }
  });
  it('旧结构数据库按顺序升级并保留数据，拒绝被旧程序打开', async () => {
    const legacy = await openDatabase(config, true, migrations.slice(0, 1));
    try {
      const workspace = id();
      const ideaId = id();
      await insert(legacy, 'workspaces', { id: workspace, name: '旧版本空间' });
      await insert(legacy, 'ideas', { id: ideaId, workspaceId: workspace, title: '升级前的灵感' });
      await migrate(legacy);
      const [idea] = await legacy.rows<Idea>('SELECT * FROM ideas WHERE id=$1', [ideaId]);
      expect(idea.title).toBe('升级前的灵感');
      expect(idea.materialIds).toEqual([]);
      const [check] = await legacy.rows<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='jobs_kind_check'",
      );
      expect(check.definition).toContain('opening');
      expect((await legacy.rows('SELECT * FROM schema_migrations')).length).toBe(migrations.length);
      await expect(migrate(legacy, migrations.slice(0, 1))).rejects.toThrow('新于当前程序');
    } finally {
      await legacy.close();
    }
  });
});
