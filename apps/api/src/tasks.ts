import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobSchema, type WorkerJob, type ContentDocument } from '@one-creator/core';
import { createDraftJob, cancelWorkerJob } from '@one-creator/server/draft-jobs';
import { applyJob, createJob, jobSummarySql } from '@one-creator/server/jobs';
import { owned } from '@one-creator/server/records';
import { AppError } from '@one-creator/server/errors';
import { accountScope } from '@one-creator/server/permissions';
import { idempotencyKey, pagination, recordId, workspace, type ApiContext } from './context.js';

export async function jobRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/jobs', async (request) => {
    const ws = workspace(request);
    const { limit, offset } = pagination(request.query);
    const { documentId, type } = z
      .object({ documentId: z.uuid().optional(), type: z.enum(['ai', 'channel']).optional() })
      .parse(request.query);
    const parameters: unknown[] = [ws];
    let where = '"workspaceId"=$1';
    if (documentId) {
      parameters.push(documentId);
      where += ' AND "documentId"=$2';
    }
    if (type) where += type === 'ai' ? " AND kind<>'wechat_draft'" : " AND kind='wechat_draft'";
    where += ` AND ${accountScope(parameters, "input->'document'->>'accountId'")}`;
    const rows = await db.rows<{ data: WorkerJob }>(
      `SELECT ${jobSummarySql()} AS data FROM jobs j WHERE ${where} ORDER BY "createdAt" DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM jobs WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => row.data), total, limit, offset };
  });
  app.get('/api/jobs/:id', async (request) =>
    owned<WorkerJob>(db, 'jobs', workspace(request), recordId(request)),
  );
  app.post('/api/jobs', async (request, reply) => {
    const input = jobSchema.parse(request.body);
    const job = await db.transaction((sql) =>
      createJob(sql, workspace(request), input, idempotencyKey(request)),
    );
    reply.code(202);
    return job;
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    return cancelWorkerJob(db, workspace(request), recordId(request));
  });
  app.post('/api/jobs/:id/retry', async (request, reply) => {
    const ws = workspace(request);
    const jobId = recordId(request);
    const result = await db.transaction(async (sql) => {
      const previous = await owned<WorkerJob>(sql, 'jobs', ws, jobId);
      if (!['failed', 'cancelled'].includes(previous.status))
        throw new AppError(400, 'JOB_NOT_RETRYABLE', '只有失败或取消的任务可以重试');
      if (previous.kind === 'wechat_draft')
        return createDraftJob(sql, ws, previous.publishTaskId!, idempotencyKey(request));
      const document = await owned<ContentDocument>(sql, 'documents', ws, previous.documentId);
      return createJob(
        sql,
        ws,
        {
          documentId: document.id,
          expectedRevision: document.revision,
          kind: previous.kind,
          instruction: previous.input.instruction,
          variables: {},
          creativity: previous.input.creativity,
          selection: previous.input.selection,
        },
        idempotencyKey(request),
        { ...previous, kind: previous.kind },
      );
    });
    reply.code(202);
    return result;
  });
  app.post('/api/jobs/:id/apply', async (request) => {
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    return db.transaction((sql) => applyJob(sql, workspace(request), recordId(request), expectedRevision));
  });
}
