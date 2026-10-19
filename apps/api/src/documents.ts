import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  documentSchema,
  platformRulesVersion,
  validateDocument,
  type Account,
  type ContentDocument,
  type DocumentRevision,
} from '@one-creator/core';
import { createDocument, getDocument, saveDocument } from '@one-creator/server/content';
import { owned } from '@one-creator/server/records';
import { AppError, conflict, notFound } from '@one-creator/server/errors';
import { exportDocument } from '@one-creator/server/files';
import { trackExport } from '@one-creator/server/activities';
import { accountScope } from '@one-creator/server/permissions';
import { like, pagination, recordId, workspace, type ApiContext } from './context.js';

export async function documentRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/documents', async (request) => {
    const ws = workspace(request);
    const { q, limit, offset } = pagination(request.query);
    const filter = z
      .object({
        accountId: z.uuid().optional(),
        sourceId: z.uuid().optional(),
        status: z.enum(['editing', 'ready', 'archived']).optional(),
        masters: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    const parameters: unknown[] = [ws, like(q)];
    let where = 'd."workspaceId"=$1 AND (d.title ILIKE $2 OR d.body ILIKE $2 OR d.tags::text ILIKE $2)';
    for (const field of ['accountId', 'sourceId', 'status'] as const)
      if (filter[field]) {
        parameters.push(filter[field]);
        where += ` AND d."${field}"=$${parameters.length}`;
      }
    if (!filter.status) where += " AND d.status<>'archived'";
    if (filter.masters === 'true') where += ' AND d."sourceId" IS NULL';
    where += ` AND ${accountScope(parameters, 'd."accountId"')}`;
    const items = await db.rows<ContentDocument>(
      `SELECT d.*,a.name AS "accountName",a.platform,
      (SELECT count(*)::int FROM documents v WHERE v."sourceId"=d.id) AS "variantCount",
      (d."sourceRevision" IS NOT NULL AND d."sourceRevision"<>s.revision) AS "sourceOutdated"
      FROM documents d LEFT JOIN accounts a ON a.id=d."accountId" LEFT JOIN documents s ON s.id=d."sourceId"
      WHERE ${where} ORDER BY d."updatedAt" DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM documents d WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/documents', async (request, reply) => {
    const input = documentSchema.parse(request.body);
    const document = await db.transaction((sql) => createDocument(sql, workspace(request), input));
    reply.code(201);
    return document;
  });
  app.get('/api/documents/:id', async (request) => getDocument(db, workspace(request), recordId(request)));
  app.put('/api/documents/:id', async (request) => {
    const { expectedRevision, ...input } = documentSchema
      .extend({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    return db.transaction((sql) =>
      saveDocument(sql, workspace(request), recordId(request), expectedRevision, input),
    );
  });
  app.post('/api/documents/:id/variants', async (request, reply) => {
    const { accountId, expectedRevision } = z
      .object({ accountId: z.uuid(), expectedRevision: z.number().int().positive() })
      .parse(request.body);
    const ws = workspace(request);
    const documentId = recordId(request);
    return db.transaction(async (sql) => {
      const source = await owned<ContentDocument>(sql, 'documents', ws, documentId, true);
      if (source.revision !== expectedRevision) throw conflict();
      if (source.sourceId) throw new AppError(400, 'MASTER_REQUIRED', '请从母稿创建平台版本');
      const account = await owned<Account>(sql, 'accounts', ws, accountId);
      if (!account.active) throw new AppError(400, 'ACCOUNT_DISABLED', '该账号已停用，请选择其他账号');
      const variant = await createDocument(
        sql,
        ws,
        { ...documentSchema.parse(source), accountId, status: 'editing' },
        source,
      );
      reply.code(201);
      return variant;
    });
  });
  app.get('/api/documents/:id/revisions', async (request) => {
    const ws = workspace(request);
    const documentId = recordId(request);
    await owned(db, 'documents', ws, documentId);
    return db.rows<DocumentRevision>(
      'SELECT * FROM document_revisions WHERE "workspaceId"=$1 AND "documentId"=$2 ORDER BY revision DESC LIMIT 100',
      [ws, documentId],
    );
  });
  app.post('/api/documents/:id/restore', async (request) => {
    const { revision, expectedRevision } = z
      .object({ revision: z.number().int().positive(), expectedRevision: z.number().int().positive() })
      .parse(request.body);
    const ws = workspace(request);
    const documentId = recordId(request);
    return db.transaction(async (sql) => {
      const [previous] = await sql.rows<DocumentRevision>(
        'SELECT * FROM document_revisions WHERE "workspaceId"=$1 AND "documentId"=$2 AND revision=$3',
        [ws, documentId, revision],
      );
      if (!previous) throw notFound('没有找到该修订');
      return saveDocument(
        sql,
        ws,
        documentId,
        expectedRevision,
        documentSchema.parse(previous.data),
        `恢复第 ${revision} 版`,
      );
    });
  });
  app.get('/api/documents/:id/validation', async (request) => {
    const document = await getDocument(db, workspace(request), recordId(request));
    return {
      revision: document.revision,
      rulesVersion: platformRulesVersion,
      issues: validateDocument(document, document.platform),
    };
  });
  app.get('/api/documents/:id/export', async (request, reply) => {
    const ws = workspace(request);
    const documentId = recordId(request);
    const query = z
      .object({ revision: z.coerce.number().int().positive().optional(), retryActivity: z.uuid().optional() })
      .parse(request.query);
    let document = await getDocument(db, ws, documentId);
    if (query.revision !== undefined) {
      const [revision] = await db.rows<DocumentRevision>(
        'SELECT * FROM document_revisions WHERE "workspaceId"=$1 AND "documentId"=$2 AND revision=$3',
        [ws, documentId, query.revision],
      );
      if (!revision) throw notFound('该版本不存在');
      document = revision.data;
    }
    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="one-creator-${document.id}-v${document.revision}.zip"`,
      );
    return trackExport(
      db,
      ws,
      document.id,
      document.title,
      () => exportDocument(db, ws, config.dataDir, document),
      query.retryActivity,
    );
  });
}
