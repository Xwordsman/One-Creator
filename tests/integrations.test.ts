import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import {
  documentSchema,
  emptyPreferences,
  type Account,
  type Asset,
  type AutomationJob,
  type ContentDocument,
  type PublishTask,
  type WorkerJob,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { migrate, openDatabase, type Database } from '@one-creator/server/database';
import { migrations } from '@one-creator/server/migrations';
import { id, insert } from '@one-creator/server/records';
import { hashPassword } from '@one-creator/server/crypto';
import { startWorker } from '@one-creator/server/jobs';
import { deliverWebhooks } from '@one-creator/server/webhooks';
import { createBackup, restoreBackup } from '@one-creator/server/backup';
import { buildApp } from '../apps/api/src/app.js';
import { createWechatMock, mockAppId, mockAppSecret } from './helpers/wechat.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Hit {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
interface WebhookPayload {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}
interface Delivery {
  id: string;
  eventId: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}
interface ToolResult {
  isError: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

let db: Database;
let app: FastifyInstance;
let config: AppConfig;
let folder: string;
let cookie: string;
let editorCookie: string;
let viewerCookie: string;
let workspaceId: string;
let account: Account;
let otherAccount: Account;
let browserAccount: Account;
let cover: Asset;
let nodeId: string;
let nodeToken: string;
let receiverOrigin: string;
let blockedOrigin: string;
let blockedHits = 0;
let queuedPublishJob: AutomationJob;
const executorInstance = randomUUID();
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const wechat = createWechatMock();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

/** Local webhook receiver: path decides the answer, so each subscription exercises one failure mode. */
const received: Hit[] = [];
const attemptsByPath = new Map<string, number>();
const receiver: Server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', (part: Buffer) => parts.push(part));
  req.on('end', () => {
    const target = req.url ?? '/';
    const attempt = (attemptsByPath.get(target) ?? 0) + 1;
    attemptsByPath.set(target, attempt);
    received.push({
      method: req.method ?? '',
      path: target,
      headers: req.headers,
      body: Buffer.concat(parts).toString('utf8'),
    });
    const status = target.includes('/gone')
      ? 410
      : target.includes('/fail')
        ? 500
        : target.includes('/recover') && attempt <= 2
          ? 503
          : 200;
    res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
  });
});
/** A second local service that is not in INTEGRATION_ALLOWED_ORIGINS; it must never be reached. */
const blocked: Server = createServer((_req, res) => {
  blockedHits++;
  res.writeHead(200).end('{}');
});
const hits = (target: string) => received.filter((hit) => hit.path === target);
const payload = (hit: Hit) => JSON.parse(hit.body) as WebhookPayload;
function verifies(hit: Hit, secret: string, body = hit.body) {
  const timestamp = String(hit.headers['x-onecreator-timestamp']);
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
  );
  const actual = Buffer.from(String(hit.headers['x-onecreator-signature']));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const request = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { cookie, 'x-creator-client': 'web', ...headers },
  });
/** API token callers send only the bearer header: no cookie and no web client header. */
const bearer = (
  token: string,
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
const executor = (target: FastifyInstance, token: string, url: string, payload: unknown = {}) =>
  target.inject({
    method: 'POST',
    url: `/api/executor${url}`,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}`, 'x-executor-instance': executorInstance },
  });
async function token(scopes: string[], extra: Record<string, unknown> = {}) {
  const created = await request('POST', '/api/tokens', {
    name: `令牌 ${scopes.join(' ')}`,
    scopes,
    ...extra,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string; token: string; expiresAt: string }>();
}
async function document(accountId: string | null, title: string, extra: Record<string, unknown> = {}) {
  const created = await request('POST', '/api/documents', {
    title,
    body: `${title}的正文。`,
    accountId,
    ...extra,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<ContentDocument>();
}
async function plan(doc: ContentDocument) {
  const created = await request(
    'POST',
    '/api/publishing',
    { documentId: doc.id, expectedRevision: doc.revision },
    { 'idempotency-key': id() },
  );
  expect(created.statusCode, created.body).toBe(201);
  return created.json<PublishTask>();
}
async function upload(name: string, bytes: Buffer) {
  const boundary = 'integrations-upload';
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Asset>();
}
async function login(target: FastifyInstance, username: string, password: string) {
  const signed = await target.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-creator-client': 'web' },
    payload: { username, password },
  });
  expect(signed.statusCode, signed.body).toBe(200);
  return signed.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
}
async function cancelQueuedJobs() {
  for (const job of await db.rows<{ id: string }>(`SELECT id FROM jobs WHERE status='queued'`))
    expect((await request('POST', `/api/jobs/${job.id}/cancel`, {})).statusCode).toBe(200);
}
/** Runs the delivery worker the way the inline worker does, until no due delivery remains. */
async function drain(target = db, settings = config) {
  for (let round = 0; round < 200; round++) {
    await deliverWebhooks(target, settings);
    const [{ due }] = await target.rows<{ due: number }>(
      `SELECT count(*)::int AS due FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d."subscriptionId" WHERE d.status='queued' AND d."nextAt"<=now() AND s.enabled=true`,
    );
    if (!due) return;
  }
  throw new Error('webhook deliveries did not settle');
}
/** Retries are scheduled minutes apart; the test moves the clock forward instead of sleeping. */
async function settleRetries(maxRounds = 10) {
  for (let round = 1; round <= maxRounds; round++) {
    await drain();
    const [{ pending }] = await db.rows<{ pending: number }>(
      `SELECT count(*)::int AS pending FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d."subscriptionId" WHERE d.status='queued' AND s.enabled=true`,
    );
    if (!pending) return round;
    await db.rows(`UPDATE webhook_deliveries SET "nextAt"=now() WHERE status='queued'`);
  }
  throw new Error('webhook retries never stopped');
}
async function subscribe(name: string, url: string, events: string[]) {
  const created = await request('POST', '/api/webhooks', { name, url, events });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string; secret: string; events: string[]; enabled: boolean }>();
}
async function deliveries(subscriptionId: string, target = app, session = cookie) {
  const response = await target.inject({
    method: 'GET',
    url: `/api/webhooks/${subscriptionId}/deliveries`,
    headers: { cookie: session },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: Delivery[] }>().items;
}
const rpc = (body: unknown, auth: { token?: string; cookie?: string } = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/mcp',
    payload: body as Record<string, unknown>,
    headers: auth.token
      ? { authorization: `Bearer ${auth.token}` }
      : auth.cookie
        ? { cookie: auth.cookie, 'x-creator-client': 'web' }
        : { 'x-creator-client': 'web' },
  });
async function tool(
  auth: { token?: string; cookie?: string },
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(
    { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
    auth,
  );
  expect(response.statusCode, response.body).toBe(200);
  const message = response.json<{ result?: ToolResult; error?: unknown }>();
  expect(message.error, response.body).toBeUndefined();
  return message.result!;
}
async function connectBrowser(target: Account, identity: string) {
  const registered = await request('POST', '/api/nodes', {
    name: '集成测试节点',
    accountIds: [target.id],
    platforms: [target.platform],
  });
  expect(registered.statusCode, registered.body).toBe(201);
  nodeId = registered.json().node.id;
  nodeToken = registered.json().token;
  expect((await request('PUT', `/api/accounts/${target.id}/browser-connection`, { nodeId })).statusCode).toBe(
    200,
  );
  expect(
    (await request('POST', `/api/accounts/${target.id}/browser-login`, {}, { 'idempotency-key': id() }))
      .statusCode,
  ).toBe(202);
  const { job } = (await executor(app, nodeToken, '/poll', { version: 'test' })).json();
  expect(job.kind).toBe('browser_login');
  const result = await executor(app, nodeToken, `/jobs/${job.id}/result`, {
    leaseToken: job.leaseToken,
    result: { state: 'connected', identity },
  });
  expect(result.statusCode, result.body).toBe(200);
  expect((await request('GET', `/api/accounts/${target.id}/browser-connection`)).json().status).toBe(
    'connected',
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => blocked.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  blockedOrigin = `http://127.0.0.1:${(blocked.address() as { port: number }).port}`;
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'integrations-'));
  config = await loadConfig({
    dataDir: path.join(folder, 'source'),
    encryptionKey: 'fe'.repeat(32),
    production: false,
    workerMode: 'inline',
    integrationOrigins: [receiverOrigin],
    wechatApiBase: await wechat.listen(),
    wechatTimeoutMs: 3000,
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'integrator', name: '集成验证', password: 'Integration-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  workspaceId = setup.json().workspaceId;
  for (const [username, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ] as const)
    expect(
      (
        await request('POST', '/api/members', {
          username,
          password: `${username}-Integration-Password`,
          name: username,
          role,
        })
      ).statusCode,
    ).toBe(201);
  editorCookie = await login(app, 'editor', 'editor-Integration-Password');
  viewerCookie = await login(app, 'viewer', 'viewer-Integration-Password');
  // AI jobs only need a configured model to be accepted; tests cancel them before any worker runs.
  const model = await request('PUT', '/api/settings/model', {
    name: '本地占位模型',
    baseUrl: `${receiverOrigin}/v1`,
    model: 'placeholder',
    apiKey: 'placeholder-key',
  });
  expect(model.statusCode, model.body).toBe(200);
  account = (
    await request('POST', '/api/accounts', { name: '未连接公众号', platform: 'wechat' })
  ).json<Account>();
  otherAccount = (
    await request('POST', '/api/accounts', { name: '其他团队的头条号', platform: 'toutiao' })
  ).json<Account>();
  browserAccount = (
    await request('POST', '/api/accounts', {
      name: '小红书节点账号',
      platform: 'xiaohongshu',
      handle: 'xhs-integration',
    })
  ).json<Account>();
  cover = await upload('cover.png', png);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  await wechat.close();
  receiver.closeAllConnections();
  blocked.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await new Promise<void>((resolve) => blocked.close(() => resolve()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('EXT-01 REST API 与访问令牌', () => {
  it('令牌只在创建时显示一次，列表不回显；撤销或过期后立即 401', async () => {
    const reader = await token(['content:read']);
    expect(reader.token).toMatch(/^oc_[A-Za-z0-9_-]{40,}$/);
    expect(Date.parse(reader.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86400000);
    const accounts = await bearer(reader.token, 'GET', '/api/v1/accounts');
    expect(accounts.statusCode, accounts.body).toBe(200);
    expect(accounts.json().items.map((item: Account) => item.id)).toEqual(
      expect.arrayContaining([account.id, otherAccount.id]),
    );
    const listed = await request('GET', '/api/tokens');
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(reader.token);
    expect(listed.body).not.toContain('"hash"');
    const record = listed.json().items.find((item: { id: string }) => item.id === reader.id);
    expect(record).toMatchObject({
      prefix: reader.token.slice(0, 12),
      scopes: ['content:read'],
      revokedAt: null,
    });
    expect(record.lastUsedAt).toBeTruthy();
    expect(Object.keys(record).sort()).toEqual([
      'accountIds',
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'revokedAt',
      'scopes',
    ]);
    const [stored] = await db.rows<{ hash: string }>('SELECT hash FROM api_tokens WHERE id=$1', [reader.id]);
    expect(stored.hash).toMatch(/^[\da-f]{64}$/);

    expect((await request('DELETE', `/api/tokens/${reader.id}`)).statusCode).toBe(200);
    for (const url of ['/api/accounts', '/api/v1/accounts', '/api/v1/openapi.json']) {
      const revoked = await bearer(reader.token, 'GET', url);
      expect(revoked.statusCode).toBe(401);
      expect(revoked.json().code).toBe('UNAUTHENTICATED');
    }
    const afterRevoke = (await request('GET', '/api/tokens'))
      .json()
      .items.find((item: { id: string }) => item.id === reader.id);
    expect(afterRevoke.revokedAt).toBeTruthy();
    expect(JSON.stringify(afterRevoke)).not.toContain(reader.token);

    const expiring = await token(['content:read'], { days: 1 });
    expect((await bearer(expiring.token, 'GET', '/api/accounts')).statusCode).toBe(200);
    await db.rows(`UPDATE api_tokens SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [expiring.id]);
    expect((await bearer(expiring.token, 'GET', '/api/accounts')).statusCode).toBe(401);
    // A malformed or unknown bearer never falls back to the session cookie.
    for (const authorization of [
      'Bearer oc_not-a-real-token-value-000000',
      'Bearer something-else',
      'Basic abc',
    ])
      expect(
        (await app.inject({ method: 'GET', url: '/api/accounts', headers: { authorization, cookie } }))
          .statusCode,
      ).toBe(401);
  });

  it('OpenAPI 3.1 文档只列出真实存在的 /api/v1 路由，v1 前缀改写到同一业务接口', async () => {
    const reader = await token(['content:read']);
    const response = await bearer(reader.token, 'GET', '/api/v1/openapi.json');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const spec = response.json<{
      openapi: string;
      info: { title: string; version: string };
      security: Record<string, string[]>[];
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
      paths: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            parameters?: { in: string; name: string; required?: boolean; schema: unknown }[];
            requestBody?: {
              content: Record<string, { schema: { type?: string; properties?: Record<string, unknown> } }>;
            };
            responses: Record<string, { description: string }>;
          }
        >
      >;
    }>();
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    for (const requirement of spec.security)
      for (const name of Object.keys(requirement))
        expect(spec.components.securitySchemes[name]).toEqual({ type: 'http', scheme: 'bearer' });
    const operations = Object.entries(spec.paths).flatMap(([route, item]) =>
      Object.entries(item).map(([method, operation]) => ({ route, method, operation })),
    );
    expect(operations.length).toBeGreaterThanOrEqual(13);
    for (const { route, method, operation } of operations) {
      expect(route).toMatch(/^\/api\/v1\//);
      expect(['get', 'post', 'put', 'delete', 'patch']).toContain(method);
      expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      for (const [code, value] of Object.entries(operation.responses)) {
        expect(code).toMatch(/^[1-5]\d\d$/);
        expect(value.description).toBeTruthy();
      }
      const templated = [...route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const name of templated)
        expect(
          operation.parameters?.some(
            (parameter) => parameter.in === 'path' && parameter.name === name && parameter.required,
          ),
        ).toBe(true);
      for (const parameter of operation.parameters ?? [])
        expect(['query', 'header', 'path', 'cookie']).toContain(parameter.in);
      // Every documented path must be served by a registered route once /api/v1 is rewritten.
      const served = route.replace(/^\/api\/v1\//, '/api/').replace(/\{(\w+)\}/g, ':$1');
      expect(app.hasRoute({ method: method.toUpperCase() as 'GET', url: served }), `${method} ${route}`).toBe(
        true,
      );
    }
    for (const resource of ['accounts', 'ideas', 'materials', 'documents', 'jobs', 'publishing']) {
      expect(spec.paths[`/api/v1/${resource}`]?.get, resource).toBeTruthy();
      expect(spec.paths[`/api/v1/${resource}`]?.post, resource).toBeTruthy();
    }
    expect(spec.paths['/api/v1/jobs/{id}']?.get).toBeTruthy();
    for (const resource of ['jobs', 'publishing'])
      expect(spec.paths[`/api/v1/${resource}`].post.parameters).toEqual([
        expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
      ]);
    const documentBody = spec.paths['/api/v1/documents'].post.requestBody!.content['application/json'].schema;
    expect(documentBody.type).toBe('object');
    expect(Object.keys(documentBody.properties ?? {})).toEqual(
      expect.arrayContaining(Object.keys(documentSchema.shape)),
    );
    expect((await bearer(reader.token, 'GET', '/api/v1/accounts?limit=500')).body).toBe(
      (await bearer(reader.token, 'GET', '/api/accounts?limit=500')).body,
    );
    expect((await bearer(reader.token, 'GET', '/api/v1/v1/accounts')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).statusCode).toBe(401);
  });

  it('列表分页结构一致，错误统一为 code / message 结构', async () => {
    const editorToken = await token(['content:read', 'content:write', 'ai:run', 'publish:write']);
    for (const title of ['分页文稿甲', '分页文稿乙']) {
      const doc = await document(account.id, title);
      expect(
        (
          await bearer(
            editorToken.token,
            'POST',
            '/api/v1/jobs',
            { documentId: doc.id, expectedRevision: doc.revision, kind: 'outline' },
            { 'idempotency-key': id() },
          )
        ).statusCode,
      ).toBe(202);
      expect(
        (
          await bearer(
            editorToken.token,
            'POST',
            '/api/v1/publishing',
            { documentId: doc.id, expectedRevision: doc.revision },
            { 'idempotency-key': id() },
          )
        ).statusCode,
      ).toBe(201);
    }
    await cancelQueuedJobs();
    for (const title of ['分页灵感甲', '分页灵感乙'])
      expect((await bearer(editorToken.token, 'POST', '/api/v1/ideas', { title })).statusCode).toBe(201);
    for (const title of ['分页素材甲', '分页素材乙'])
      expect(
        (await bearer(editorToken.token, 'POST', '/api/v1/materials', { title, body: `${title}正文` }))
          .statusCode,
      ).toBe(201);
    for (const resource of ['accounts', 'documents', 'ideas', 'materials', 'jobs', 'publishing']) {
      const all = await bearer(editorToken.token, 'GET', `/api/v1/${resource}?limit=500`);
      expect(all.statusCode, `${resource}: ${all.body}`).toBe(200);
      const full = all.json<{ items: { id: string }[]; total: number; limit: number; offset: number }>();
      expect(Object.keys(full).sort(), resource).toEqual(['items', 'limit', 'offset', 'total']);
      expect(full.total, resource).toBeGreaterThanOrEqual(2);
      expect(full.items).toHaveLength(full.total);
      expect(full).toMatchObject({ limit: 500, offset: 0 });
      const page = (await bearer(editorToken.token, 'GET', `/api/v1/${resource}?limit=1&offset=1`)).json<
        typeof full
      >();
      expect(page, resource).toMatchObject({ total: full.total, limit: 1, offset: 1 });
      expect(
        page.items.map((item) => item.id),
        resource,
      ).toEqual([full.items[1].id]);
      for (const query of ['limit=0', 'limit=501', 'offset=-1', 'limit=abc']) {
        const invalid = await bearer(editorToken.token, 'GET', `/api/v1/${resource}?${query}`);
        expect(invalid.statusCode, `${resource}?${query}`).toBe(400);
        expect(invalid.json()).toMatchObject({
          code: 'VALIDATION_ERROR',
          message: expect.any(String),
          fields: expect.any(Object),
        });
      }
    }
    const failures = [
      [await app.inject({ method: 'GET', url: '/api/v1/documents' }), 401, 'UNAUTHENTICATED'],
      [await bearer(editorToken.token, 'GET', `/api/v1/documents/${randomUUID()}`), 404, 'NOT_FOUND'],
      [await bearer(editorToken.token, 'GET', '/api/v1/documents/not-a-uuid'), 400, 'VALIDATION_ERROR'],
      [await bearer(editorToken.token, 'POST', '/api/v1/documents', { title: '' }), 400, 'VALIDATION_ERROR'],
      [await bearer(editorToken.token, 'GET', '/api/v1/tokens'), 403, 'TOKEN_SCOPE'],
      [
        await app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          payload: { title: '无客户端标识' },
          headers: { cookie },
        }),
        403,
        'CLIENT_HEADER_REQUIRED',
      ],
    ] as const;
    for (const [response, status, code] of failures) {
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ code, message: expect.any(String) });
      expect(response.json().message.length).toBeGreaterThan(0);
    }
  });

  it('令牌权限逐项强制执行，任何路径写法都不能绕过', async () => {
    const reader = await token(['content:read']);
    const writer = await token(['content:read', 'content:write']);
    const runner = await token(['content:read', 'ai:run']);
    const denied = (response: Awaited<ReturnType<typeof bearer>>, scope: string) => {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ code: 'TOKEN_SCOPE' });
      expect(response.json().message).toContain(scope);
    };
    denied(
      await bearer(reader.token, 'POST', '/api/v1/documents', { title: '只读令牌写入' }),
      'content:write',
    );
    const doc = await document(account.id, '权限检查文稿');
    denied(
      await bearer(reader.token, 'PUT', `/api/v1/documents/${doc.id}`, {
        title: '改标题',
        expectedRevision: doc.revision,
      }),
      'content:write',
    );
    denied(await bearer(reader.token, 'POST', '/api/v1/ideas', { title: '只读灵感' }), 'content:write');
    denied(
      await bearer(reader.token, 'POST', '/api/tokens', { name: '提权', scopes: ['settings:admin'] }),
      'settings:admin',
    );
    denied(await bearer(reader.token, 'GET', '/api/tokens'), 'settings:admin');
    denied(
      await bearer(writer.token, 'POST', '/api/webhooks', {
        name: '越权订阅',
        url: `${receiverOrigin}/x`,
        events: ['content.*'],
      }),
      'settings:admin',
    );
    denied(
      await bearer(
        writer.token,
        'POST',
        '/api/v1/jobs',
        { documentId: doc.id, expectedRevision: doc.revision, kind: 'outline' },
        { 'idempotency-key': id() },
      ),
      'ai:run',
    );
    denied(
      await bearer(
        runner.token,
        'POST',
        '/api/v1/publishing',
        { documentId: doc.id, expectedRevision: doc.revision },
        { 'idempotency-key': id() },
      ),
      'publish:write',
    );
    for (const kind of ['wechat_publish', 'browser_publish']) {
      const attempt = await bearer(
        runner.token,
        'POST',
        '/api/v1/automation',
        { kind, accountId: account.id, data: { publishTaskId: randomUUID(), nodeId: randomUUID() } },
        { 'idempotency-key': id() },
      );
      denied(attempt, 'publish:write');
    }
    expect(
      await db.rows(`SELECT id FROM automation_jobs WHERE kind IN ('wechat_publish','browser_publish')`),
    ).toEqual([]);
    expect(
      (await bearer(writer.token, 'POST', '/api/v1/documents', { title: '令牌写入', body: '正文' }))
        .statusCode,
    ).toBe(201);
    const job = await bearer(
      runner.token,
      'POST',
      '/api/v1/jobs',
      { documentId: doc.id, expectedRevision: doc.revision, kind: 'outline' },
      { 'idempotency-key': id() },
    );
    expect(job.statusCode, job.body).toBe(202);
    expect((await bearer(runner.token, 'POST', `/api/v1/jobs/${job.json().id}/cancel`, {})).statusCode).toBe(
      200,
    );

    // The router decodes percent-encoded paths; permissions must follow the route that actually runs.
    const tokensBefore = (await db.rows('SELECT id FROM api_tokens')).length;
    denied(
      await bearer(writer.token, 'POST', '/api/%74okens', {
        name: '编码路径提权',
        scopes: ['settings:admin'],
      }),
      'settings:admin',
    );
    denied(await bearer(reader.token, 'GET', '/api/%74okens'), 'settings:admin');
    expect((await db.rows('SELECT id FROM api_tokens')).length).toBe(tokensBefore);
    denied(
      await bearer(reader.token, 'POST', '/api/%64ocuments', { title: '编码路径写入' }),
      'content:write',
    );
    denied(
      await bearer(
        writer.token,
        'POST',
        '/api/%6aobs',
        { documentId: doc.id, expectedRevision: doc.revision, kind: 'outline' },
        { 'idempotency-key': id() },
      ),
      'ai:run',
    );
    denied(
      await bearer(
        runner.token,
        'POST',
        '/api/%70ublishing',
        { documentId: doc.id, expectedRevision: doc.revision },
        { 'idempotency-key': id() },
      ),
      'publish:write',
    );
    for (const target of ['/api/members', '/api/%6dembers']) {
      const escalation = await app.inject({
        method: 'POST',
        url: target,
        payload: { username: 'sneaky', password: 'Sneaky-Admin-Password', name: '提权', role: 'admin' },
        headers: { cookie: editorCookie, 'x-creator-client': 'web' },
      });
      expect(escalation.statusCode, `${target}: ${escalation.body}`).toBe(403);
      expect(escalation.json().code).toBe('ADMIN_REQUIRED');
    }
    expect(await db.rows(`SELECT id FROM users WHERE username='sneaky'`)).toEqual([]);
    const viewerWrite = await app.inject({
      method: 'POST',
      url: '/api/%64ocuments',
      payload: { title: '只读成员写入' },
      headers: { cookie: viewerCookie, 'x-creator-client': 'web' },
    });
    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json().code).toBe('READ_ONLY');
    for (const target of ['/api/%64ocuments', '/%61pi/documents']) {
      const noClient = await app.inject({
        method: 'POST',
        url: target,
        payload: { title: '缺少客户端标识' },
        headers: { cookie },
      });
      expect(noClient.statusCode, target).toBe(403);
      expect(noClient.json().code, target).toBe('CLIENT_HEADER_REQUIRED');
    }
    expect(
      (
        await db.rows(
          `SELECT id FROM documents WHERE title IN ('编码路径写入','只读成员写入','缺少客户端标识')`,
        )
      ).length,
    ).toBe(0);
    expect(
      (await bearer(writer.token, 'POST', '/api/%64ocuments', { title: '编码路径正常写入', body: '正文' }))
        .statusCode,
    ).toBe(201);
  });

  it('异步任务查询与幂等键：相同请求复用同一任务，不同内容冲突，缺少幂等键被拒绝', async () => {
    const runner = await token(['content:read', 'ai:run', 'publish:write']);
    const doc = await document(account.id, '幂等任务文稿');
    const body = {
      documentId: doc.id,
      expectedRevision: doc.revision,
      kind: 'titles',
      instruction: '给出三个标题',
    };
    const missing = await bearer(runner.token, 'POST', '/api/v1/jobs', body);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      (await bearer(runner.token, 'POST', '/api/v1/jobs', body, { 'idempotency-key': 'short' })).statusCode,
    ).toBe(400);
    const key = `job-${randomUUID()}`;
    const first = await bearer(runner.token, 'POST', '/api/v1/jobs', body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ status: 'queued', kind: 'titles', documentId: doc.id });
    const again = await bearer(runner.token, 'POST', '/api/v1/jobs', body, { 'idempotency-key': key });
    expect(again.statusCode).toBe(202);
    expect(again.json().id).toBe(first.json().id);
    const conflict = await bearer(
      runner.token,
      'POST',
      '/api/v1/jobs',
      { ...body, instruction: '换一个指令' },
      { 'idempotency-key': key },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'CONFLICT', message: expect.any(String) });
    expect((await db.rows('SELECT id FROM jobs WHERE "idempotencyKey"=$1', [key])).length).toBe(1);
    const queried = await bearer(runner.token, 'GET', `/api/v1/jobs/${first.json().id}`);
    expect(queried.statusCode).toBe(200);
    expect(queried.json<WorkerJob>()).toMatchObject({
      id: first.json().id,
      status: 'queued',
      stage: 'queued',
    });
    const listed = (await bearer(runner.token, 'GET', `/api/v1/jobs?documentId=${doc.id}`)).json();
    expect(listed.items.map((item: WorkerJob) => [item.id, item.status])).toEqual([
      [first.json().id, 'queued'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(
      (await bearer(runner.token, 'POST', `/api/v1/jobs/${first.json().id}/cancel`, {})).statusCode,
    ).toBe(200);
    expect((await bearer(runner.token, 'GET', `/api/v1/jobs/${first.json().id}`)).json().status).toBe(
      'cancelled',
    );

    const publishBody = { documentId: doc.id, expectedRevision: doc.revision };
    expect((await bearer(runner.token, 'POST', '/api/v1/publishing', publishBody)).statusCode).toBe(400);
    const planKey = `plan-${randomUUID()}`;
    const planned = await bearer(runner.token, 'POST', '/api/v1/publishing', publishBody, {
      'idempotency-key': planKey,
    });
    expect(planned.statusCode, planned.body).toBe(201);
    expect(
      (
        await bearer(runner.token, 'POST', '/api/v1/publishing', publishBody, { 'idempotency-key': planKey })
      ).json().id,
    ).toBe(planned.json().id);
    expect((await db.rows('SELECT id FROM publish_tasks WHERE "idempotencyKey"=$1', [planKey])).length).toBe(
      1,
    );
  });

  it('缺少 publish:write 的令牌不能创建或重试 wechat_publish / browser_publish 任务', async () => {
    await connectBrowser(browserAccount, 'xhs-integration');
    const draft = await plan(await document(browserAccount.id, '令牌发布检查'));
    const runner = await token(['content:read', 'ai:run']);
    const publisher = await token(['content:read', 'ai:run', 'publish:write']);
    const body = {
      kind: 'browser_publish',
      accountId: browserAccount.id,
      data: { publishTaskId: draft.id, nodeId },
    };
    const refused = await bearer(runner.token, 'POST', '/api/v1/automation', body, {
      'idempotency-key': id(),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('TOKEN_SCOPE');
    const created = await bearer(publisher.token, 'POST', '/api/v1/automation', body, {
      'idempotency-key': id(),
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json<AutomationJob>().status).toBe('queued');
    expect(
      (await bearer(runner.token, 'POST', `/api/v1/automation/${created.json().id}/cancel`, {})).statusCode,
    ).toBe(200);
    // A retry re-creates the same platform write, so it needs the same scope as the first request.
    const retried = await bearer(
      runner.token,
      'POST',
      `/api/v1/automation/${created.json().id}/retry`,
      {},
      { 'idempotency-key': id() },
    );
    expect(retried.statusCode, retried.body).toBe(403);
    expect(retried.json().code).toBe('TOKEN_SCOPE');
    expect(
      await db.rows(`SELECT id FROM automation_jobs WHERE "publishTaskId"=$1 AND status='queued'`, [
        draft.id,
      ]),
    ).toEqual([]);
    const allowed = await bearer(
      publisher.token,
      'POST',
      `/api/v1/automation/${created.json().id}/retry`,
      {},
      { 'idempotency-key': id() },
    );
    expect(allowed.statusCode, allowed.body).toBe(202);
    queuedPublishJob = allowed.json<AutomationJob>();
    expect(queuedPublishJob).toMatchObject({
      kind: 'browser_publish',
      status: 'queued',
      parentId: created.json().id,
    });
  });
});

describe('EXT-02 Webhook 事件', () => {
  let contentHook: Awaited<ReturnType<typeof subscribe>>;
  let allContentHook: Awaited<ReturnType<typeof subscribe>>;
  let taskHook: Awaited<ReturnType<typeof subscribe>>;

  it('密钥只返回一次；按订阅事件过滤；签名可验证；事件 ID 稳定可去重', async () => {
    for (const invalid of [
      { name: '错误事件', url: `${receiverOrigin}/x`, events: ['content.Created'] },
      { name: '未知分组', url: `${receiverOrigin}/x`, events: ['billing.*'] },
      { name: '空事件', url: `${receiverOrigin}/x`, events: [] },
      { name: '非 HTTP', url: 'ftp://127.0.0.1/x', events: ['content.*'] },
      {
        name: '内嵌凭据',
        url: `http://user:pass@127.0.0.1:${new URL(receiverOrigin).port}/x`,
        events: ['content.*'],
      },
    ]) {
      const rejected = await request('POST', '/api/webhooks', invalid);
      expect(rejected.statusCode, `${invalid.name}: ${rejected.body}`).toBe(400);
      expect(rejected.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    }
    expect(await db.rows('SELECT id FROM webhook_subscriptions')).toEqual([]);
    contentHook = await subscribe('仅新建内容', `${receiverOrigin}/content`, ['content.created']);
    allContentHook = await subscribe('全部内容事件', `${receiverOrigin}/all-content`, ['content.*']);
    taskHook = await subscribe('任务事件', `${receiverOrigin}/tasks`, ['task.*']);
    for (const hook of [contentHook, allContentHook, taskHook])
      expect(hook.secret.length).toBeGreaterThanOrEqual(32);
    expect(new Set([contentHook.secret, allContentHook.secret, taskHook.secret]).size).toBe(3);
    const listed = await request('GET', '/api/webhooks');
    for (const hook of [contentHook, allContentHook, taskHook])
      expect(listed.body).not.toContain(hook.secret);
    expect(listed.body).not.toContain('secretCipher');
    expect(listed.json().items).toHaveLength(3);
    // Events from before a subscription existed (EXT-01 documents) are not replayed to it.
    await drain();
    expect(received).toEqual([]);

    const created = await document(account.id, 'Webhook 新文稿');
    const saved = await request('PUT', `/api/documents/${created.id}`, {
      ...documentSchema.parse(created),
      title: 'Webhook 新文稿（修订）',
      expectedRevision: created.revision,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await drain();
    const [createdHit] = hits('/content');
    expect(hits('/content')).toHaveLength(1);
    const event = payload(createdHit);
    expect(event).toMatchObject({
      type: 'content.created',
      data: { id: created.id, title: 'Webhook 新文稿', revision: 1 },
    });
    expect(event.id).toMatch(uuid);
    expect(Number.isNaN(Date.parse(event.createdAt))).toBe(false);
    expect(createdHit.method).toBe('POST');
    expect(createdHit.headers['content-type']).toBe('application/json');
    expect(createdHit.headers['x-onecreator-event-id']).toBe(event.id);
    expect(String(createdHit.headers['x-onecreator-signature'])).toMatch(/^sha256=[\da-f]{64}$/);
    expect(Math.abs(Number(createdHit.headers['x-onecreator-timestamp']) - Date.now() / 1000)).toBeLessThan(
      120,
    );
    expect(verifies(createdHit, contentHook.secret)).toBe(true);
    expect(verifies(createdHit, allContentHook.secret)).toBe(false);
    expect(
      verifies(createdHit, contentHook.secret, createdHit.body.replace('Webhook 新文稿', 'Webhook 伪造')),
    ).toBe(false);
    const [stored] = await db.rows<{ id: string }>(
      `SELECT id FROM workspace_events WHERE kind='content.created' AND "entityId"=$1`,
      [created.id],
    );
    expect(event.id).toBe(stored.id);

    const fanOut = hits('/all-content').map(payload);
    expect(fanOut.map((item) => item.type).sort()).toEqual(['content.created', 'content.updated']);
    expect(fanOut.find((item) => item.type === 'content.created')!.id).toBe(event.id);
    expect(fanOut.find((item) => item.type === 'content.updated')!.data).toMatchObject({
      id: created.id,
      revision: 2,
    });
    for (const hit of hits('/all-content')) {
      expect(verifies(hit, allContentHook.secret)).toBe(true);
      expect(hit.headers['x-onecreator-event-id']).toBe(payload(hit).id);
    }
    expect(hits('/tasks')).toEqual([]);
    expect(await deliveries(contentHook.id)).toEqual([
      expect.objectContaining({ eventId: event.id, status: 'succeeded', attempts: 1, responseCode: 200 }),
    ]);
    expect((await deliveries(allContentHook.id)).map((item) => item.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(await deliveries(taskHook.id)).toEqual([]);
    const before = received.length;
    await drain();
    expect(received.length).toBe(before);

    const job = await request(
      'POST',
      '/api/jobs',
      { documentId: created.id, expectedRevision: 2, kind: 'outline' },
      { 'idempotency-key': id() },
    );
    expect(job.statusCode, job.body).toBe(202);
    expect((await request('POST', `/api/jobs/${job.json().id}/cancel`, {})).statusCode).toBe(200);
    await drain();
    expect(hits('/tasks').map(payload)).toEqual([
      expect.objectContaining({
        type: 'task.cancelled',
        data: expect.objectContaining({ id: job.json().id, status: 'cancelled' }),
      }),
    ]);
    expect(verifies(hits('/tasks')[0], taskHook.secret)).toBe(true);
    expect(hits('/content')).toHaveLength(1);

    const reader = await token(['content:read']);
    const scoped = await bearer(reader.token, 'GET', `/api/webhooks/${contentHook.id}/deliveries`);
    expect(scoped.statusCode).toBe(403);
    expect(scoped.json().code).toBe('TOKEN_SCOPE');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/webhooks/${contentHook.id}/deliveries`,
          headers: { cookie: editorCookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('接收端失败时按退避有限重试并保留同一事件 ID；4xx 与禁止访问的内网地址不会无限重试', async () => {
    const recover = await subscribe('暂时故障后恢复', `${receiverOrigin}/recover`, ['content.created']);
    const failing = await subscribe('持续故障', `${receiverOrigin}/fail`, ['content.created']);
    const gone = await subscribe('已下线', `${receiverOrigin}/gone`, ['content.created']);
    const internal = await subscribe('未授权内网服务', `${blockedOrigin}/hook`, ['content.created']);
    const created = await document(account.id, 'Webhook 重试文稿');
    const rounds = await settleRetries();
    expect(rounds).toBeLessThanOrEqual(6);

    const recovered = hits('/recover');
    expect(recovered).toHaveLength(3);
    const eventId = payload(recovered[0]).id;
    expect(recovered.map((hit) => hit.headers['x-onecreator-event-id'])).toEqual([eventId, eventId, eventId]);
    expect(new Set(recovered.map((hit) => hit.body)).size).toBe(1);
    for (const hit of recovered) expect(verifies(hit, recover.secret)).toBe(true);
    expect(payload(recovered[0]).data).toMatchObject({ id: created.id });
    expect(await deliveries(recover.id)).toEqual([
      expect.objectContaining({ eventId, status: 'succeeded', attempts: 3, responseCode: 200 }),
    ]);

    expect(hits('/fail')).toHaveLength(5);
    expect(new Set(hits('/fail').map((hit) => payload(hit).id))).toEqual(new Set([eventId]));
    expect(await deliveries(failing.id)).toEqual([
      expect.objectContaining({
        eventId,
        status: 'failed',
        attempts: 5,
        responseCode: 500,
        error: expect.stringContaining('500'),
      }),
    ]);
    expect(hits('/gone')).toHaveLength(1);
    expect(await deliveries(gone.id)).toEqual([
      expect.objectContaining({ status: 'failed', attempts: 1, responseCode: 410 }),
    ]);
    const [blockedDelivery] = await deliveries(internal.id);
    expect(blockedDelivery).toMatchObject({ status: 'failed', responseCode: null });
    // A network-policy rejection is final: one attempt, with the reason shown to the admin.
    expect(blockedDelivery.attempts).toBe(1);
    expect(blockedDelivery.error).toContain('INTEGRATION_ALLOWED_ORIGINS');
    expect(blockedHits).toBe(0);

    const before = received.length;
    await db.rows(`UPDATE webhook_deliveries SET "nextAt"=now()`);
    for (let round = 0; round < 3; round++) await drain();
    expect(received.length).toBe(before);
    expect(await db.rows(`SELECT id FROM webhook_deliveries WHERE status IN ('queued','running')`)).toEqual(
      [],
    );
  });

  it('停用订阅后不再投递，修改订阅会停止旧的排队投递', async () => {
    const paused = await subscribe('稍后停用', `${receiverOrigin}/paused/fail`, ['content.*']);
    await document(account.id, '停用前的文稿');
    await drain();
    expect(await deliveries(paused.id)).toEqual([expect.objectContaining({ status: 'queued', attempts: 1 })]);
    const disabled = await request('PUT', `/api/webhooks/${paused.id}`, {
      name: '已停用',
      url: `${receiverOrigin}/paused/fail`,
      events: ['content.*'],
      enabled: false,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.body).not.toContain(paused.secret);
    expect(await deliveries(paused.id)).toEqual([expect.objectContaining({ status: 'failed', attempts: 1 })]);
    for (const hook of (await request('GET', '/api/webhooks')).json().items as {
      id: string;
      name: string;
      url: string;
      events: string[];
    }[])
      expect(
        (
          await request('PUT', `/api/webhooks/${hook.id}`, {
            name: hook.name,
            url: hook.url,
            events: hook.events,
            enabled: false,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (await request('GET', '/api/webhooks'))
        .json()
        .items.every((hook: { enabled: boolean }) => !hook.enabled),
    ).toBe(true);
    const before = received.length;
    await db.rows(`UPDATE webhook_deliveries SET "nextAt"=now()`);
    await document(account.id, '停用后的文稿');
    await drain();
    expect(received.length).toBe(before);
    expect(await db.rows(`SELECT id FROM webhook_deliveries WHERE status IN ('queued','running')`)).toEqual(
      [],
    );
  });
});

describe('EXT-03 MCP 接入', () => {
  it('initialize、通知与 tools/list 遵循 JSON-RPC；未登录调用被拒绝', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/mcp',
          payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/%61pi/mcp',
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          headers: { 'x-creator-client': 'web' },
        })
      ).statusCode,
    ).toBe(401);
    const reader = await token(['content:read']);
    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1' },
        },
      },
      { token: reader.token },
    );
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        capabilities: { tools: expect.any(Object) },
        serverInfo: { name: expect.any(String), version: expect.any(String) },
      },
    });
    const notice = await rpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { token: reader.token },
    );
    expect(notice.statusCode).toBe(202);
    expect(notice.body).toBe('');
    expect(
      (await rpc({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }, { token: reader.token })).json(),
    ).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token: reader.token });
    expect(listed.json().id).toBe(2);
    const tools = listed.json().result.tools as {
      name: string;
      description: string;
      inputSchema: { type: string };
    }[];
    expect(tools.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'list_accounts',
        'list_contents',
        'get_content',
        'create_content',
        'create_ai_task',
        'get_task',
        'save_platform_draft',
      ]),
    );
    for (const item of tools) {
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.inputSchema.type).toBe('object');
    }
  });

  it('读写工具复用业务 API：令牌权限、账号范围和成员角色同样生效', async () => {
    const writer = await token(['content:read', 'content:write']);
    const reader = await token(['content:read']);
    const scoped = await token(['content:read'], { accountIds: [account.id] });
    const made = await tool({ token: writer.token }, 'create_content', {
      title: 'MCP 创建的草稿',
      body: '通过 MCP 写入',
      accountId: account.id,
    });
    expect(made.isError).toBe(false);
    expect(made.structuredContent).toMatchObject({
      title: 'MCP 创建的草稿',
      accountId: account.id,
      revision: 1,
      status: 'editing',
    });
    expect(JSON.parse(made.content[0].text)).toEqual(made.structuredContent);
    const docId = String(made.structuredContent.id);
    const read = await tool({ token: reader.token }, 'get_content', { id: docId });
    expect(read).toMatchObject({ isError: false, structuredContent: { id: docId, body: '通过 MCP 写入' } });
    const search = await tool({ token: reader.token }, 'list_contents', { q: 'MCP 创建', limit: 10 });
    expect((search.structuredContent.items as ContentDocument[]).map((item) => item.id)).toEqual([docId]);
    const accounts = await tool({ token: reader.token }, 'list_accounts', {});
    expect((accounts.structuredContent.items as Account[]).map((item) => item.id)).toEqual(
      expect.arrayContaining([account.id, otherAccount.id, browserAccount.id]),
    );

    const refused = await tool({ token: reader.token }, 'create_content', { title: '只读令牌的草稿' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'TOKEN_SCOPE' });
    expect(await db.rows(`SELECT id FROM documents WHERE title='只读令牌的草稿'`)).toEqual([]);

    const hidden = await document(otherAccount.id, 'MCP 范围外文稿');
    expect((await tool({ token: scoped.token }, 'list_accounts', {})).structuredContent.items).toEqual([
      expect.objectContaining({ id: account.id }),
    ]);
    expect(
      (await tool({ token: scoped.token }, 'get_content', { id: hidden.id })).structuredContent,
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await tool({ token: scoped.token }, 'list_contents', { q: 'MCP 范围外' })).structuredContent.items,
    ).toEqual([]);
    expect(
      (await tool({ token: reader.token }, 'list_contents', { q: 'MCP 范围外' })).structuredContent.items,
    ).toEqual([expect.objectContaining({ id: hidden.id })]);

    const viewerWrite = await tool({ cookie: viewerCookie }, 'create_content', {
      title: '只读成员通过 MCP 写入',
    });
    expect(viewerWrite).toMatchObject({ isError: true, structuredContent: { code: 'READ_ONLY' } });
    expect((await tool({ cookie: viewerCookie }, 'get_content', { id: docId })).isError).toBe(false);
  });

  it('create_ai_task 需要 ai:run，requestId 去重，get_task 返回真实排队/取消状态', async () => {
    const runner = await token(['content:read', 'content:write', 'ai:run']);
    const writer = await token(['content:read', 'content:write']);
    const doc = (
      await tool({ token: runner.token }, 'create_content', {
        title: 'MCP 任务文稿',
        body: '需要大纲',
        accountId: account.id,
      })
    ).structuredContent as unknown as ContentDocument;
    const args = {
      documentId: doc.id,
      expectedRevision: doc.revision,
      kind: 'outline',
      instruction: '列出三段',
      requestId: `mcp-${randomUUID()}`,
    };
    const refused = await tool({ token: writer.token }, 'create_ai_task', args);
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: 'TOKEN_SCOPE' } });
    const first = await tool({ token: runner.token }, 'create_ai_task', args);
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ kind: 'outline', status: 'queued', documentId: doc.id });
    const repeated = await tool({ token: runner.token }, 'create_ai_task', args);
    expect(repeated.structuredContent.id).toBe(first.structuredContent.id);
    const changed = await tool({ token: runner.token }, 'create_ai_task', {
      ...args,
      instruction: '换一个要求',
    });
    expect(changed).toMatchObject({ isError: true, structuredContent: { code: 'CONFLICT' } });
    expect((await db.rows('SELECT id FROM jobs WHERE "idempotencyKey"=$1', [args.requestId])).length).toBe(1);
    const status = await tool({ token: runner.token }, 'get_task', {
      id: String(first.structuredContent.id),
    });
    expect(status).toMatchObject({
      isError: false,
      structuredContent: { id: first.structuredContent.id, status: 'queued', stage: 'queued' },
    });
    expect(
      (await bearer(runner.token, 'POST', `/api/jobs/${first.structuredContent.id}/cancel`, {})).statusCode,
    ).toBe(200);
    expect(
      (await tool({ token: runner.token }, 'get_task', { id: String(first.structuredContent.id) }))
        .structuredContent,
    ).toMatchObject({ status: 'cancelled' });
  });

  it('save_platform_draft 复用渠道能力与发布权限检查，不把未确认的平台结果报告为成功', async () => {
    const reader = await token(['content:read']);
    const publisher = await token(['content:read', 'publish:write']);
    const unconnected = await plan(
      await document(account.id, '未连接账号的计划', { coverAssetId: cover.id, assetIds: [cover.id] }),
    );
    const scope = await tool({ token: reader.token }, 'save_platform_draft', {
      planId: unconnected.id,
      requestId: `draft-${randomUUID()}`,
    });
    expect(scope).toMatchObject({ isError: true, structuredContent: { code: 'TOKEN_SCOPE' } });
    const unavailable = await tool({ token: publisher.token }, 'save_platform_draft', {
      planId: unconnected.id,
      requestId: `draft-${randomUUID()}`,
    });
    expect(unavailable).toMatchObject({ isError: true, structuredContent: { code: 'CHANNEL_UNAVAILABLE' } });
    expect(await db.rows('SELECT id FROM jobs WHERE "publishTaskId"=$1', [unconnected.id])).toEqual([]);

    const connected = (
      await request('POST', '/api/accounts', { name: '已连接公众号', platform: 'wechat' })
    ).json<Account>();
    const connection = await request('PUT', `/api/accounts/${connected.id}/connection`, {
      appId: mockAppId,
      appSecret: mockAppSecret,
      expectedRevision: 0,
    });
    expect(connection.json().status).toBe('connected');
    const target = await plan(
      await document(connected.id, 'MCP 草稿', {
        body: `MCP 草稿正文。\n\n![配图](/api/assets/${cover.id})`,
        coverAssetId: cover.id,
        assetIds: [cover.id],
      }),
    );
    const requestId = `draft-${randomUUID()}`;
    const saved = await tool({ token: publisher.token }, 'save_platform_draft', {
      planId: target.id,
      requestId,
    });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent).toMatchObject({
      kind: 'wechat_draft',
      status: 'queued',
      publishTaskId: target.id,
    });
    expect(
      (await tool({ token: publisher.token }, 'save_platform_draft', { planId: target.id, requestId }))
        .structuredContent.id,
    ).toBe(saved.structuredContent.id);
    // The worker below must pick this draft job, so no earlier AI job may still be queued.
    expect(await db.rows(`SELECT id FROM jobs WHERE status='queued' AND kind<>'wechat_draft'`)).toEqual([]);
    wechat.state.fault = 'after-write';
    const worker = startWorker(db, config, 100000);
    try {
      await expect
        .poll(
          async () => {
            await worker.tick();
            return (
              await tool({ token: reader.token }, 'get_task', { id: String(saved.structuredContent.id) })
            ).structuredContent.status;
          },
          { timeout: 20000, interval: 100 },
        )
        .toBe('needs_verification');
    } finally {
      await worker.stop();
      wechat.state.fault = 'none';
    }
    const uncertain = await tool({ token: reader.token }, 'get_task', {
      id: String(saved.structuredContent.id),
    });
    expect(uncertain.isError).toBe(false);
    expect(uncertain.structuredContent.status).not.toBe('succeeded');
    const [stored] = await db.rows<PublishTask>('SELECT * FROM publish_tasks WHERE id=$1', [target.id]);
    expect(stored.status).toBe('verification_required');
    expect(stored.platformDraftId).toBeNull();
  });

  it('协议错误返回 JSON-RPC error：未知方法、未知工具、参数错误、无效消息', async () => {
    const reader = await token(['content:read']);
    const send = (body: unknown) => rpc(body, { token: reader.token });
    const method = await send({ jsonrpc: '2.0', id: 10, method: 'resources/unknown' });
    expect(method.statusCode).toBe(200);
    expect(method.json()).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32601, message: expect.any(String) },
    });
    const unknown = await send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'delete_everything', arguments: {} },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 11,
      error: { code: -32602, message: expect.any(String) },
    });
    expect(unknown.json().result).toBeUndefined();
    for (const [index, params] of [
      { name: 'get_content', arguments: { id: 'not-a-uuid' } },
      { name: 'get_task', arguments: {} },
      { name: 'create_ai_task', arguments: { requestId: 'x' } },
      { arguments: {} },
      undefined,
    ].entries()) {
      const invalid = await send({
        jsonrpc: '2.0',
        id: 20 + index,
        method: 'tools/call',
        ...(params ? { params } : {}),
      });
      expect(invalid.statusCode, invalid.body).toBe(200);
      expect(invalid.json(), invalid.body).toMatchObject({
        jsonrpc: '2.0',
        id: 20 + index,
        error: { code: -32602, message: expect.any(String) },
      });
    }
    for (const envelope of [
      { jsonrpc: '1.0', id: 30, method: 'ping' },
      { jsonrpc: '2.0', id: 31 },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      [{ jsonrpc: '2.0', id: 32, method: 'ping' }],
    ]) {
      const invalid = await send(envelope);
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json(), invalid.body).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: expect.any(String) },
      });
    }
    const missing = await tool({ token: reader.token }, 'get_content', { id: randomUUID() });
    expect(missing).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
    // A body that is not JSON at all is a JSON-RPC parse error, not the generic HTTP 400 shape.
    const garbled = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' },
      payload: '{"jsonrpc":"2.0",',
    });
    expect(garbled.statusCode).toBe(400);
    expect(garbled.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });
});

describe('新数据表的备份与恢复', () => {
  it('恢复到空实例后保留数据；令牌撤销、订阅停用、节点凭据失效、连接过期，排队任务不会继续执行', async () => {
    const visual = await request('POST', '/api/studio/items', {
      kind: 'visual',
      name: '备份视觉模板',
      accountId: null,
      data: { footer: '第一版' },
    });
    expect(visual.statusCode, visual.body).toBe(201);
    const revised = await request('PUT', `/api/studio/items/${visual.json().id}`, {
      kind: 'visual',
      name: '备份视觉模板',
      accountId: null,
      data: { footer: '第二版' },
      expectedRevision: 1,
    });
    expect(revised.statusCode, revised.body).toBe(200);
    const styled = await document(account.id, '使用视觉模板的文稿', { visualTemplateId: visual.json().id });
    expect(styled.visualTemplateId).toBe(visual.json().id);
    const prompt = await request('POST', '/api/studio/items', {
      kind: 'prompt',
      name: '备份写作预设',
      accountId: account.id,
      data: { template: '写一篇关于 {{topic}} 的文章', variables: [{ key: 'topic', label: '主题' }] },
    });
    expect(prompt.statusCode, prompt.body).toBe(201);
    const feed = await request('POST', '/api/feeds', {
      name: '备份订阅源',
      kind: 'rss',
      url: 'https://example.com/feed.xml',
      accountId: account.id,
    });
    expect(feed.statusCode, feed.body).toBe(201);
    const refresh = await request(
      'POST',
      `/api/feeds/${feed.json().id}/refresh`,
      {},
      { 'idempotency-key': id() },
    );
    expect(refresh.statusCode, refresh.body).toBe(202);
    const published = await plan(await document(account.id, '已发布的文章'));
    const recorded = await request('POST', `/api/publishing/${published.id}/record`, {
      url: 'https://mp.weixin.qq.com/s/backup-article',
      publishedAt: new Date(Date.now() - 3600000).toISOString(),
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const metric = await request('POST', '/api/metrics', {
      publishTaskId: published.id,
      capturedAt: new Date(Date.now() - 60000).toISOString(),
      basis: 'cumulative',
      values: { views: 321, likes: 12 },
    });
    expect(metric.statusCode, metric.body).toBe(200);
    const apiToken = await token(['content:read']);
    expect((await bearer(apiToken.token, 'GET', '/api/accounts')).statusCode).toBe(200);
    const aiDoc = await document(account.id, '备份时排队的 AI 任务');
    const aiJob = await request(
      'POST',
      '/api/jobs',
      { documentId: aiDoc.id, expectedRevision: 1, kind: 'draft' },
      { 'idempotency-key': id() },
    );
    expect(aiJob.statusCode, aiJob.body).toBe(202);
    // The node token authenticates now (a lease conflict, not 401), so the later 401 comes from the restore.
    expect(
      (
        await executor(app, nodeToken, `/jobs/${randomUUID()}/heartbeat`, {
          leaseToken: randomUUID(),
          stage: 'preparing',
        })
      ).statusCode,
    ).toBe(409);
    expect((await request('GET', `/api/automation/${queuedPublishJob.id}`)).json().status).toBe('queued');
    expect(
      (await request('GET', `/api/accounts/${browserAccount.id}/browser-connection`)).json().status,
    ).toBe('connected');
    const hook = await subscribe('备份前的订阅', `${receiverOrigin}/backup/fail`, ['content.*']);
    await document(account.id, '备份前触发的事件');
    await drain();
    expect(await deliveries(hook.id)).toEqual([expect.objectContaining({ status: 'queued', attempts: 1 })]);

    const backup = await createBackup(db, config, workspaceId);
    const serialized = strFromU8(unzipSync(backup)['data.json']);
    const manifest = JSON.parse(serialized) as {
      schemaVersion: number;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(manifest.schemaVersion).toBe(migrations.length);
    for (const secret of [apiToken.token, nodeToken, hook.secret, mockAppSecret])
      expect(serialized).not.toContain(secret);
    for (const table of [
      'creator_items',
      'creator_item_revisions',
      'feeds',
      'metric_snapshots',
      'webhook_subscriptions',
      'webhook_deliveries',
      'workspace_events',
      'api_tokens',
      'execution_nodes',
      'browser_connections',
      'automation_jobs',
    ])
      expect(manifest.tables[table]?.length, table).toBeGreaterThan(0);

    const restoreConfig = await loadConfig({ ...config, dataDir: path.join(folder, 'restored') });
    const restored = await openDatabase(restoreConfig, true);
    let restoredApp: FastifyInstance | undefined;
    try {
      await restoreBackup(restored, restoreConfig, backup);
      restoredApp = await buildApp(restored, restoreConfig, { worker: false });
      await restoredApp.ready();
      const session = await login(restoredApp, 'integrator', 'Integration-Test-Password');
      const get = (url: string) => restoredApp!.inject({ method: 'GET', url, headers: { cookie: session } });

      const items = (await get('/api/studio/items?limit=500')).json().items as {
        id: string;
        name: string;
        revision: number;
        data: Record<string, unknown>;
      }[];
      expect(items.find((item) => item.id === visual.json().id)).toMatchObject({
        name: '备份视觉模板',
        revision: 2,
        data: expect.objectContaining({ footer: '第二版' }),
      });
      expect(items.find((item) => item.id === prompt.json().id)).toMatchObject({ name: '备份写作预设' });
      expect(
        (await get(`/api/studio/items/${visual.json().id}/revisions`))
          .json()
          .map((row: { revision: number }) => row.revision),
      ).toEqual([2, 1]);
      expect((await get(`/api/documents/${styled.id}`)).json().visualTemplateId).toBe(visual.json().id);
      expect((await get('/api/feeds')).json().items).toEqual([
        expect.objectContaining({ id: feed.json().id, name: '备份订阅源' }),
      ]);
      expect((await get(`/api/metrics?publishTaskId=${published.id}`)).json().items).toEqual([
        expect.objectContaining({ values: expect.objectContaining({ views: 321, likes: 12 }) }),
      ]);
      const [{ events }] = await restored.rows<{ events: number }>(
        'SELECT count(*)::int AS events FROM workspace_events',
      );
      expect(events).toBe(manifest.tables.workspace_events.length);

      const tokens = (await get('/api/tokens')).json().items as { id: string; revokedAt: string | null }[];
      expect(tokens.length).toBe(manifest.tables.api_tokens.length);
      expect(tokens.every((item) => item.revokedAt)).toBe(true);
      expect(
        (
          await restoredApp.inject({
            method: 'GET',
            url: '/api/accounts',
            headers: { authorization: `Bearer ${apiToken.token}` },
          })
        ).statusCode,
      ).toBe(401);

      const hooks = (await get('/api/webhooks')).json().items as { id: string; enabled: boolean }[];
      expect(hooks.length).toBe(manifest.tables.webhook_subscriptions.length);
      expect(hooks.every((item) => !item.enabled)).toBe(true);
      expect(await deliveries(hook.id, restoredApp, session)).toEqual([
        expect.objectContaining({ status: 'failed', attempts: 1 }),
      ]);
      expect(
        await restored.rows(`SELECT id FROM webhook_deliveries WHERE status IN ('queued','running')`),
      ).toEqual([]);
      const before = received.length;
      await restored.rows(`UPDATE webhook_deliveries SET "nextAt"=now()`);
      await drain(restored, restoreConfig);
      await deliverWebhooks(restored, restoreConfig);
      expect(received.length).toBe(before);

      expect((await executor(restoredApp, nodeToken, '/poll', { version: 'test' })).statusCode).toBe(401);
      expect(
        (
          await executor(restoredApp, nodeToken, `/jobs/${queuedPublishJob.id}/heartbeat`, {
            leaseToken: randomUUID(),
            stage: 'preparing',
          })
        ).statusCode,
      ).toBe(401);
      expect((await get('/api/nodes')).json().items).toEqual([
        expect.objectContaining({ id: nodeId, active: true, lastSeenAt: null }),
      ]);
      const browser = (await get(`/api/accounts/${browserAccount.id}/browser-connection`)).json();
      expect(browser).toMatchObject({ status: 'expired', nodeOnline: false });
      expect(browser.error).toBeTruthy();

      expect((await get(`/api/automation/${queuedPublishJob.id}`)).json().status).toBe('failed');
      expect((await get(`/api/automation/${refresh.json().id}`)).json().status).toBe('failed');
      expect((await get(`/api/jobs/${aiJob.json().id}`)).json().status).toBe('failed');
      const [{ waiting }] = await restored.rows<{ waiting: number }>(
        `SELECT ((SELECT count(*) FROM automation_jobs WHERE status IN ('queued','running'))+(SELECT count(*) FROM jobs WHERE status IN ('queued','running')))::int AS waiting`,
      );
      expect(waiting).toBe(0);
      const [restoredPlan] = await restored.rows<{ status: string }>(
        `SELECT status FROM publish_tasks WHERE id=(SELECT "publishTaskId" FROM automation_jobs WHERE id=$1)`,
        [queuedPublishJob.id],
      );
      expect(restoredPlan.status).toBe('waiting_user');

      const rotated = await restoredApp.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/rotate-token`,
        payload: {},
        headers: { cookie: session, 'x-creator-client': 'web' },
      });
      expect(rotated.statusCode).toBe(200);
      const fresh = await executor(restoredApp, rotated.json().token, '/poll', { version: 'test' });
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(fresh.json().job).toBeNull();
    } finally {
      await restoredApp?.close();
      await restored.close();
    }
  });
});

describe('数据库迁移升级', () => {
  it('结构版本 3 的数据库依次升级到 004、005、006 并保留数据，升级后接口可用', async () => {
    const legacy = await openDatabase({ dataDir: path.join(folder, 'legacy') }, true, migrations.slice(0, 3));
    let upgradedApp: FastifyInstance | undefined;
    const tables = async () =>
      new Set(
        (
          await legacy.rows<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
          )
        ).map((row) => row.table_name),
      );
    const versions = async () =>
      (await legacy.rows<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).map(
        (row) => row.version,
      );
    try {
      expect(await versions()).toEqual([1, 2, 3]);
      expect((await tables()).has('api_tokens')).toBe(false);
      const ws = id(),
        owner = id(),
        accountId = id(),
        docId = id(),
        taskId = id(),
        jobId = id();
      await insert(legacy, 'workspaces', { id: ws, name: '旧版本空间' });
      await insert(legacy, 'users', {
        id: owner,
        workspaceId: ws,
        username: 'legacy-owner',
        name: '旧管理员',
        passwordHash: await hashPassword('Legacy-Owner-Password'),
      });
      await insert(legacy, 'accounts', {
        id: accountId,
        workspaceId: ws,
        name: '旧公众号',
        platform: 'wechat',
      });
      const context = {
        account: { id: accountId, name: '旧公众号', platform: 'wechat' },
        persona: null,
        preferences: emptyPreferences,
        preferenceSources: {},
        citations: [],
      };
      const doc = await insert<ContentDocument>(legacy, 'documents', {
        id: docId,
        workspaceId: ws,
        accountId,
        title: '升级前的文章',
        body: '升级前写的正文',
        context,
      });
      await insert(legacy, 'document_revisions', {
        id: id(),
        workspaceId: ws,
        documentId: docId,
        revision: 1,
        data: doc,
        reason: '旧版保存',
      });
      await insert(legacy, 'publish_tasks', {
        id: taskId,
        workspaceId: ws,
        documentId: docId,
        accountId,
        snapshot: doc,
        status: 'waiting_user',
        timezone: 'Asia/Shanghai',
        idempotencyKey: id(),
      });
      await insert(legacy, 'jobs', {
        id: jobId,
        workspaceId: ws,
        documentId: docId,
        kind: 'outline',
        status: 'succeeded',
        stage: 'done',
        input: { document: doc, instruction: '', model: 'legacy', baseUrl: 'https://example.com/v1' },
        output: '旧大纲',
        model: 'legacy',
        idempotencyKey: id(),
      });

      await migrate(legacy, migrations.slice(0, 4));
      expect(await versions()).toEqual([1, 2, 3, 4]);
      expect(
        (await legacy.rows('SELECT role,active,"accountIds" FROM users WHERE id=$1', [owner]))[0],
      ).toEqual({ role: 'admin', active: true, accountIds: null });
      for (const table of [
        'api_tokens',
        'creator_items',
        'webhook_subscriptions',
        'webhook_deliveries',
        'workspace_events',
        'automation_jobs',
      ])
        expect((await tables()).has(table), table).toBe(true);
      expect((await tables()).has('feeds')).toBe(false);
      const itemId = id();
      await insert(legacy, 'creator_items', {
        id: itemId,
        workspaceId: ws,
        kind: 'visual',
        name: '升级中创建的模板',
        data: { footer: '旧模板' },
      });
      await legacy.rows('UPDATE documents SET revision=2,body=$1 WHERE id=$2', [
        '在版本 4 修改的正文',
        docId,
      ]);
      expect(await legacy.rows(`SELECT kind FROM workspace_events WHERE "entityId"=$1`, [docId])).toEqual([
        { kind: 'content.updated' },
      ]);

      await migrate(legacy, migrations.slice(0, 5));
      expect(await versions()).toEqual([1, 2, 3, 4, 5]);
      for (const table of ['feeds', 'feed_entries', 'material_chunks', 'metric_snapshots'])
        expect((await tables()).has(table), table).toBe(true);
      expect((await tables()).has('execution_nodes')).toBe(false);
      expect(
        (await legacy.rows('SELECT name,"externalKey" FROM creator_items WHERE id=$1', [itemId]))[0],
      ).toEqual({ name: '升级中创建的模板', externalKey: null });
      await legacy.rows('UPDATE documents SET "visualTemplateId"=$1 WHERE id=$2', [itemId, docId]);
      await insert(legacy, 'feeds', {
        id: id(),
        workspaceId: ws,
        name: '旧订阅源',
        kind: 'rss',
        url: 'https://example.com/legacy.xml',
      });
      await legacy.rows(
        `UPDATE publish_tasks SET status='published',url='https://mp.weixin.qq.com/s/legacy' WHERE id=$1`,
        [taskId],
      );
      await insert(legacy, 'metric_snapshots', {
        id: id(),
        workspaceId: ws,
        accountId,
        publishTaskId: taskId,
        capturedAt: new Date(Date.now() - 60000).toISOString(),
        basis: 'cumulative',
        source: 'manual',
        values: { views: 88 },
      });

      await migrate(legacy);
      expect(await versions()).toEqual(migrations.map((_, index) => index + 1));
      expect(migrations.length).toBe(6);
      for (const table of [
        'execution_nodes',
        'browser_connections',
        'node_commands',
        'account_execution_leases',
      ])
        expect((await tables()).has(table), table).toBe(true);
      const [task] = await legacy.rows<PublishTask>('SELECT * FROM publish_tasks WHERE id=$1', [taskId]);
      expect(task).toMatchObject({
        status: 'published',
        channel: 'manual',
        executionMode: 'manual',
        executionRevision: 1,
        dispatchedRevision: 0,
        nodeId: null,
        platformResult: {},
      });
      const [snapshot] = await legacy.rows<{ values: Record<string, number>; definition: unknown }>(
        'SELECT "values",definition FROM metric_snapshots WHERE "publishTaskId"=$1',
        [taskId],
      );
      expect(snapshot).toEqual({ values: { views: 88 }, definition: {} });
      const [job] = await legacy.rows<WorkerJob>('SELECT * FROM jobs WHERE id=$1', [jobId]);
      expect(job).toMatchObject({ status: 'succeeded', stage: 'done', output: '旧大纲' });
      const [upgraded] = await legacy.rows<ContentDocument>('SELECT * FROM documents WHERE id=$1', [docId]);
      expect(upgraded).toMatchObject({
        title: '升级前的文章',
        body: '在版本 4 修改的正文',
        revision: 2,
        visualTemplateId: itemId,
        videoAssetId: null,
      });
      await insert(legacy, 'accounts', {
        id: id(),
        workspaceId: ws,
        name: '升级后新增的知乎',
        platform: 'zhihu',
      });
      await migrate(legacy);
      expect(await versions()).toEqual([1, 2, 3, 4, 5, 6]);
      await expect(migrate(legacy, migrations.slice(0, 5))).rejects.toThrow('新于当前程序');

      upgradedApp = await buildApp(legacy, config, { worker: false });
      await upgradedApp.ready();
      const session = await login(upgradedApp, 'legacy-owner', 'Legacy-Owner-Password');
      const call = (method: Method, url: string, payload?: unknown) =>
        upgradedApp!.inject({
          method,
          url,
          payload: payload as Record<string, unknown>,
          headers: { cookie: session, 'x-creator-client': 'web' },
        });
      expect((await call('GET', `/api/documents/${docId}`)).json()).toMatchObject({
        title: '升级前的文章',
        revision: 2,
      });
      expect((await call('GET', `/api/metrics?publishTaskId=${taskId}`)).json().items).toEqual([
        expect.objectContaining({ values: { views: 88 } }),
      ]);
      expect((await call('GET', '/api/feeds')).json().total).toBe(1);
      const issued = await call('POST', '/api/tokens', { name: '升级后的令牌', scopes: ['content:read'] });
      expect(issued.statusCode, issued.body).toBe(201);
      const listed = await upgradedApp.inject({
        method: 'GET',
        url: '/api/v1/documents',
        headers: { authorization: `Bearer ${issued.json().token}` },
      });
      expect(listed.json().items.map((item: ContentDocument) => item.id)).toEqual([docId]);
      const xhs = await call('POST', '/api/accounts', { name: '升级后的小红书', platform: 'xiaohongshu' });
      expect(xhs.statusCode).toBe(201);
      expect(
        (
          await call('POST', '/api/nodes', {
            name: '升级后节点',
            accountIds: [xhs.json().id],
            platforms: ['xiaohongshu'],
          })
        ).statusCode,
      ).toBe(201);
      const created = await call('POST', '/api/documents', {
        title: '升级后写的文章',
        body: '新正文',
        accountId,
      });
      expect(created.statusCode).toBe(201);
      expect(
        await legacy.rows(`SELECT kind FROM workspace_events WHERE "entityId"=$1`, [created.json().id]),
      ).toEqual([{ kind: 'content.created' }]);
    } finally {
      await upgradedApp?.close();
      await legacy.close();
    }
  });
});
