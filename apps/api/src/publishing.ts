import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  platformSchema,
  publishSchema,
  publishStatusSchema,
  validateDocument,
  type Account,
  type ContentDocument,
  type PublishTask,
} from '@one-creator/core';
import { id, owned, update } from '@one-creator/server/records';
import { AppError, conflict } from '@one-creator/server/errors';
import { getDocument } from '@one-creator/server/content';
import { exportDocument } from '@one-creator/server/files';
import { createDraftJob, verifyDraft, confirmDraftAbsent } from '@one-creator/server/draft-jobs';
import { draftCapability, publicationCapability } from '@one-creator/server/platforms/index';
import { trackExport } from '@one-creator/server/activities';
import type { ConnectionRecord } from '@one-creator/server/connections';
import { accountScope } from '@one-creator/server/permissions';
import { checkExecutionPlan } from '@one-creator/server/publication-guard';
import { browserPublishCapability } from '@one-creator/server/nodes';
import type { Capability } from '@one-creator/core';
import type { Sql } from '@one-creator/server/database';
import { idempotencyKey, like, pagination, recordId, workspace, type ApiContext } from './context.js';

const sameTime = (stored: string | null, incoming: string | null) =>
  (stored ? Date.parse(stored) : null) === (incoming ? Date.parse(incoming) : null);
/** Queued platform work for a plan stops when the plan is cancelled or recorded by hand. */
async function cancelQueued(sql: Sql, taskId: string, reason: string) {
  const running = await sql.rows(
    `SELECT id FROM automation_jobs WHERE "publishTaskId"=$1 AND status='running'
     UNION ALL SELECT id FROM jobs WHERE "publishTaskId"=$1 AND status='running' LIMIT 1`,
    [taskId],
  );
  if (running.length) throw conflict('平台任务正在执行，请先在任务中心取消或等待结果');
  await sql.rows(
    `UPDATE automation_jobs SET status='cancelled',error=$2,"finishedAt"=now() WHERE "publishTaskId"=$1 AND status='queued'`,
    [taskId, reason],
  );
  await sql.rows(
    `UPDATE jobs SET status='cancelled',error=$2,"finishedAt"=now() WHERE "publishTaskId"=$1 AND status='queued'`,
    [taskId, reason],
  );
}
function checkTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
  } catch {
    throw new AppError(400, 'INVALID_TIMEZONE', '请选择有效的时区');
  }
}
export async function publishingRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/publishing', async (request) => {
    const ws = workspace(request);
    const { q, limit, offset } = pagination(request.query);
    const filter = z
      .object({
        status: publishStatusSchema.optional(),
        accountId: z.uuid().optional(),
        platform: platformSchema.optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(request.query);
    const parameters: unknown[] = [ws, like(q)];
    let where = `p."workspaceId"=$1 AND p.snapshot->>'title' ILIKE $2`;
    for (const field of ['status', 'accountId'] as const)
      if (filter[field]) {
        parameters.push(filter[field]);
        where += ` AND p."${field}"=$${parameters.length}`;
      }
    // The frozen snapshot records the platform the plan was made for.
    if (filter.platform) {
      parameters.push(filter.platform);
      where += ` AND snapshot->'context'->'account'->>'platform'=$${parameters.length}`;
    }
    if (filter.from) {
      parameters.push(filter.from);
      where += ` AND "scheduledAt">=$${parameters.length}`;
    }
    if (filter.to) {
      parameters.push(filter.to);
      where += ` AND "scheduledAt"<$${parameters.length}`;
    }
    where += ` AND ${accountScope(parameters, 'p."accountId"')}`;
    const records = await db.rows<
      PublishTask & {
        targetAccount: Account;
        connectionState: Pick<ConnectionRecord, 'status' | 'error' | 'capabilities'> | null;
        browserState: { status: string; nodeId: string; identity: string; online: boolean } | null;
      }
    >(
      `SELECT p.*,row_to_json(a) AS "targetAccount",
        (SELECT json_build_object('status',c.status,'error',c.error,'capabilities',c.capabilities) FROM account_connections c WHERE c."accountId"=p."accountId" AND c."workspaceId"=p."workspaceId") AS "connectionState",
        (SELECT json_build_object('status',b.status,'nodeId',b."nodeId",'identity',b.identity,'online',n.active AND n."lastSeenAt">now()-interval '1 minute') FROM browser_connections b JOIN execution_nodes n ON n.id=b."nodeId" WHERE b."accountId"=p."accountId" AND b."workspaceId"=p."workspaceId") AS "browserState",
        (SELECT to_jsonb(j)-'leaseToken'-'leaseUntil'-'idempotencyKey' FROM jobs j WHERE j."publishTaskId"=p.id AND j."workspaceId"=p."workspaceId" ORDER BY j.attempt DESC,j."createdAt" DESC LIMIT 1) AS "channelJob",
        (SELECT to_jsonb(j)-'leaseToken'-'leaseUntil'-'idempotencyKey'-'requestHash'-'input' FROM automation_jobs j WHERE j."publishTaskId"=p.id AND j."workspaceId"=p."workspaceId" ORDER BY j."createdAt" DESC LIMIT 1) AS "automationJob"
       FROM publish_tasks p JOIN accounts a ON a.id=p."accountId" WHERE ${where} ORDER BY COALESCE(p."scheduledAt",p."createdAt") DESC,p.id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const capabilities = new Map<string, Capability>();
    const items = [];
    for (const { targetAccount, connectionState, browserState, ...task } of records) {
      let publishCapability = capabilities.get(targetAccount.id);
      if (!publishCapability) {
        publishCapability =
          targetAccount.platform === 'wechat'
            ? publicationCapability(targetAccount, connectionState)
            : await browserPublishCapability(
                db,
                ws,
                targetAccount,
                browserState && {
                  status: browserState.status,
                  nodeOnline: browserState.online,
                  identity: browserState.identity,
                  error: '',
                },
              );
        capabilities.set(targetAccount.id, publishCapability);
      }
      items.push({
        ...task,
        draftCapability: draftCapability(targetAccount, connectionState),
        publishCapability,
        browserNodeId: browserState?.nodeId ?? null,
      });
    }
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM publish_tasks p WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/publishing', async (request, reply) => {
    const input = publishSchema.parse(request.body);
    const ws = workspace(request);
    const key = idempotencyKey(request);
    checkTimezone(input.timezone);
    function matches(task: PublishTask) {
      return (
        task.documentId === input.documentId &&
        task.snapshot.revision === input.expectedRevision &&
        sameTime(task.scheduledAt, input.scheduledAt ?? null) &&
        task.timezone === input.timezone &&
        task.executionMode === input.executionMode &&
        task.overduePolicy === input.overduePolicy
      );
    }
    const task = await db.transaction(async (sql) => {
      const [existing] = await sql.rows<PublishTask>(
        'SELECT * FROM publish_tasks WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
        [ws, key],
      );
      if (existing) {
        if (!matches(existing)) throw conflict('请求编号已用于另一项发布计划');
        return existing;
      }
      const document = await getDocument(sql, ws, input.documentId);
      if (document.revision !== input.expectedRevision) throw conflict();
      if (!document.accountId) throw new AppError(400, 'ACCOUNT_REQUIRED', '请先为稿件选择目标账号');
      const account = await owned<Account>(sql, 'accounts', ws, document.accountId);
      if (!account.active) throw new AppError(400, 'ACCOUNT_DISABLED', '该账号已停用，不能创建新的发布计划');
      const issues = validateDocument(document, account.platform).filter(
        (issue) => issue.severity === 'error',
      );
      if (issues.length) throw new AppError(400, 'CONTENT_INCOMPLETE', issues[0].message);
      const plan = await checkExecutionPlan(sql, ws, account, {
        executionMode: input.executionMode,
        scheduledAt: input.scheduledAt ?? null,
        nodeId: input.nodeId,
      });
      const [created] = await sql.rows<PublishTask>(
        `INSERT INTO publish_tasks(id,"workspaceId","documentId","accountId",snapshot,status,"scheduledAt",timezone,"idempotencyKey","executionMode","overduePolicy","nodeId")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT("workspaceId","idempotencyKey") DO NOTHING RETURNING *`,
        [
          id(),
          ws,
          document.id,
          document.accountId,
          JSON.stringify(document),
          input.scheduledAt ? 'planned' : 'waiting_user',
          input.scheduledAt,
          input.timezone,
          key,
          input.executionMode,
          input.overduePolicy,
          plan.nodeId,
        ],
      );
      if (created) return created;
      const [duplicate] = await sql.rows<PublishTask>(
        'SELECT * FROM publish_tasks WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
        [ws, key],
      );
      if (!matches(duplicate)) throw conflict('请求编号已被使用');
      return duplicate;
    });
    reply.code(201);
    return task;
  });
  app.put('/api/publishing/:id', async (request) => {
    const input = z
      .object({
        scheduledAt: z.iso.datetime({ offset: true }).nullable(),
        timezone: z.string().max(80),
        executionMode: publishSchema.shape.executionMode.unwrap().optional(),
        overduePolicy: publishSchema.shape.overduePolicy.unwrap().optional(),
        nodeId: z.uuid().nullable().optional(),
      })
      .parse(request.body);
    checkTimezone(input.timezone);
    const ws = workspace(request);
    const taskId = recordId(request);
    return db.transaction(async (sql) => {
      const original = await owned<PublishTask>(sql, 'publish_tasks', ws, taskId);
      const account = await owned<Account>(sql, 'accounts', ws, original.accountId, true);
      const task = await owned<PublishTask>(sql, 'publish_tasks', ws, taskId, true);
      if (!['planned', 'waiting_user', 'draft_saved'].includes(task.status))
        throw conflict('已提交、已完成或取消的计划不能修改排期');
      const busy = await sql.rows(
        `SELECT id FROM automation_jobs WHERE "publishTaskId"=$1 AND status IN ('queued','running','needs_verification')
         UNION ALL SELECT id FROM jobs WHERE "publishTaskId"=$1 AND status IN ('queued','running','needs_verification') LIMIT 1`,
        [task.id],
      );
      if (busy.length) throw conflict('这项计划已有排队或执行中的平台任务，请等待结束后再修改');
      const executionMode = input.executionMode ?? task.executionMode;
      const overduePolicy = input.overduePolicy ?? task.overduePolicy;
      const changed =
        !sameTime(task.scheduledAt, input.scheduledAt) ||
        executionMode !== task.executionMode ||
        overduePolicy !== task.overduePolicy ||
        (input.nodeId !== undefined && input.nodeId !== task.nodeId);
      const plan = changed
        ? await checkExecutionPlan(sql, ws, account, {
            executionMode,
            scheduledAt: input.scheduledAt,
            nodeId: input.nodeId ?? task.nodeId,
          })
        : { nodeId: task.nodeId };
      // A new execution revision lets the scheduler dispatch once for the changed plan, never for the old one.
      return update<PublishTask>(sql, 'publish_tasks', ws, taskId, {
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        executionMode,
        overduePolicy,
        nodeId: plan.nodeId,
        executionRevision: changed ? task.executionRevision + 1 : task.executionRevision,
        status:
          task.status === 'draft_saved' ? 'draft_saved' : input.scheduledAt ? 'planned' : 'waiting_user',
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.post('/api/publishing/:id/record', async (request) => {
    const input = z
      .object({ url: z.url({ protocol: /^https?$/ }), publishedAt: z.iso.datetime({ offset: true }) })
      .parse(request.body);
    const ws = workspace(request);
    const taskId = recordId(request);
    if (new Date(input.publishedAt).getTime() > Date.now() + 60000)
      throw new AppError(400, 'FUTURE_PUBLICATION', '实际发布时间不能是未来时间');
    return db.transaction(async (sql) => {
      const task = await owned<PublishTask>(sql, 'publish_tasks', ws, taskId, true);
      if (task.status === 'cancelled') throw conflict('已取消的计划不能回填发布结果');
      if (['submitting', 'verification_required'].includes(task.status))
        throw conflict('请先完成或核对草稿任务，再回填实际发布结果');
      await cancelQueued(sql, task.id, '作者已手工回填发布结果，排队中的平台任务已停止');
      return update<PublishTask>(sql, 'publish_tasks', ws, taskId, {
        ...input,
        status: 'published',
        resultSource: 'user_recorded',
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.post('/api/publishing/:id/cancel', async (request) => {
    const ws = workspace(request);
    const taskId = recordId(request);
    return db.transaction(async (sql) => {
      const task = await owned<PublishTask>(sql, 'publish_tasks', ws, taskId, true);
      if (['published', 'submitted', 'platform_unavailable'].includes(task.status))
        throw conflict('平台已经接收或发布这项内容，不能通过取消计划撤回');
      if (['submitting', 'verification_required'].includes(task.status))
        throw conflict('请先在任务中心取消可取消的任务，或完成平台结果核对');
      await cancelQueued(sql, task.id, '发布计划已取消');
      return update<PublishTask>(sql, 'publish_tasks', ws, taskId, {
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.post('/api/publishing/:id/confirm-not-published', async (request) => {
    z.object({ confirmed: z.literal(true) }).parse(request.body);
    const ws = workspace(request);
    return db.transaction(async (sql) => {
      const task = await owned<PublishTask>(sql, 'publish_tasks', ws, recordId(request), true);
      const [uncertain] = await sql.rows<{ kind: string }>(
        `SELECT kind FROM automation_jobs WHERE "publishTaskId"=$1 AND kind IN ('wechat_publish','browser_publish') AND status='needs_verification' LIMIT 1`,
        [task.id],
      );
      // Draft writes are confirmed through confirm-no-draft; this endpoint only releases publication writes.
      if (task.status !== 'verification_required' || !uncertain)
        throw conflict('只有发布结果待核对的计划可以确认未发布');
      const active = await sql.rows(
        `SELECT id FROM automation_jobs WHERE "publishTaskId"=$1 AND status IN ('queued','running') LIMIT 1`,
        [task.id],
      );
      if (active.length) throw conflict('核对任务仍在执行，请等待结果');
      await sql.rows(
        `UPDATE automation_jobs SET status='failed',error='作者已在平台确认没有发布，允许重新提交',"finishedAt"=COALESCE("finishedAt",now())
         WHERE "publishTaskId"=$1 AND kind IN ('wechat_publish','browser_publish') AND status='needs_verification'`,
        [task.id],
      );
      return update<PublishTask>(sql, 'publish_tasks', ws, task.id, {
        status: uncertain.kind === 'wechat_publish' && task.platformDraftId ? 'draft_saved' : 'waiting_user',
        platformResult: { ...task.platformResult, userConfirmedAbsentAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.get('/api/publishing/:id/export', async (request, reply) => {
    const ws = workspace(request);
    const task = await owned<PublishTask>(db, 'publish_tasks', ws, recordId(request));
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="publish-${task.id}.zip"`);
    const { retryActivity } = z.object({ retryActivity: z.uuid().optional() }).parse(request.query);
    return trackExport(
      db,
      ws,
      task.documentId,
      task.snapshot.title,
      () => exportDocument(db, ws, config.dataDir, task.snapshot as ContentDocument),
      retryActivity,
    );
  });
  app.post('/api/publishing/:id/wechat-draft', async (request, reply) => {
    const result = await db.transaction((sql) =>
      createDraftJob(sql, workspace(request), recordId(request), idempotencyKey(request)),
    );
    reply.code(202);
    return result;
  });
  app.post(
    '/api/publishing/:id/verify-draft',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { jobId, mediaId } = z
        .object({ jobId: z.uuid(), mediaId: z.string().trim().min(1).max(128).optional() })
        .parse(request.body);
      return verifyDraft(db, config, workspace(request), recordId(request), jobId, mediaId);
    },
  );
  app.post('/api/publishing/:id/confirm-no-draft', async (request) => {
    const { jobId } = z.object({ jobId: z.uuid(), confirmed: z.literal(true) }).parse(request.body);
    return confirmDraftAbsent(db, workspace(request), recordId(request), jobId);
  });
}
