import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { automationSchemas, automationNames, type AutomationJob } from '@one-creator/core';
import { createAutomation } from '@one-creator/server/automation';
import { automationHandlers } from '@one-creator/server/automation-handlers';
import { applyAutomation, adoptPreference } from '@one-creator/server/automation-apply';
import { accountScope, automationScope } from '@one-creator/server/permissions';
import { owned } from '@one-creator/server/records';
import { AppError, conflict } from '@one-creator/server/errors';
import { exportVideo } from '@one-creator/server/video';
import { releaseAccountLease } from '@one-creator/server/execution-leases';
import { removeLoginScreen } from '@one-creator/server/nodes';
import { workspace, recordId, pagination, idempotencyKey, type ApiContext } from './context.js';

// Creating and retrying both start a platform write, so both need the publish scope.
function requirePublishScope(request: FastifyRequest, kind: string | undefined) {
  if (
    ['wechat_publish', 'wechat_verify', 'browser_publish', 'browser_verify'].includes(kind ?? '') &&
    request.user!.tokenScopes &&
    !request.user!.tokenScopes.includes('publish:write')
  )
    throw new AppError(403, 'TOKEN_SCOPE', '需要 publish:write 权限');
}
export async function automationRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/automation/catalog', async () =>
    Object.fromEntries(
      Object.entries(automationSchemas).map(([kind, schema]) => [
        kind,
        {
          name: automationNames[kind as keyof typeof automationNames],
          schema: z.toJSONSchema(schema, { io: 'input' }),
          implemented:
            kind.startsWith('browser_') || !!automationHandlers[kind as keyof typeof automationNames],
        },
      ]),
    ),
  );
  app.post('/api/automation', async (request, reply) => {
    const kind = (request.body as { kind?: string }).kind;
    requirePublishScope(request, kind);
    if (kind === 'browser_login' && request.user!.role !== 'admin')
      throw new AppError(403, 'ADMIN_REQUIRED', '连接平台账号需要管理员权限');
    const job = await db.transaction((sql) =>
      createAutomation(sql, workspace(request), request.body, idempotencyKey(request)),
    );
    reply.code(202);
    return job;
  });
  app.get('/api/automation', async (request) => {
    const { limit, offset } = pagination(request.query);
    const { kind, accountId } = z
      .object({ kind: z.string().optional(), accountId: z.uuid().optional() })
      .parse(request.query);
    const params: unknown[] = [workspace(request)];
    let where = '"workspaceId"=$1';
    if (kind) {
      params.push(kind);
      where += ` AND kind=$${params.length}`;
    }
    if (accountId) {
      params.push(accountId);
      where += ` AND "accountId"=$${params.length}`;
    }
    where += ` AND ${automationScope(params)}`;
    const items = await db.rows(
      `SELECT id,kind,title,status,stage,error,"accountId","documentId",attempt,"createdAt","finishedAt" FROM automation_jobs j WHERE ${where} ORDER BY "createdAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM automation_jobs j WHERE ${where}`,
      params,
    );
    return { items, total, limit, offset };
  });
  app.get('/api/automation/:id', async (request) => {
    const job = await owned<AutomationJob>(db, 'automation_jobs', workspace(request), recordId(request));
    const decisions = await db.rows(
      'SELECT "itemKey",decision,data,"createdAt" FROM creator_decisions WHERE "workspaceId"=$1 AND "jobId"=$2',
      [workspace(request), job.id],
    );
    return { ...job, decisions };
  });
  app.post('/api/automation/:id/cancel', async (request) => {
    const job = await owned<AutomationJob & { leaseToken: string | null; publishTaskId: string | null }>(
      db,
      'automation_jobs',
      workspace(request),
      recordId(request),
    );
    if (!['queued', 'running'].includes(job.status)) throw conflict('任务已经结束');
    const result = await db.transaction(async (sql) => {
      const [cancelled] = await sql.rows(
        `UPDATE automation_jobs SET status='cancelled',error='用户取消',"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND status IN ('queued','running') AND NOT(kind IN ('wechat_publish','browser_publish') AND stage IN ('publishing','verifying')) RETURNING *`,
        [job.id],
      );
      if (!cancelled) throw conflict('平台可能已经接收请求，请等待或核对结果');
      if (job.publishTaskId)
        await sql.rows(`UPDATE publish_tasks SET status=$1 WHERE id=$2 AND status='submitting'`, [
          job.kind === 'wechat_publish' ? 'draft_saved' : 'waiting_user',
          job.publishTaskId,
        ]);
      if (job.kind === 'browser_login')
        await sql.rows(
          `UPDATE browser_connections SET status='expired',error='登录任务已取消' WHERE "accountId"=$1`,
          [job.accountId],
        );
      return cancelled;
    });
    if (job.leaseToken) await releaseAccountLease(db, job.id, job.leaseToken);
    if (job.kind === 'browser_login') await removeLoginScreen(config.dataDir, job.id);
    return result;
  });
  app.post('/api/automation/:id/retry', async (request, reply) => {
    const previous = await owned<AutomationJob>(db, 'automation_jobs', workspace(request), recordId(request));
    if (!['failed', 'cancelled'].includes(previous.status)) throw conflict('任务不能重试');
    requirePublishScope(request, previous.kind);
    const input = previous.input as { data: Record<string, unknown> };
    const data = {
      ...input.data,
      ...(previous.kind === 'workflow'
        ? { startStep: Array.isArray(previous.progress.steps) ? previous.progress.steps.length : 0 }
        : {}),
    };
    const job = await db.transaction((sql) =>
      createAutomation(
        sql,
        workspace(request),
        {
          kind: previous.kind,
          accountId: previous.accountId,
          documentId: previous.documentId,
          data,
          parentId: previous.id,
        },
        idempotencyKey(request),
      ),
    );
    reply.code(202);
    return job;
  });
  app.post('/api/automation/:id/apply', async (request) => {
    const input = z
      .object({
        action: z.string(),
        index: z.number().int().nonnegative().optional(),
        expectedRevision: z.number().int().positive().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body);
    return db.transaction((sql) => applyAutomation(sql, workspace(request), recordId(request), input));
  });
  app.post('/api/studio/items/:id/adopt-preference', async (request) => {
    const { field } = z.object({ field: z.string() }).parse(request.body);
    return db.transaction((sql) => adoptPreference(sql, workspace(request), recordId(request), field));
  });
  app.get('/api/automation/:id/export', async (request, reply) => {
    const { index } = z
      .object({ index: z.coerce.number().int().nonnegative().optional() })
      .parse(request.query);
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="one-creator-video.zip"');
    return exportVideo(db, config, workspace(request), recordId(request), index);
  });
}
