import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { recordUsage } from '@one-creator/server/usage';
import { buildApp } from '../apps/api/src/app.js';

let app: FastifyInstance, db: Database, folder: string, admin: string, editor: string, viewer: string;
let accountA: string, accountB: string, docA: string, docB: string, memberId: string, workspaceId: string;
const password = 'Access-Password-2026';
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, auth = admin) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: auth?.startsWith('oc_')
      ? { authorization: `Bearer ${auth}` }
      : { cookie: auth ?? '', 'x-creator-client': 'web' },
  });
const cookie = (response: Awaited<ReturnType<typeof app.inject>>) =>
  response.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
beforeAll(async () => {
  await mkdir('.data/test-temp', { recursive: true });
  folder = await mkdtemp(path.resolve('.data/test-temp/access-'));
  const config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'cc'.repeat(32),
    production: false,
    workerMode: 'inline',
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await call('POST', '/api/auth/setup', { username: 'owner', password, name: '管理员' });
  expect(setup.statusCode).toBe(201);
  admin = cookie(setup);
  workspaceId = setup.json().workspaceId;
  accountA = (await call('POST', '/api/accounts', { name: '授权账号 A', platform: 'wechat' })).json().id;
  accountB = (await call('POST', '/api/accounts', { name: '私有账号 B', platform: 'wechat' })).json().id;
  docA = (
    await call('POST', '/api/documents', { title: 'A 内容', body: 'A 的正文', accountId: accountA })
  ).json().id;
  docB = (
    await call('POST', '/api/documents', { title: 'B 内容', body: 'B 的私有正文', accountId: accountB })
  ).json().id;
  await call('POST', '/api/materials', { title: 'B 专用资料', body: '不能泄漏', accountId: accountB });
  const member = await call('POST', '/api/members', {
    username: 'writer',
    password,
    name: '编辑',
    role: 'editor',
    accountIds: [accountA],
  });
  expect(member.statusCode, member.body).toBe(201);
  memberId = member.json().id;
  await call('POST', '/api/members', {
    username: 'reader',
    password,
    name: '只读',
    role: 'viewer',
    accountIds: [accountA],
  });
  editor = cookie(await call('POST', '/api/auth/login', { username: 'writer', password }));
  viewer = cookie(await call('POST', '/api/auth/login', { username: 'reader', password }));
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});
it('按账号限制列表、数量和单条读取，服务端拒绝只读成员和越界写入', async () => {
  const accounts = await call('GET', '/api/accounts', undefined, editor);
  expect(accounts.json().total).toBe(1);
  expect(accounts.body).not.toContain('私有账号 B');
  expect((await call('GET', `/api/documents/${docB}`, undefined, editor)).statusCode).toBe(404);
  expect((await call('GET', '/api/documents', undefined, editor)).json().total).toBe(1);
  expect((await call('GET', '/api/materials', undefined, editor)).json().total).toBe(0);
  expect((await call('GET', '/api/dashboard', undefined, editor)).json().counts.documents).toBe(1);
  expect(
    (await call('POST', '/api/documents', { title: '越界', accountId: accountB }, editor)).statusCode,
  ).toBe(404);
  expect((await call('POST', '/api/ideas', { title: '只读不能写' }, viewer)).statusCode).toBe(403);
  expect((await call('GET', '/api/members', undefined, editor)).statusCode).toBe(403);
  expect((await call('GET', '/api/settings/backup', undefined, viewer)).statusCode).toBe(403);
});
it('访问令牌遵守独立权限、授权账号、到期和撤销，v1 接口复用业务校验', async () => {
  const issued = await call('POST', '/api/tokens', {
    name: '只读集成',
    scopes: ['content:read'],
    accountIds: [accountA],
    days: 1,
  });
  expect(issued.statusCode).toBe(201);
  const token = issued.json().token;
  expect((await call('GET', '/api/v1/accounts', undefined, token)).json().total).toBe(1);
  expect((await call('GET', `/api/v1/documents/${docB}`, undefined, token)).statusCode).toBe(404);
  expect((await call('POST', '/api/v1/ideas', { title: '越权写' }, token)).statusCode).toBe(403);
  expect((await call('GET', '/api/v1/tokens', undefined, token)).statusCode).toBe(403);
  expect((await call('GET', '/api/tokens')).body).not.toContain(token);
  await call('DELETE', `/api/tokens/${issued.json().id}`);
  expect((await call('GET', '/api/v1/accounts', undefined, token)).statusCode).toBe(401);
});
it('通知按成员已读且按授权账号可见，同一发布事件不重复通知', async () => {
  const created = await call('POST', '/api/publishing', { documentId: docA, expectedRevision: 1 }, admin);
  // Publishing requires an idempotency key; use inject explicitly for this action.
  expect(created.statusCode).toBe(400);
  const publish = await app.inject({
    method: 'POST',
    url: '/api/publishing',
    payload: { documentId: docA, expectedRevision: 1 },
    headers: { cookie: admin, 'x-creator-client': 'web', 'idempotency-key': id() },
  });
  expect(publish.statusCode).toBe(201);
  const notices = (await call('GET', '/api/notifications', undefined, editor)).json();
  expect(notices.unread).toBe(1);
  await call('POST', '/api/notifications/read', { ids: [notices.items[0].id] }, editor);
  expect((await call('GET', '/api/notifications', undefined, editor)).json().unread).toBe(0);
  expect((await call('GET', '/api/notifications', undefined, viewer)).json().unread).toBe(1);
  await call('PUT', `/api/publishing/${publish.json().id}`, { scheduledAt: null, timezone: 'Asia/Shanghai' });
  expect((await call('GET', '/api/notifications')).json().total).toBe(1);
});
it('用量区分报告值、估算与未知费用，价格变更不改写历史账单', async () => {
  await call('POST', '/api/model-prices', {
    baseUrl: 'https://example.com/v1',
    model: 'priced',
    currency: 'CNY',
    inputPerMillion: 2,
    outputPerMillion: 4,
  });
  await recordUsage(db, {
    workspaceId,
    accountId: accountA,
    jobId: id(),
    callKey: 'report-1',
    title: '报告用量',
    capability: 'text',
    baseUrl: 'https://example.com/v1',
    model: 'priced',
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  });
  await recordUsage(db, {
    workspaceId,
    accountId: accountB,
    callKey: 'unknown-1',
    title: '未知费用',
    capability: 'text',
    baseUrl: 'https://elsewhere.example',
    model: 'unknown',
    status: 'unknown',
  });
  await call('POST', '/api/model-prices', {
    baseUrl: 'https://example.com/v1',
    model: 'priced',
    currency: 'CNY',
    inputPerMillion: 20,
    outputPerMillion: 40,
  });
  const usage = (await call('GET', '/api/usage', undefined, editor)).json();
  expect(usage.total).toBe(1);
  expect(usage.items[0].usageSource).toBe('reported');
  expect(Number(usage.items[0].cost)).toBeCloseTo(0.004);
  const all = (await call('GET', '/api/usage')).json();
  expect(all.items.find((entry: { callKey: string }) => entry.callKey === 'unknown-1').cost).toBeNull();
});
it('停用成员会立即撤销会话，不能移除最后一名管理员', async () => {
  const owner = (await call('GET', '/api/members'))
    .json()
    .items.find((user: { username: string }) => user.username === 'owner');
  expect(
    (
      await call('PUT', `/api/members/${owner.id}`, {
        name: owner.name,
        role: 'viewer',
        active: true,
        accountIds: null,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await call('PUT', `/api/members/${memberId}`, {
        name: '编辑',
        role: 'editor',
        active: false,
        accountIds: [accountA],
      })
    ).statusCode,
  ).toBe(200);
  expect((await call('GET', `/api/documents/${docA}`, undefined, editor)).statusCode).toBe(401);
  expect((await call('POST', '/api/auth/login', { username: 'writer', password })).statusCode).toBe(401);
});
