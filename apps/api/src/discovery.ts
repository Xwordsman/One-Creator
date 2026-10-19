import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Feed } from '@one-creator/core';
import { id, owned, insert, update, checkReference } from '@one-creator/server/records';
import { accountScope } from '@one-creator/server/permissions';
import { createAutomation } from '@one-creator/server/automation';
import { conflict } from '@one-creator/server/errors';
import { workspace, recordId, pagination, like, idempotencyKey, type ApiContext } from './context.js';

const feedInput = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['rss', 'json_feed']),
  url: z.url({ protocol: /^https?$/ }),
  accountId: z.uuid().nullable().default(null),
  enabled: z.boolean().default(true),
  include: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  exclude: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  intervalMinutes: z.number().int().min(5).max(10080).default(60),
});
export async function discoveryRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/feeds', async (request) => {
    const { limit, offset } = pagination(request.query);
    const parameters: unknown[] = [workspace(request)];
    const scope = accountScope(parameters);
    const items = await db.rows(
      `SELECT * FROM feeds WHERE "workspaceId"=$1 AND ${scope} ORDER BY name LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM feeds WHERE "workspaceId"=$1 AND ${scope}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/feeds', async (request, reply) => {
    const input = feedInput.parse(request.body);
    await checkReference(db, 'accounts', workspace(request), input.accountId);
    const feed = await insert(db, 'feeds', { ...input, id: id(), workspaceId: workspace(request) });
    reply.code(201);
    return feed;
  });
  app.put('/api/feeds/:id', async (request) => {
    const { expectedRevision, ...input } = feedInput
      .extend({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    const ws = workspace(request);
    return db.transaction(async (sql) => {
      const current = await owned<Feed>(sql, 'feeds', ws, recordId(request), true);
      if (current.revision !== expectedRevision) throw conflict();
      await checkReference(sql, 'accounts', ws, input.accountId);
      return update(sql, 'feeds', ws, current.id, {
        ...input,
        revision: current.revision + 1,
        nextAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.post('/api/feeds/:id/refresh', async (request, reply) => {
    const job = await db.transaction((sql) =>
      createAutomation(
        sql,
        workspace(request),
        { kind: 'feed_refresh', data: { feedId: recordId(request) } },
        idempotencyKey(request),
      ),
    );
    reply.code(202);
    return job;
  });
  app.get('/api/feed-entries', async (request) => {
    const { q, limit, offset } = pagination(request.query);
    const { feedId, accountId } = z
      .object({ feedId: z.uuid().optional(), accountId: z.uuid().optional() })
      .parse(request.query);
    const parameters: unknown[] = [workspace(request), like(q)];
    let where = 'e."workspaceId"=$1 AND (e.title ILIKE $2 OR e.body ILIKE $2)';
    if (feedId) {
      await owned(db, 'feeds', workspace(request), feedId);
      parameters.push(feedId);
      where += ` AND e."feedId"=$${parameters.length}`;
    }
    if (accountId) {
      parameters.push(accountId);
      where += ` AND (e."accountId" IS NULL OR e."accountId"=$${parameters.length})`;
    }
    where += ` AND ${accountScope(parameters, 'e."accountId"')}`;
    const items = await db.rows(
      `SELECT e.*,f.name AS "feedName",f.kind AS "sourceKind" FROM feed_entries e JOIN feeds f ON f.id=e."feedId" WHERE ${where} ORDER BY COALESCE(e."publishedAt",e."fetchedAt") DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM feed_entries e WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.get('/api/series/:id/contents', async (request) => {
    const series = await owned<{ kind: string; data: { entries: { ideaId: string; date: string }[] } }>(
      db,
      'creator_items',
      workspace(request),
      recordId(request),
    );
    if (series.kind !== 'series') throw conflict('请选择栏目系列');
    const result = [];
    for (const entry of series.data.entries) {
      const idea = await owned(db, 'ideas', workspace(request), entry.ideaId);
      const params: unknown[] = [workspace(request), entry.ideaId];
      const scope = accountScope(params);
      const documents = await db.rows(
        `SELECT id,title,status,revision FROM documents WHERE "workspaceId"=$1 AND "ideaId"=$2 AND ${scope} ORDER BY "createdAt"`,
        params,
      );
      result.push({ ...entry, idea, documents });
    }
    return { items: result };
  });
}
