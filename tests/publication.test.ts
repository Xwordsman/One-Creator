import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  Account,
  AccountCapabilities,
  Asset,
  AutomationJob,
  ContentDocument,
  PublishTask,
  WorkerJob,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { startWorker } from '@one-creator/server/jobs';
import { startAutomationWorker } from '@one-creator/server/automation';
import { dispatchSchedules } from '@one-creator/server/scheduler';
import { acquireAccountLease, releaseAccountLease } from '@one-creator/server/execution-leases';
import { buildApp } from '../apps/api/src/app.js';
import { createWechatMock, mockAppId, mockAppSecret } from './helpers/wechat.js';

let db: Database;
let app: FastifyInstance;
let config: AppConfig;
let folder: string;
let cookie: string;
let account: Account;
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
const task = async (taskId: string) =>
  (await request('GET', `/api/publishing?accountId=${account.id}&limit=100`))
    .json<{ items: PublishTask[] }>()
    .items.find((item) => item.id === taskId)!;
const automation = async (jobId: string) =>
  (await request('GET', `/api/automation/${jobId}`)).json<AutomationJob>();

/** Run queued automation work deterministically until the job settles. */
async function settle(jobId: string, status: AutomationJob['status']) {
  const general = startAutomationWorker(db, config, 1000000);
  const publication = startAutomationWorker(db, config, 1000000, 'publication');
  try {
    await expect
      .poll(
        async () => {
          await Promise.all([general.tick(), publication.tick()]);
          return (await automation(jobId)).status;
        },
        { timeout: 20000, interval: 50 },
      )
      .toBe(status);
  } finally {
    await Promise.all([general.stop(), publication.stop()]);
  }
  return automation(jobId);
}
async function saveDraft(taskId: string) {
  const worker = startWorker(db, config, 1000000);
  try {
    await expect.poll(async () => (await task(taskId)).status, { timeout: 20000 }).toBe('draft_saved');
  } finally {
    await worker.stop();
  }
}
async function document(title: string) {
  const response = await request('POST', '/api/documents', {
    title,
    body: `${title} 的正文。\n\n![配图](/api/assets/${asset.id})`,
    accountId: account.id,
    assetIds: [asset.id],
    coverAssetId: asset.id,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ContentDocument>();
}
async function draftedPlan(title: string) {
  const doc = await document(title);
  const created = await request(
    'POST',
    '/api/publishing',
    { documentId: doc.id, expectedRevision: doc.revision },
    { 'idempotency-key': id() },
  );
  expect(created.statusCode, created.body).toBe(201);
  const plan = created.json<PublishTask>();
  const draft = await request(
    'POST',
    `/api/publishing/${plan.id}/wechat-draft`,
    {},
    { 'idempotency-key': id() },
  );
  expect(draft.statusCode, draft.body).toBe(202);
  await saveDraft(plan.id);
  return task(plan.id);
}
async function publish(taskId: string, key = id()) {
  return request(
    'POST',
    '/api/automation',
    { kind: 'wechat_publish', accountId: account.id, data: { publishTaskId: taskId } },
    { 'idempotency-key': key },
  );
}

beforeAll(async () => {
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'publication-'));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'cd'.repeat(32),
    production: false,
    workerMode: 'inline',
    wechatApiBase: await mock.listen(),
    wechatTimeoutMs: 3000,
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'publisher', name: '发布验证', password: 'Publication-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  account = (
    await request('POST', '/api/accounts', { name: '正式发布公众号', platform: 'wechat' })
  ).json<Account>();
  const connected = await request('PUT', `/api/accounts/${account.id}/connection`, {
    appId: mockAppId,
    appSecret: mockAppSecret,
    expectedRevision: 0,
  });
  expect(connected.json().status).toBe('connected');
  const boundary = 'publication-upload';
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`,
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

describe('公众号正式发布与查询（PUB-05，模拟平台）', () => {
  it('已提交与已发布分开记录，重复请求复用同一任务，平台确认后记录文章 ID 与链接', async () => {
    const plan = await draftedPlan('正式发布的第一篇');
    expect(plan.publishCapability?.status).toBe('unknown');
    mock.state.nextPublishStatus = 1;
    const key = id();
    const first = await publish(plan.id, key);
    expect(first.statusCode, first.body).toBe(202);
    expect((await publish(plan.id, key)).json().id).toBe(first.json().id);
    expect((await publish(plan.id)).statusCode).toBe(409);
    const done = await settle(first.json().id, 'succeeded');
    expect(done.result.state).toBe('submitted');
    let current = await task(plan.id);
    expect(current.status).toBe('submitted');
    expect(current.publishId).toBe(mock.state.publications[0].publish_id);
    expect(current.msgDataId).toBe(mock.state.publications[0].msg_data_id);
    expect(current.url).toBeFalsy();
    expect((await request('POST', `/api/publishing/${plan.id}/cancel`, {})).statusCode).toBe(409);
    // The platform finishes later; the scheduler queries again without resubmitting.
    mock.state.publications[0].status = 0;
    await dispatchSchedules(db);
    const [verify] = await db.rows<AutomationJob>(
      `SELECT * FROM automation_jobs WHERE "publishTaskId"=$1 AND kind='wechat_verify'`,
      [plan.id],
    );
    await settle(verify.id, 'succeeded');
    current = await task(plan.id);
    expect(current.status).toBe('published');
    expect(current.resultSource).toBe('platform_api');
    expect(current.platformArticleId).toBe(mock.state.publications[0].article_id);
    expect(current.url).toBe(`https://mp.weixin.qq.com/s/${mock.state.publications[0].article_id}`);
    expect(current.publishedAt).toBeNull();
    expect(mock.state.publishRequests).toBe(1);
    const capabilities = (
      await request('GET', `/api/accounts/${account.id}/capabilities`)
    ).json<AccountCapabilities>();
    expect(capabilities.capabilities.publish.status).toBe('supported');
  });

  it('提交回执丢失进入待核对，禁止重发；只在成功列表中找到唯一一致文章后认领', async () => {
    const plan = await draftedPlan('回执丢失的文章');
    mock.state.nextPublishStatus = 0;
    mock.state.publishFault = 'after-write';
    const job = (await publish(plan.id)).json<AutomationJob>();
    await settle(job.id, 'needs_verification');
    mock.state.publishFault = 'none';
    expect((await task(plan.id)).status).toBe('verification_required');
    expect((await publish(plan.id)).statusCode).toBe(409);
    expect((await request('POST', `/api/publishing/${plan.id}/cancel`, {})).statusCode).toBe(409);
    const requests = mock.state.publishRequests;
    const verify = await request(
      'POST',
      '/api/automation',
      { kind: 'wechat_verify', accountId: account.id, data: { publishTaskId: plan.id } },
      { 'idempotency-key': id() },
    );
    expect(verify.statusCode, verify.body).toBe(202);
    const result = await settle(verify.json().id, 'succeeded');
    expect(result.result.found).toBe(true);
    const current = await task(plan.id);
    expect(current.status).toBe('published');
    expect(current.platformArticleId).toBe(mock.state.publications[0].article_id);
    expect((await automation(job.id)).status).toBe('succeeded');
    expect(mock.state.publishRequests).toBe(requests);
  });

  it('查询不到时保持待核对；作者确认未发布后可重新提交，平台明确失败可重试', async () => {
    const plan = await draftedPlan('仍在处理的文章');
    mock.state.nextPublishStatus = 1;
    mock.state.publishFault = 'after-write';
    const job = (await publish(plan.id)).json<AutomationJob>();
    await settle(job.id, 'needs_verification');
    mock.state.publishFault = 'none';
    const verify = await request(
      'POST',
      '/api/automation',
      { kind: 'wechat_verify', accountId: account.id, data: { publishTaskId: plan.id } },
      { 'idempotency-key': id() },
    );
    const checked = await settle(verify.json().id, 'succeeded');
    expect(checked.result.found).toBe(false);
    expect((await task(plan.id)).status).toBe('verification_required');
    expect((await request('POST', `/api/publishing/${plan.id}/confirm-not-published`, {})).statusCode).toBe(
      400,
    );
    const confirmed = await request('POST', `/api/publishing/${plan.id}/confirm-not-published`, {
      confirmed: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().status).toBe('draft_saved');
    mock.state.nextPublishStatus = 3;
    const failed = await settle((await publish(plan.id)).json().id, 'succeeded');
    expect(failed.result.state).toBe('publish_failed');
    expect((await task(plan.id)).status).toBe('publish_failed');
    mock.state.nextPublishStatus = 0;
    const retried = await settle((await publish(plan.id)).json().id, 'succeeded');
    expect(retried.result.state).toBe('published');
  });

  it('同步统计只写入平台返回的指标，缺失项保持未知；权限不足只标记该能力', async () => {
    const [published] = await db.rows<PublishTask>(
      `SELECT * FROM publish_tasks WHERE status='published' AND "accountId"=$1 AND "publishId" IS NOT NULL ORDER BY "createdAt" LIMIT 1`,
      [account.id],
    );
    const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    const create = (key = id(), range = { from: yesterday, to: yesterday }) =>
      request(
        'POST',
        '/api/automation',
        { kind: 'wechat_metrics', accountId: account.id, data: { publishTaskIds: [published.id], ...range } },
        { 'idempotency-key': key },
      );
    const tooEarly = await create(id(), { from: '2025-01-01', to: '2025-01-01' });
    const early = await settle(tooEarly.json().id, 'failed');
    expect(early.error).toContain('2025-11-01');
    const job = await settle((await create()).json().id, 'succeeded');
    expect(job.result.records).toHaveLength(1);
    const [snapshot] = await db.rows<{
      values: Record<string, number | null>;
      source: string;
      definition: Record<string, unknown>;
    }>('SELECT * FROM metric_snapshots WHERE "publishTaskId"=$1', [published.id]);
    expect(snapshot.source).toBe('wechat');
    expect(snapshot.values).toMatchObject({
      views: 120,
      likes: 8,
      comments: 3,
      shares: 5,
      favorites: null,
      completionRate: null,
      followers: null,
    });
    expect(snapshot.definition.interface).toBe('datacube/getarticletotaldetail');
    await settle((await create()).json().id, 'succeeded');
    expect(
      (await db.rows('SELECT id FROM metric_snapshots WHERE "publishTaskId"=$1', [published.id])).length,
    ).toBe(1);
    mock.state.metricsError = 48001;
    await settle((await create()).json().id, 'failed');
    mock.state.metricsError = 0;
    const capabilities = (
      await request('GET', `/api/accounts/${account.id}/capabilities`)
    ).json<AccountCapabilities>();
    expect(capabilities.capabilities.fetch_metrics.status).toBe('unsupported');
    expect(capabilities.connection).toBe('connected');
  });
});

describe('定时调度、账号队列与去重（PUB-08，模拟平台）', () => {
  async function scheduled(title: string, executionMode: string, overduePolicy = 'wait') {
    const doc = await document(title);
    const past = await request(
      'POST',
      '/api/publishing',
      {
        documentId: doc.id,
        expectedRevision: doc.revision,
        scheduledAt: new Date(Date.now() - 60000).toISOString(),
        executionMode,
      },
      { 'idempotency-key': id() },
    );
    expect(past.statusCode).toBe(400);
    const created = await request(
      'POST',
      '/api/publishing',
      {
        documentId: doc.id,
        expectedRevision: doc.revision,
        scheduledAt: new Date(Date.now() + 120000).toISOString(),
        executionMode,
        overduePolicy,
      },
      { 'idempotency-key': id() },
    );
    expect(created.statusCode, created.body).toBe(201);
    return created.json<PublishTask>();
  }
  const due = (taskId: string, minutesAgo: number) =>
    db.rows(`UPDATE publish_tasks SET "scheduledAt"=now()-($2::text||' minutes')::interval WHERE id=$1`, [
      taskId,
      String(minutesAgo),
    ]);
  const draftJobs = (taskId: string) =>
    db.rows<WorkerJob & { idempotencyKey: string }>(
      `SELECT * FROM jobs WHERE "publishTaskId"=$1 AND kind='wechat_draft'`,
      [taskId],
    );

  it('到期计划只派发一次；修改排期产生新的执行版本；过期默认等待作者确认', async () => {
    const plan = await scheduled('定时保存草稿', 'wechat_draft');
    await dispatchSchedules(db);
    expect(await draftJobs(plan.id)).toHaveLength(0);
    await due(plan.id, 1);
    await dispatchSchedules(db);
    await dispatchSchedules(db);
    expect(await draftJobs(plan.id)).toHaveLength(1);
    expect((await task(plan.id)).status).toBe('submitting');
    expect(
      (await request('PUT', `/api/publishing/${plan.id}`, { scheduledAt: null, timezone: 'Asia/Shanghai' }))
        .statusCode,
    ).toBe(409);
    await saveDraft(plan.id);

    const late = await scheduled('错过时间的计划', 'wechat_draft');
    await due(late.id, 30);
    await dispatchSchedules(db);
    const waiting = await task(late.id);
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.platformResult.scheduleError).toContain('过期');
    expect(await draftJobs(late.id)).toHaveLength(0);
    const rescheduled = await request('PUT', `/api/publishing/${late.id}`, {
      scheduledAt: new Date(Date.now() + 120000).toISOString(),
      timezone: 'Asia/Shanghai',
      executionMode: 'wechat_draft',
    });
    expect(rescheduled.statusCode, rescheduled.body).toBe(200);
    expect(rescheduled.json().executionRevision).toBe(2);
    expect(rescheduled.json().status).toBe('planned');
    await due(late.id, 1);
    await dispatchSchedules(db);
    const [job] = await draftJobs(late.id);
    expect(job.idempotencyKey).toBe(`schedule:${late.id}:2:draft`);
    await saveDraft(late.id);

    const grace = await scheduled('允许补执行的计划', 'wechat_draft', 'execute');
    await due(grace.id, 60);
    await dispatchSchedules(db);
    expect(await draftJobs(grace.id)).toHaveLength(1);
    await saveDraft(grace.id);
  });

  it('定时正式发布先保存冻结快照为草稿，再发布这份草稿，重复调度不重复提交', async () => {
    mock.state.nextPublishStatus = 0;
    const plan = await scheduled('定时正式发布', 'wechat_publish');
    await due(plan.id, 1);
    await dispatchSchedules(db);
    expect(await draftJobs(plan.id)).toHaveLength(1);
    await saveDraft(plan.id);
    // The draft took time; the overdue rule must not stop the second step of the same execution.
    await due(plan.id, 30);
    const before = mock.state.publishRequests;
    await dispatchSchedules(db);
    await dispatchSchedules(db);
    const jobs = await db.rows<AutomationJob>(
      `SELECT * FROM automation_jobs WHERE "publishTaskId"=$1 AND kind='wechat_publish'`,
      [plan.id],
    );
    expect(jobs).toHaveLength(1);
    await settle(jobs[0].id, 'succeeded');
    await dispatchSchedules(db);
    expect((await task(plan.id)).status).toBe('published');
    expect(mock.state.publishRequests).toBe(before + 1);
  });

  it('取消计划同时停止排队任务；同一账号同时只有一个执行租约，不同账号互不影响', async () => {
    const plan = await draftedPlan('排队后取消');
    const queued = (await publish(plan.id)).json<AutomationJob>();
    const cancelled = await request('POST', `/api/publishing/${plan.id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await automation(queued.id)).status).toBe('cancelled');
    const [workspace] = await db.rows<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
    const second = (
      await request('POST', '/api/accounts', { name: '另一个账号', platform: 'wechat' })
    ).json<Account>();
    const [a, b, c] = [id(), id(), id()];
    expect(await acquireAccountLease(db, workspace.id, account.id, a, a)).toBe(true);
    expect(await acquireAccountLease(db, workspace.id, account.id, b, b)).toBe(false);
    expect(await acquireAccountLease(db, workspace.id, second.id, c, c)).toBe(true);
    await releaseAccountLease(db, a, a);
    expect(await acquireAccountLease(db, workspace.id, account.id, b, b)).toBe(true);
    await releaseAccountLease(db, b, b);
    await releaseAccountLease(db, c, c);
  });
});
