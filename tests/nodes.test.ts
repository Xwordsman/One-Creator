import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type {
  Account,
  AccountCapabilities,
  Asset,
  AutomationJob,
  BrowserConnection,
  ContentDocument,
  PublishTask,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { startAutomationWorker } from '@one-creator/server/automation';
import { buildApp } from '../apps/api/src/app.js';
import { runBrowserJob, type BrowserJob, type BrowserClient } from '../apps/executor/src/browser.js';

let db: Database;
let app: FastifyInstance;
let config: AppConfig;
let folder: string;
let cookie: string;
let editorCookie: string;
let asset: Asset;
let other: Asset;
let nodeToken: string;
let nodeId: string;
const instance = randomUUID();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
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
const executor = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  token = nodeToken,
  instanceId = instance,
) =>
  app.inject({
    method,
    url: `/api/executor${url}`,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}`, 'x-executor-instance': instanceId, ...headers },
  });
async function upload(name: string, bytes: Buffer, mime = 'image/png') {
  const boundary = 'nodes-upload';
  const response = await app.inject({
    method: 'POST',
    url: '/api/assets',
    headers: {
      cookie,
      'x-creator-client': 'web',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Asset>();
}
async function account(name: string, platform: string, handle = '') {
  const response = await request('POST', '/api/accounts', { name, platform, handle });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Account>();
}
async function login(target: Account, identity: string) {
  expect((await request('PUT', `/api/accounts/${target.id}/browser-connection`, { nodeId })).statusCode).toBe(
    200,
  );
  const started = await request(
    'POST',
    `/api/accounts/${target.id}/browser-login`,
    {},
    { 'idempotency-key': id() },
  );
  expect(started.statusCode, started.body).toBe(202);
  const { job } = (await executor('POST', '/poll', { version: 'test' })).json();
  expect(job.kind).toBe('browser_login');
  const result = await executor('POST', `/jobs/${job.id}/result`, {
    leaseToken: job.leaseToken,
    result: { state: 'connected', identity },
  });
  expect(result.statusCode, result.body).toBe(200);
  return started.json<AutomationJob>();
}
async function plan(target: Account, title: string) {
  const doc = await request('POST', '/api/documents', {
    title,
    body: `${title}的正文`,
    accountId: target.id,
    assetIds: [asset.id],
    coverAssetId: asset.id,
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
const browserPublish = (target: Account, taskId: string, key = id()) =>
  request(
    'POST',
    '/api/automation',
    { kind: 'browser_publish', accountId: target.id, data: { publishTaskId: taskId, nodeId } },
    { 'idempotency-key': key },
  );
const publication = async (taskId: string) =>
  (await db.rows<PublishTask>('SELECT * FROM publish_tasks WHERE id=$1', [taskId]))[0];

beforeAll(async () => {
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'nodes-'));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'de'.repeat(32),
    production: false,
    workerMode: 'inline',
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'operator', name: '节点验证', password: 'Node-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const member = await request('POST', '/api/members', {
    username: 'editor',
    password: 'Node-Editor-Password',
    name: '编辑',
    role: 'editor',
  });
  expect(member.statusCode, member.body).toBe(201);
  const signed = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'editor', password: 'Node-Editor-Password' },
  });
  editorCookie = signed.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  asset = await upload('cover.png', png);
  other = await upload('unrelated.png', Buffer.concat([png, Buffer.from([0])]));
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('独立执行节点与浏览器通道协议（PUB-06 / PUB-07 / PUB-09，模拟节点）', () => {
  let xhs: Account;
  let toutiao: Account;
  it('注册节点只显示一次令牌；扫码登录画面仅管理员可见，身份需确认后才可发布', async () => {
    xhs = await account('小红书主号', 'xiaohongshu');
    toutiao = await account('头条号', 'toutiao', 'toutiao-owner');
    const registered = await request('POST', '/api/nodes', {
      name: '家里的电脑',
      accountIds: [xhs.id, toutiao.id],
      platforms: ['xiaohongshu', 'toutiao'],
    });
    expect(registered.statusCode, registered.body).toBe(201);
    nodeToken = registered.json().token;
    nodeId = registered.json().node.id;
    expect(nodeToken).toMatch(/^ocn_/);
    const listed = await request('GET', '/api/nodes');
    expect(listed.body).not.toContain(nodeToken);
    expect(listed.body).not.toContain('tokenHash');
    expect((await request('GET', '/api/nodes', undefined, { cookie: editorCookie })).statusCode).toBe(403);
    expect(
      (
        await request(
          'POST',
          `/api/accounts/${xhs.id}/browser-login`,
          {},
          { 'idempotency-key': id(), cookie: editorCookie },
        )
      ).statusCode,
    ).toBe(403);
    expect((await executor('POST', '/poll', {}, {}, 'ocn_invalid')).statusCode).toBe(401);

    expect(
      (
        await request('PUT', `/api/accounts/${xhs.id}/browser-connection`, {
          nodeId,
          selectors: { publishUrl: 'https://evil.example/' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await request('PUT', `/api/accounts/${xhs.id}/browser-connection`, { nodeId })).statusCode).toBe(
      200,
    );
    const started = await request(
      'POST',
      `/api/accounts/${xhs.id}/browser-login`,
      {},
      { 'idempotency-key': id() },
    );
    expect(started.statusCode, started.body).toBe(202);
    const { job } = (
      await executor('POST', '/poll', { version: 'test', capabilities: { browser: true } })
    ).json();
    expect(job).toMatchObject({ kind: 'browser_login', account: { id: xhs.id, platform: 'xiaohongshu' } });
    expect((await executor('POST', '/poll', {}, {}, nodeToken, randomUUID())).statusCode).toBe(409);
    expect(
      (
        await executor('POST', `/jobs/${job.id}/heartbeat`, {
          leaseToken: job.leaseToken,
          stage: 'waiting_user',
        })
      ).statusCode,
    ).toBe(200);
    const boundary = 'screen';
    const screenshot = await executor(
      'POST',
      `/jobs/${job.id}/screenshot`,
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="screen.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      { 'x-job-lease': job.leaseToken, 'content-type': `multipart/form-data; boundary=${boundary}` },
    );
    expect(screenshot.statusCode, screenshot.body).toBe(200);
    const screen = await request('GET', `/api/automation/${job.id}/browser-screen`);
    expect(screen.statusCode).toBe(200);
    expect(screen.headers['cache-control']).toContain('no-store');
    expect(
      (await request('GET', `/api/automation/${job.id}/browser-screen`, undefined, { cookie: editorCookie }))
        .statusCode,
    ).toBe(403);
    expect((await db.rows(`SELECT id FROM assets WHERE metadata->>'jobId'=$1`, [job.id])).length).toBe(0);

    expect(
      (await request('POST', `/api/automation/${job.id}/browser-command`, { kind: 'type', text: '123456' }))
        .statusCode,
    ).toBe(200);
    const commands = (
      await executor('GET', `/jobs/${job.id}/commands`, undefined, { 'x-job-lease': job.leaseToken })
    ).json().commands;
    expect(commands).toEqual([expect.objectContaining({ kind: 'type', text: '123456' })]);
    await executor(
      'POST',
      `/jobs/${job.id}/commands/ack`,
      { ids: commands.map((command: { id: string }) => command.id) },
      { 'x-job-lease': job.leaseToken },
    );
    expect(
      (await executor('GET', `/jobs/${job.id}/commands`, undefined, { 'x-job-lease': job.leaseToken })).json()
        .commands,
    ).toEqual([]);

    expect(
      (
        await executor('POST', `/jobs/${job.id}/result`, {
          leaseToken: randomUUID(),
          result: { state: 'connected', identity: 'xhs-123' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await executor('POST', `/jobs/${job.id}/result`, {
          leaseToken: job.leaseToken,
          result: { state: 'connected', identity: 'xhs-123' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await readdir(path.join(folder, 'browser-login')).catch(() => [])).length).toBe(0);
    const connection = (
      await request('GET', `/api/accounts/${xhs.id}/browser-connection`)
    ).json<BrowserConnection>();
    expect(connection).toMatchObject({
      status: 'waiting_confirmation',
      identity: 'xhs-123',
      nodeOnline: true,
    });
    const draft = await plan(xhs, '确认前的小红书笔记');
    expect((await browserPublish(xhs, draft.id)).statusCode).toBe(400);
    expect(
      (
        await request('POST', `/api/accounts/${xhs.id}/confirm-browser-identity`, {
          identity: 'someone-else',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('POST', `/api/accounts/${xhs.id}/confirm-browser-identity`, { identity: 'xhs-123' }))
        .statusCode,
    ).toBe(200);
    expect((await db.rows<Account>('SELECT * FROM accounts WHERE id=$1', [xhs.id]))[0].handle).toBe(
      'xhs-123',
    );
    // Logged in and confirmed is not proof the selectors work on today's page: still pending until verified.
    const capabilities = (
      await request('GET', `/api/accounts/${xhs.id}/capabilities`)
    ).json<AccountCapabilities>();
    expect(capabilities.capabilities.publish.status).toBe('unknown');
    expect(capabilities.capabilities.publish.reason).toContain('尚未在这个账号上完成核验');
  });

  it('只交付绑定素材；回执不确定时禁止重发，核验到唯一已发布条目后才算成功', async () => {
    const draft = await plan(xhs, '小红书图文发布');
    const created = await browserPublish(xhs, draft.id);
    expect(created.statusCode, created.body).toBe(202);
    expect((await browserPublish(xhs, draft.id)).statusCode).toBe(409);
    const { job } = (await executor('POST', '/poll', {})).json();
    expect(job).toMatchObject({ kind: 'browser_publish', account: { handle: 'xhs-123' } });
    expect(job.assets.map((item: Asset) => item.id)).toEqual([asset.id]);
    expect(
      (
        await executor('GET', `/jobs/${job.id}/assets/${asset.id}`, undefined, {
          'x-job-lease': job.leaseToken,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await executor('GET', `/jobs/${job.id}/assets/${other.id}`, undefined, {
          'x-job-lease': job.leaseToken,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await executor('GET', `/jobs/${job.id}/assets/${asset.id}`, undefined, {
          'x-job-lease': randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect((await publication(draft.id)).status).toBe('submitting');
    await executor('POST', `/jobs/${job.id}/heartbeat`, { leaseToken: job.leaseToken, stage: 'publishing' });
    expect((await publication(draft.id)).submittedAt).toBeTruthy();
    const uncertain = await executor('POST', `/jobs/${job.id}/result`, {
      leaseToken: job.leaseToken,
      result: { state: 'uncertain', identity: 'xhs-123', message: '点击后没有回执' },
    });
    expect(uncertain.statusCode, uncertain.body).toBe(200);
    expect((await publication(draft.id)).status).toBe('verification_required');
    expect((await browserPublish(xhs, draft.id)).statusCode).toBe(409);
    const verify = await request(
      'POST',
      '/api/automation',
      { kind: 'browser_verify', accountId: xhs.id, data: { publishTaskId: draft.id, nodeId } },
      { 'idempotency-key': id() },
    );
    expect(verify.statusCode, verify.body).toBe(202);
    const check = (await executor('POST', '/poll', {})).json().job;
    expect(check.kind).toBe('browser_verify');
    expect(check.submittedAt).toBeTruthy();
    expect(
      (
        await executor('POST', `/jobs/${check.id}/result`, {
          leaseToken: check.leaseToken,
          result: { state: 'published', identity: 'xhs-123', url: 'https://evil.example/post' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await publication(draft.id)).status).toBe('verification_required');
    const again = await request(
      'POST',
      '/api/automation',
      { kind: 'browser_verify', accountId: xhs.id, data: { publishTaskId: draft.id, nodeId } },
      { 'idempotency-key': id() },
    );
    const second = (await executor('POST', '/poll', {})).json().job;
    expect(second.id).toBe(again.json().id);
    await executor('POST', `/jobs/${second.id}/result`, {
      leaseToken: second.leaseToken,
      result: { state: 'published', identity: 'xhs-123', url: 'https://www.xiaohongshu.com/explore/note-1' },
    });
    const done = await publication(draft.id);
    expect(done).toMatchObject({
      status: 'published',
      resultSource: 'node_observed',
      url: 'https://www.xiaohongshu.com/explore/note-1',
    });
    expect((await request('GET', `/api/automation/${created.json().id}`)).json().status).toBe('succeeded');
    // One verified publication on this account is the evidence that turns the channel into supported.
    expect(
      (await request('GET', `/api/accounts/${xhs.id}/capabilities`)).json<AccountCapabilities>().capabilities
        .publish.status,
    ).toBe('supported');
    expect(
      (await request('GET', `/api/accounts/${toutiao.id}/capabilities`)).json<AccountCapabilities>()
        .capabilities.publish.status,
    ).not.toBe('supported');
  });

  it('节点掉线留下可恢复记录：提交中失联进入待核对，迟到结果被忽略；不能开始的任务不阻塞队列', async () => {
    await login(toutiao, 'toutiao-owner');
    expect((await request('GET', `/api/accounts/${toutiao.id}/browser-connection`)).json().status).toBe(
      'connected',
    );
    const draft = await plan(toutiao, '头条文章发布');
    const created = (await browserPublish(toutiao, draft.id)).json<AutomationJob>();
    const { job } = (await executor('POST', '/poll', {})).json();
    expect(job.id).toBe(created.id);
    await executor('POST', `/jobs/${job.id}/heartbeat`, { leaseToken: job.leaseToken, stage: 'publishing' });
    await db.rows(`UPDATE automation_jobs SET "leaseUntil"=now()-interval '1 second' WHERE id=$1`, [job.id]);
    await db.rows(
      `UPDATE account_execution_leases SET "expiresAt"=now()-interval '1 second' WHERE "ownerId"=$1`,
      [job.id],
    );
    const worker = startAutomationWorker(db, config, 1000000);
    await worker.tick();
    await worker.stop();
    expect((await request('GET', `/api/automation/${job.id}`)).json().status).toBe('needs_verification');
    expect((await publication(draft.id)).status).toBe('verification_required');
    expect(
      (
        await executor('POST', `/jobs/${job.id}/result`, {
          leaseToken: job.leaseToken,
          result: { state: 'submitted', identity: 'toutiao-owner' },
        })
      ).statusCode,
    ).toBe(409);
    const released = await request('POST', `/api/publishing/${draft.id}/confirm-not-published`, {
      confirmed: true,
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().status).toBe('waiting_user');

    const blocked = (await browserPublish(toutiao, draft.id)).json<AutomationJob>();
    await db.rows(`UPDATE browser_connections SET status='expired' WHERE "accountId"=$1`, [toutiao.id]);
    const later = await plan(xhs, '后面的小红书任务');
    const next = (await browserPublish(xhs, later.id)).json<AutomationJob>();
    expect((await executor('POST', '/poll', {})).json().job).toBeNull();
    expect((await request('GET', `/api/automation/${blocked.id}`)).json().status).toBe('failed');
    expect((await publication(draft.id)).status).toBe('waiting_user');
    expect((await executor('POST', '/poll', {})).json().job.id).toBe(next.id);
  });

  it('撤销或轮换节点令牌后旧凭据立即失效', async () => {
    const rotated = await request('POST', `/api/nodes/${nodeId}/rotate-token`, {});
    expect(rotated.statusCode).toBe(200);
    expect((await executor('POST', '/poll', {})).statusCode).toBe(401);
    nodeToken = rotated.json().token;
    expect((await executor('POST', '/poll', {}, {}, nodeToken, randomUUID())).statusCode).toBe(200);
    expect((await request('DELETE', `/api/nodes/${nodeId}`)).statusCode).toBe(200);
    expect((await executor('POST', '/poll', {})).statusCode).toBe(401);
  });
});

describe('独立执行器进程通过 HTTP 接入（PUB-09，真实进程，本地服务）', () => {
  it('执行器进程上报在线与版本，领取绑定任务；会话缺失时任务失败、连接标记失效并通知作者', async () => {
    const zhihu = await account('知乎专栏', 'zhihu', 'zhihu-owner');
    const registered = await request('POST', '/api/nodes', {
      name: '工作室电脑',
      accountIds: [zhihu.id],
      platforms: ['zhihu'],
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const { token, node } = registered.json();
    expect(
      (await request('PUT', `/api/accounts/${zhihu.id}/browser-connection`, { nodeId: node.id })).statusCode,
    ).toBe(200);
    // Treat the session as confirmed without visiting any platform; the node has no stored session file.
    await db.rows(
      `UPDATE browser_connections SET status='connected',identity='zhihu-owner' WHERE "accountId"=$1`,
      [zhihu.id],
    );
    const draft = await plan(zhihu, '知乎专栏草稿');
    const job = (
      await request(
        'POST',
        '/api/automation',
        { kind: 'browser_publish', accountId: zhihu.id, data: { publishTaskId: draft.id, nodeId: node.id } },
        { 'idempotency-key': id() },
      )
    ).json<AutomationJob>();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const dataDir = await mkdtemp(path.resolve('.data/test-temp/executor-process-'));
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/executor/src/main.ts'], {
      env: { ...process.env, EXECUTOR_SERVER: address, EXECUTOR_TOKEN: token, EXECUTOR_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    try {
      await expect
        .poll(async () => (await request('GET', `/api/automation/${job.id}`)).json<AutomationJob>().status, {
          timeout: 30000,
          interval: 250,
        })
        .toBe('failed');
      const [current] = await db.rows<{
        lastSeenAt: string;
        agentVersion: string;
        instanceId: string | null;
        reported: Record<string, unknown>;
      }>('SELECT * FROM execution_nodes WHERE id=$1', [node.id]);
      expect(current.agentVersion, output).toBe('0.1.0-alpha.1');
      expect(current.instanceId).toBeTruthy();
      expect(current.reported).toMatchObject({ browser: true });
      expect(Date.parse(current.lastSeenAt)).toBeGreaterThan(Date.now() - 60000);
      expect(
        (await request('GET', '/api/nodes'))
          .json<{ items: { id: string; lastSeenAt: string }[] }>()
          .items.find((item) => item.id === node.id)?.lastSeenAt,
      ).toBeTruthy();
      expect((await request('GET', `/api/automation/${job.id}`)).json().error).toContain('重新扫码登录');
      expect(
        (await request('GET', `/api/accounts/${zhihu.id}/browser-connection`)).json<BrowserConnection>(),
      ).toMatchObject({ status: 'expired', nodeOnline: true });
      expect((await publication(draft.id)).status).toBe('waiting_user');
      // SYS-07: the expired session is a notice for the author, not a silent state change.
      const notices = (await request('GET', '/api/notifications?limit=100')).json<{
        items: { title: string; path: string }[];
      }>().items;
      expect(notices.filter((notice) => notice.title === '浏览器登录已失效')).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/accounts' })]),
      );
      // The session file never existed on this node, and nothing else is written for it.
      expect(await readdir(path.join(dataDir, 'profiles')).catch(() => [])).toEqual([]);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('执行器在真实 Chromium 中驱动页面（本地模拟平台页面，非真实平台）', () => {
  const posts: { title: string; body: string; files: number }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    if (url.pathname === '/login')
      return html(
        `<input id="code" autofocus><script>document.getElementById('code').addEventListener('input',e=>{if(e.target.value.includes('scan-ok'))document.body.insertAdjacentHTML('beforeend','<a data-user-id="xhs-123" href="/user/profile/xhs-123">我</a>');});</script>`,
      );
    if (url.pathname === '/publish')
      return html(`<a data-user-id="xhs-123" href="/user/profile/xhs-123">我</a><input type="file" multiple id="files"><input placeholder="填写标题" id="title"><div contenteditable="true" id="editor"></div><button data-testid="publish" id="go">发布</button><p id="state"></p>
        <script>document.getElementById('go').onclick=async()=>{await fetch('/submit',{method:'POST',body:JSON.stringify({title:document.getElementById('title').value,body:document.getElementById('editor').innerText,files:document.getElementById('files').files.length})});document.getElementById('state').textContent='发布成功';};</script>`);
    if (url.pathname === '/submit' && req.method === 'POST') {
      const parts: Buffer[] = [];
      req.on('data', (part) => parts.push(part));
      req.on('end', () => {
        posts.push(JSON.parse(Buffer.concat(parts).toString()));
        res.end('{}');
      });
      return;
    }
    const time = new Date(Date.now() - 1000).toISOString();
    if (url.pathname === '/manage')
      return html(`<a data-user-id="xhs-123" href="/user/profile/xhs-123">我</a>
        <div class="note-item"><h3>浏览器验证笔记</h3><span>审核中</span><time datetime="${time}"></time><a href="/explore/pending">看</a></div>
        <div class="note-item"><h3>另一篇笔记</h3><span>已发布</span><time datetime="${time}"></time><a href="/explore/other">看</a></div>
        <div class="note-item"><h3>浏览器验证笔记</h3><span>已发布</span><time datetime="${time}"></time><a href="/explore/note-1">看</a></div>`);
    if (url.pathname.startsWith('/explore/'))
      return html(`<div class="note-text">浏览器验证的正文内容</div>`);
    res.writeHead(404).end();
  });
  let origin = '';
  let dataDir = '';
  const encryptionKey = 'ef'.repeat(32);
  const commands: { id: string; kind: string; text?: string }[] = [];
  const stages: string[] = [];
  const client: BrowserClient = {
    heartbeat: async (stage) => {
      stages.push(stage);
      if (stage === 'waiting_user' && !commands.length && !stages.includes('typed')) {
        stages.push('typed');
        commands.push({ id: randomUUID(), kind: 'type', text: 'scan-ok' });
      }
    },
    screenshot: async (bytes) => {
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    },
    asset: async () => png,
    commands: async () => commands.splice(0),
    ack: async () => {},
  };
  const document = {
    id: randomUUID(),
    title: '浏览器验证笔记',
    body: '浏览器验证的正文内容',
    assetIds: ['00000000-0000-4000-8000-000000000001'],
    coverAssetId: null,
    videoAssetId: null,
    context: { visual: null },
  } as unknown as ContentDocument;
  const job = (kind: BrowserJob['kind'], extra: Partial<BrowserJob> = {}): BrowserJob => ({
    id: randomUUID(),
    kind,
    leaseToken: randomUUID(),
    account: { id: 'acc-1', name: '小红书', platform: 'xiaohongshu', handle: 'xhs-123' },
    selectors: {},
    document,
    assets: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        filename: 'card.png',
        mime: 'image/png',
        size: png.length,
      },
    ],
    submittedAt: null,
    resetSession: false,
    ...extra,
  });
  const browserConfig = () => ({
    dataDir,
    encryptionKey,
    testProfile: {
      xiaohongshu: {
        loginUrl: `${origin}/login`,
        publishUrl: `${origin}/publish`,
        listUrl: `${origin}/manage`,
      },
    },
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    dataDir = await mkdtemp(path.resolve('.data/test-temp/executor-'));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('登录页按 Web 端指令交互并识别账号，加密保存独立会话；发布前核对账号并只提交一次', async () => {
    const signal = new AbortController().signal;
    const missing = await runBrowserJob(job('browser_publish'), browserConfig(), client, signal);
    expect(missing).toMatchObject({ state: 'failed', receipt: { connectionState: 'expired' } });
    const logged = await runBrowserJob(
      job('browser_login', { account: { id: 'acc-1', name: '小红书', platform: 'xiaohongshu', handle: '' } }),
      browserConfig(),
      client,
      signal,
    );
    expect(logged).toMatchObject({ state: 'connected', identity: 'xhs-123' });
    const profiles = await readdir(path.join(dataDir, 'profiles'));
    expect(profiles).toEqual(['xiaohongshu-acc-1.enc']);
    const mismatch = await runBrowserJob(
      job('browser_publish', {
        account: { id: 'acc-1', name: '小红书', platform: 'xiaohongshu', handle: 'someone-else' },
      }),
      browserConfig(),
      client,
      signal,
    );
    expect(mismatch).toMatchObject({ state: 'failed', receipt: { connectionState: 'mismatch' } });
    expect(posts).toHaveLength(0);
    const published = await runBrowserJob(job('browser_publish'), browserConfig(), client, signal);
    expect(published).toMatchObject({ state: 'submitted', identity: 'xhs-123' });
    expect(posts).toEqual([{ title: '浏览器验证笔记', body: '浏览器验证的正文内容', files: 1 }]);
    expect(stages).toContain('publishing');
  }, 90000);

  it('核验只认标题、时间、正文都一致且已发布的唯一条目', async () => {
    const signal = new AbortController().signal;
    const verified = await runBrowserJob(
      job('browser_verify', { submittedAt: new Date(Date.now() - 30000).toISOString() }),
      browserConfig(),
      client,
      signal,
    );
    expect(verified).toMatchObject({ state: 'published', url: `${origin}/explore/note-1` });
    const tooOld = await runBrowserJob(
      job('browser_verify', { submittedAt: new Date(Date.now() + 600000).toISOString() }),
      browserConfig(),
      client,
      signal,
    );
    expect(tooOld.state).toBe('not_found');
  }, 90000);
});
