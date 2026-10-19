import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activityKindSchema,
  activityNames,
  jobNames,
  type Activity,
  type WorkerJob,
  type WorkTask,
  automationNames,
  type AutomationJob,
} from '@one-creator/core';
import { startActivity, finishActivity } from '@one-creator/server/activities';
import { owned } from '@one-creator/server/records';
import { conflict } from '@one-creator/server/errors';
import { accountScope, automationScope } from '@one-creator/server/permissions';
import { jobSummarySql } from '@one-creator/server/jobs';
import { like, pagination, recordId, workspace, type ApiContext } from './context.js';

export async function activityRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.post('/api/activities', async (request, reply) => {
    const input = z
      .object({
        kind: activityKindSchema.exclude(['export_document']),
        title: z.string().trim().min(1).max(250),
        documentId: z.uuid().nullable().optional(),
        parentId: z.uuid().optional(),
      })
      .parse(request.body);
    const result = await startActivity(db, workspace(request), input);
    reply.code(201);
    return result;
  });
  app.post('/api/activities/:id/heartbeat', async (request) => {
    const ws = workspace(request);
    const activityId = recordId(request);
    await owned(db, 'activities', ws, activityId);
    const rows = await db.rows(
      `UPDATE activities SET "leaseUntil"=now()+interval '3 minutes' WHERE id=$1 AND status='running' AND "leaseUntil">now() RETURNING id`,
      [activityId],
    );
    if (!rows.length) throw conflict('操作已结束');
    return { ok: true };
  });
  app.post('/api/activities/:id/finish', async (request) => {
    const { status, message } = z
      .object({ status: z.enum(['succeeded', 'failed']), message: z.string().max(2000).default('') })
      .parse(request.body);
    return finishActivity(db, workspace(request), recordId(request), status, message);
  });
  app.get('/api/tasks', async (request) => {
    const ws = workspace(request);
    const { q, limit, offset } = pagination(request.query);
    const { type, status } = z
      .object({
        type: z.enum(['ai', 'publishing', 'rendering', 'importing', 'exporting']).optional(),
        status: z
          .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_verification'])
          .optional(),
      })
      .parse(request.query);
    // This recovery also works when the deployment runs its worker separately.
    await db.rows(
      `UPDATE activities SET status='failed',error='页面或执行进程已离开，请回到原页面重新操作',"finishedAt"=now() WHERE "workspaceId"=$1 AND status='running' AND "leaseUntil"<now()`,
      [ws],
    );
    const parameters: unknown[] = [ws, like(q)];
    const jobScope = accountScope(parameters, "j.input->'document'->>'accountId'");
    const activityScope = accountScope(
      parameters,
      '(SELECT "accountId" FROM documents WHERE id=a."documentId")',
    );
    const autoScope = automationScope(parameters, 'x');
    const source = `(SELECT id,'job' AS source,kind,status,stage,"createdAt",attempt,error,input->'document'->>'title' AS title,${jobSummarySql()} AS data,
        CASE WHEN kind='wechat_draft' THEN 'publishing' ELSE 'ai' END AS type FROM jobs j WHERE "workspaceId"=$1 AND ${jobScope}
      UNION ALL SELECT id,'activity',kind,status,stage,"createdAt",attempt,error,title,to_jsonb(a)-'leaseUntil',
        CASE WHEN kind='import_text' THEN 'importing' WHEN kind='export_document' THEN 'exporting' ELSE 'rendering' END FROM activities a WHERE "workspaceId"=$1 AND ${activityScope}
      UNION ALL SELECT id,'automation',kind,status,stage,"createdAt",attempt,error,title,to_jsonb(x)-'input'-'result'-'progress'-'leaseToken'-'leaseUntil'-'idempotencyKey'-'requestHash',
        CASE WHEN kind IN ('wechat_publish','browser_publish','browser_verify') THEN 'publishing' WHEN kind IN ('import','feed_refresh') THEN 'importing' WHEN kind IN ('images','render_video','clip_video') THEN 'rendering' ELSE 'ai' END FROM automation_jobs x WHERE "workspaceId"=$1 AND ${autoScope}) tasks`;
    let where = 'title ILIKE $2';
    if (type) {
      parameters.push(type);
      where += ` AND type=$${parameters.length}`;
    }
    if (status) {
      parameters.push(status);
      where += ` AND status=$${parameters.length}`;
    }
    const rows = await db.rows<{ source: string; data: WorkerJob | Activity | AutomationJob }>(
      `SELECT source,data FROM ${source} WHERE ${where} ORDER BY "createdAt" DESC,id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${source} WHERE ${where}`,
      parameters,
    );
    const items: WorkTask[] = rows.map(({ source: kind, data }) => {
      const job = kind === 'job' ? (data as WorkerJob) : null;
      const activity = kind === 'activity' ? (data as Activity) : null;
      const automation = kind === 'automation' ? (data as AutomationJob) : null;
      return {
        id: data.id,
        title: automation
          ? automation.title
          : `${job ? jobNames[job.kind] : activityNames[activity!.kind]} · ${job ? job.input.document.title : activity!.title}`,
        kind: data.kind,
        status: data.status,
        stage: data.stage,
        createdAt: data.createdAt,
        attempt: data.attempt,
        error: data.error,
        job,
        activity,
        automation,
      };
    });
    return { items, total, limit, offset };
  });
}
