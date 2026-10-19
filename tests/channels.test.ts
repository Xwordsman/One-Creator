import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import type { FastifyInstance } from 'fastify';
import type {
  Account,
  AccountConnection,
  Asset,
  ContentDocument,
  PublishTask,
  WorkerJob,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id, insert } from '@one-creator/server/records';
import { hashPassword, decryptSecret } from '@one-creator/server/crypto';
import { findConnection, credentialScope } from '@one-creator/server/connections';
import { startWorker } from '@one-creator/server/jobs';
import { recoverExpiredTasks } from '@one-creator/server/task-state';
import { createBackup, restoreBackup } from '@one-creator/server/backup';
import { buildApp } from '../apps/api/src/app.js';
import { createWechatMock, mockAppId, mockAppSecret } from './helpers/wechat.js';

let db: Database;
let app: FastifyInstance;
let config: AppConfig;
let folder: string;
let cookie: string;
let otherCookie: string;
let workspaceId: string;
let account: Account;
let other: Account;
let connection: AccountConnection;
let asset: Asset;
const mock = createWechatMock();
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
async function accountRecord(name: string, platform = 'wechat') {
  const response = await request('POST', '/api/accounts', { name, platform });
  expect(response.statusCode).toBe(201);
  return response.json<Account>();
}
async function plan(title: string) {
  const response = await request('POST', '/api/documents', {
    title,
    body: `正文版本一。\n\n![正文图](/api/assets/${asset.id})`,
    accountId: account.id,
    assetIds: [asset.id],
    coverAssetId: asset.id,
  });
  expect(response.statusCode).toBe(201);
  const doc = response.json<ContentDocument>();
  const result = await request(
    'POST',
    '/api/publishing',
    { documentId: doc.id, expectedRevision: doc.revision },
    { 'idempotency-key': id() },
  );
  expect(result.statusCode).toBe(201);
  return { doc, task: result.json<PublishTask>() };
}
async function enqueue(task: PublishTask, key = id()) {
  const response = await request(
    'POST',
    `/api/publishing/${task.id}/wechat-draft`,
    {},
    { 'idempotency-key': key },
  );
  expect(response.statusCode, response.body).toBe(202);
  return response.json<WorkerJob>();
}
const getJob = async (job: WorkerJob) => (await request('GET', `/api/jobs/${job.id}`)).json<WorkerJob>();
async function executeJob(job: WorkerJob, status: WorkerJob['status']) {
  const worker = startWorker(db, config, 100000);
  try {
    await expect.poll(async () => (await getJob(job)).status, { timeout: 15000 }).toBe(status);
  } finally {
    await worker.stop();
  }
  return getJob(job);
}
async function getTask(task: PublishTask) {
  return (await request('GET', `/api/publishing?accountId=${account.id}`))
    .json<{ items: PublishTask[] }>()
    .items.find((item) => item.id === task.id)!;
}
beforeAll(async () => {
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'channels-'));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'bc'.repeat(32),
    production: false,
    workerMode: 'inline',
    wechatApiBase: await mock.listen(),
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'creator', name: '接口验证', password: 'Channel-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  workspaceId = setup.json().workspaceId;
  const otherWorkspace = id();
  await insert(db, 'workspaces', { id: otherWorkspace, name: '隔离空间' });
  await insert(db, 'users', {
    id: id(),
    workspaceId: otherWorkspace,
    name: '隔离用户',
    username: 'other',
    passwordHash: await hashPassword('Channel-Test-Password'),
  });
  const login = await request('POST', '/api/auth/login', {
    username: 'other',
    password: 'Channel-Test-Password',
  });
  otherCookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  account = await accountRecord('公众号 A');
  other = await accountRecord('公众号 B');
  const boundary = 'one-creator-upload';
  const upload = await app.inject({
    method: 'POST',
    url: '/api/assets',
    headers: {
      cookie,
      'x-creator-client': 'web',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(upload.statusCode).toBe(201);
  asset = upload.json<Asset>();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  await mock.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('账号连接、隔离与能力声明', () => {
  it('区分未配置、凭据错误、权限不足和 IP 限制，密钥不回传', async () => {
    expect((await request('GET', `/api/accounts/${account.id}/connection`)).json().status).toBe(
      'unconfigured',
    );
    expect(
      (await request('GET', `/api/accounts/${account.id}/connection`, undefined, { cookie: otherCookie }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await request('PUT', `/api/accounts/${account.id}/connection`, {
          appId: mockAppId,
          expectedRevision: 0,
        })
      ).statusCode,
    ).toBe(400);
    connection = (
      await request('PUT', `/api/accounts/${account.id}/connection`, {
        appId: mockAppId,
        appSecret: 'incorrect-local-secret',
        expectedRevision: 0,
      })
    ).json();
    expect(connection.status).toBe('credentials_invalid');
    const saved = await request('PUT', `/api/accounts/${account.id}/connection`, {
      appId: mockAppId,
      appSecret: mockAppSecret,
      expectedRevision: connection.revision,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(mockAppSecret);
    expect(saved.body).not.toContain('Cipher');
    connection = saved.json();
    expect(connection.status).toBe('connected');
    expect(connection.checkedAt).toBeTruthy();
    mock.state.countError = 48001;
    connection = (await request('POST', `/api/accounts/${account.id}/connection/check`, {})).json();
    expect(connection.status).toBe('permission_denied');
    expect(connection.error).not.toContain(mockAppSecret);
    mock.state.countError = 0;
    mock.state.tokenError = 40164;
    await db.rows('UPDATE account_connections SET "tokenExpiresAt"=now() WHERE "accountId"=$1', [account.id]);
    connection = (await request('POST', `/api/accounts/${account.id}/connection/check`, {})).json();
    expect(connection.status).toBe('network_restricted');
    mock.state.tokenError = 0;
    connection = (await request('POST', `/api/accounts/${account.id}/connection/check`, {})).json();
    expect(connection.status).toBe('connected');
    const capability = (await request('GET', `/api/accounts/${account.id}/capabilities`)).json();
    expect(capability.capabilities.save_draft.status).toBe('supported');
    expect(capability.capabilities.publish.status).not.toBe('supported');
  });
  it('凭据按账号加密，禁止复用 AppID、过期配置写入及带连接更改平台', async () => {
    const stored = (await findConnection(db, workspaceId, account.id))!;
    expect(stored.secretCipher).not.toContain(mockAppSecret);
    expect(decryptSecret(stored.secretCipher, config.encryptionKey, credentialScope(stored))).toBe(
      mockAppSecret,
    );
    expect(() =>
      decryptSecret(
        stored.secretCipher,
        config.encryptionKey,
        credentialScope({ workspaceId, accountId: other.id }),
      ),
    ).toThrow();
    expect(
      (
        await request('PUT', `/api/accounts/${other.id}/connection`, {
          appId: mockAppId,
          appSecret: mockAppSecret,
          expectedRevision: 0,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request('PUT', `/api/accounts/${account.id}/connection`, {
          appId: mockAppId,
          expectedRevision: 0,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('PUT', `/api/accounts/${account.id}`, { ...account, platform: 'toutiao' })).statusCode,
    ).toBe(409);
    const otherConnection = await request('PUT', `/api/accounts/${other.id}/connection`, {
      appId: 'wx2222222222222222',
      appSecret: 'second-wechat-app-secret',
      expectedRevision: 0,
    });
    expect(otherConnection.json().status).toBe('connected');
    expect(
      (
        await request('DELETE', `/api/accounts/${other.id}/connection`, {
          expectedRevision: otherConnection.json().revision,
        })
      ).json().status,
    ).toBe('unconfigured');
    expect((await findConnection(db, workspaceId, account.id))?.status).toBe('connected');
  });
});

describe('公众号草稿事务与失败恢复', () => {
  it('重复点击只形成一个草稿，刷新过期令牌后保持快照与草稿状态', async () => {
    const { doc, task } = await plan('官方草稿正常路径');
    const key = id();
    const [first, second] = await Promise.all([enqueue(task, key), enqueue(task, key)]);
    expect(first.id).toBe(second.id);
    expect(
      (
        await request('PUT', `/api/accounts/${account.id}/connection`, {
          appId: mockAppId,
          expectedRevision: connection.revision,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('POST', `/api/publishing/${task.id}/wechat-draft`, {}, { 'idempotency-key': id() }))
        .statusCode,
    ).toBe(409);
    await request('PUT', `/api/documents/${doc.id}`, {
      ...doc,
      body: '最新人工正文',
      expectedRevision: doc.revision,
    });
    const before = {
      images: mock.state.imageRequests,
      covers: mock.state.coverRequests,
      drafts: mock.state.draftRequests,
    };
    mock.state.rejectNextToken = true;
    const job = await executeJob(first, 'succeeded');
    expect(job.stage).toBe('done');
    const saved = await getTask(task);
    expect(saved.status).toBe('draft_saved');
    expect(saved.platformDraftId).toBeTruthy();
    expect(saved.submittedAt).toBeTruthy();
    expect(saved.publishedAt).toBeNull();
    expect(mock.state.imageRequests - before.images).toBe(1);
    expect(mock.state.coverRequests - before.covers).toBe(1);
    expect(mock.state.draftRequests - before.drafts).toBe(1);
    const remote = mock.state.drafts.find((draft) => draft.media_id === saved.platformDraftId)!;
    expect(remote.content.news_item[0].content).toContain('正文版本一');
    expect(remote.content.news_item[0].content).not.toContain('/api/assets');
    expect(remote.content.news_item[0].content).not.toContain('最新人工正文');
    expect((await request('POST', `/api/jobs/${first.id}/apply`, { expectedRevision: 2 })).statusCode).toBe(
      400,
    );
    expect((await enqueue(task, key)).id).toBe(first.id);
  });
  it('封面上传明确失败后重试复用正文图片，保留每次尝试', async () => {
    const { task } = await plan('上传检查点复用');
    const job = await enqueue(task);
    mock.state.coverError = 45001;
    const failed = await executeJob(job, 'failed');
    expect(failed.stage).toBe('uploading_cover');
    expect(Object.keys(failed.progress.images!)).toHaveLength(1);
    expect((await getTask(task)).status).toBe('waiting_user');
    mock.state.coverError = 0;
    const imageRequests = mock.state.imageRequests;
    const retried = (
      await request('POST', `/api/jobs/${job.id}/retry`, {}, { 'idempotency-key': id() })
    ).json<WorkerJob>();
    expect(retried.parentId).toBe(job.id);
    expect(retried.attempt).toBe(2);
    await executeJob(retried, 'succeeded');
    expect(mock.state.imageRequests).toBe(imageRequests);
    expect((await getJob(job)).status).toBe('failed');
  });
  it('平台创建后丢失响应时先核对，查询认领草稿不会再写一次', async () => {
    const { task } = await plan('写入后断线');
    const job = await enqueue(task);
    mock.state.fault = 'after-write';
    const before = mock.state.draftRequests;
    await executeJob(job, 'needs_verification');
    expect((await getTask(task)).status).toBe('verification_required');
    expect(
      (await request('POST', `/api/jobs/${job.id}/retry`, {}, { 'idempotency-key': id() })).statusCode,
    ).toBe(400);
    mock.state.fault = 'none';
    const result = await request('POST', `/api/publishing/${task.id}/verify-draft`, { jobId: job.id });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().found).toBe(true);
    expect((await getTask(task)).status).toBe('draft_saved');
    expect((await getJob(job)).status).toBe('succeeded');
    expect(mock.state.draftRequests - before).toBe(1);
  });
  it('暂时查询不到不能判定写入失败；只在人工确认后允许重试', async () => {
    const { task } = await plan('无响应且未写入');
    const job = await enqueue(task);
    mock.state.fault = 'before-write';
    await executeJob(job, 'needs_verification');
    mock.state.fault = 'none';
    const result = await request('POST', `/api/publishing/${task.id}/verify-draft`, { jobId: job.id });
    expect(result.json().found).toBe(false);
    expect((await getTask(task)).status).toBe('verification_required');
    expect(
      (
        await request('POST', `/api/publishing/${task.id}/confirm-no-draft`, {
          jobId: job.id,
          confirmed: false,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', `/api/publishing/${task.id}/confirm-no-draft`, {
          jobId: job.id,
          confirmed: true,
        })
      ).statusCode,
    ).toBe(200);
    const retried = await enqueue(task);
    expect(retried.parentId).toBe(job.id);
    await executeJob(retried, 'succeeded');
    expect(
      mock.state.drafts.filter((draft) => draft.content.news_item[0].title === task.snapshot.title),
    ).toHaveLength(1);
  });
  it('提交中的任务不可取消；租约过期后旧执行者不能把待核对覆盖为成功', async () => {
    const { task } = await plan('租约过期与迟到回执');
    const job = await enqueue(task);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.state.beforeResponse = () => gate;
    const worker = startWorker(db, config, 100000);
    try {
      await expect.poll(async () => (await getJob(job)).stage, { timeout: 15000 }).toBe('creating_draft');
      await expect
        .poll(() =>
          mock.state.drafts.some((draft) => draft.content.news_item[0].title === task.snapshot.title),
        )
        .toBe(true);
      expect((await request('POST', `/api/jobs/${job.id}/cancel`, {})).statusCode).toBe(409);
      await db.rows(`UPDATE jobs SET "leaseUntil"=now()-interval '1 second' WHERE id=$1`, [job.id]);
      await recoverExpiredTasks(db);
      expect((await getJob(job)).status).toBe('needs_verification');
    } finally {
      release();
      mock.state.beforeResponse = null;
      await worker.stop();
    }
    expect((await getJob(job)).status).toBe('needs_verification');
    expect(
      (await request('POST', `/api/publishing/${task.id}/verify-draft`, { jobId: job.id })).json().found,
    ).toBe(true);
  });
  it('未开始的草稿可以取消，外部图片和没有封面的快照被拒绝', async () => {
    const { doc, task } = await plan('可取消的任务');
    const job = await enqueue(task);
    expect((await request('POST', `/api/jobs/${job.id}/cancel`, {})).json().status).toBe('cancelled');
    expect((await getTask(task)).status).toBe('waiting_user');
    const changed = (
      await request('PUT', `/api/documents/${doc.id}`, {
        ...doc,
        body: '![外部图](https://example.com/photo.png)',
        expectedRevision: doc.revision,
      })
    ).json<ContentDocument>();
    const external = (
      await request(
        'POST',
        '/api/publishing',
        { documentId: doc.id, expectedRevision: changed.revision },
        { 'idempotency-key': id() },
      )
    ).json<PublishTask>();
    const externalJob = await enqueue(external);
    const before = mock.state.imageRequests;
    const failed = await executeJob(externalJob, 'failed');
    expect(failed.error).toContain('外部图片');
    expect(mock.state.imageRequests).toBe(before);
    const noCoverDoc = (
      await request('PUT', `/api/documents/${doc.id}`, {
        ...changed,
        coverAssetId: null,
        expectedRevision: changed.revision,
      })
    ).json<ContentDocument>();
    const noCoverTask = (
      await request(
        'POST',
        '/api/publishing',
        { documentId: doc.id, expectedRevision: noCoverDoc.revision },
        { 'idempotency-key': id() },
      )
    ).json<PublishTask>();
    expect(
      (
        await request(
          'POST',
          `/api/publishing/${noCoverTask.id}/wechat-draft`,
          {},
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(400);
  });
  it('备份恢复保留待核对状态和连接密文，清除临时令牌后仍可认领草稿', async () => {
    const { task } = await plan('恢复后的待核对任务');
    const job = await enqueue(task);
    mock.state.fault = 'after-write';
    await executeJob(job, 'needs_verification');
    mock.state.fault = 'none';
    const bytes = await createBackup(db, config, workspaceId);
    const data = strFromU8(unzipSync(bytes)['data.json']);
    expect(data).not.toContain(mockAppSecret);
    expect(data).not.toContain('second-wechat-app-secret');
    const restoreDir = path.join(folder, 'restored');
    const restoreConfig = await loadConfig({ ...config, dataDir: restoreDir });
    const restored = await openDatabase(restoreConfig, true);
    try {
      await restoreBackup(restored, restoreConfig, bytes);
      const [restoredJob] = await restored.rows<WorkerJob>('SELECT * FROM jobs WHERE id=$1', [job.id]);
      expect(restoredJob.status).toBe('needs_verification');
      const restoredConnection = (await findConnection(restored, workspaceId, account.id))!;
      expect(restoredConnection.tokenCipher).toBe('');
      expect(restoredConnection.status).toBe('unchecked');
      const { verifyDraft } = await import('@one-creator/server/draft-jobs');
      expect((await verifyDraft(restored, restoreConfig, workspaceId, task.id, job.id)).found).toBe(true);
    } finally {
      await restored.close();
    }
    await request('POST', `/api/publishing/${task.id}/verify-draft`, { jobId: job.id });
  });
});
