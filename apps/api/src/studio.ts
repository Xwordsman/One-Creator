import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  studioKindSchema,
  studioSchemas,
  studioInputSchema,
  studioNames,
  type StudioItem,
} from '@one-creator/core';
import { createItem, saveItem, item, csvExport } from '@one-creator/server/studio';
import { accountScope } from '@one-creator/server/permissions';
import { owned, update } from '@one-creator/server/records';
import { like, pagination, recordId, workspace, type ApiContext } from './context.js';

export async function studioRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/reference-options', async (request) => {
    const ws = workspace(request);
    const collect = async (
      table: string,
      label: string,
      extra = '',
      column = '"accountId"',
      shared = true,
    ) => {
      const params: unknown[] = [ws];
      const scope = accountScope(params, column, shared);
      return db.rows(
        `SELECT id,${label} AS label${extra} FROM ${table} WHERE "workspaceId"=$1 AND ${scope} ORDER BY ${label} LIMIT 2000`,
        params,
      );
    };
    const [
      accounts,
      documents,
      materials,
      ideas,
      personas,
      items,
      feeds,
      feedEntries,
      assets,
      publications,
      metrics,
      models,
      capabilities,
    ] = await Promise.all([
      collect('accounts', 'name', ',platform', 'id', false),
      collect('documents', 'title', ',revision,"accountId"'),
      collect('materials', 'title', ',revision,"accountId"'),
      collect('ideas', 'title'),
      db.rows('SELECT id,name AS label,revision FROM personas WHERE "workspaceId"=$1 ORDER BY name', [ws]),
      collect('creator_items', 'name', ',kind,revision,"accountId"'),
      collect('feeds', 'name'),
      collect('feed_entries', 'title', ',"feedId"'),
      collect('assets', 'filename', ',mime,size'),
      collect('publish_tasks', "snapshot->>'title'", ',status,"documentId"'),
      collect('metric_snapshots', '"capturedAt"::text', ',"publishTaskId",basis'),
      db.rows('SELECT model,name FROM providers WHERE "workspaceId"=$1', [ws]),
      db.rows('SELECT capability,model,name FROM capability_providers WHERE "workspaceId"=$1', [ws]),
    ]);
    return {
      accounts,
      documents,
      materials,
      ideas,
      personas,
      items,
      feeds,
      feedEntries,
      assets,
      publications,
      metrics,
      models: models.map((row) => ({ id: row.model, label: `${row.name} / ${row.model}` })),
      capabilities: capabilities.map((row) => ({
        id: row.capability,
        kind: row.capability,
        label: `${row.name} / ${row.model}`,
      })),
    };
  });
  app.get('/api/studio/catalog', async () =>
    Object.fromEntries(
      Object.entries(studioSchemas).map(([kind, schema]) => [
        kind,
        {
          name: studioNames[kind as keyof typeof studioSchemas],
          schema: z.toJSONSchema(schema, { io: 'input' }),
        },
      ]),
    ),
  );
  app.get('/api/studio/items', async (request) => {
    const { kind, accountId, archived } = z
      .object({
        kind: studioKindSchema.optional(),
        accountId: z.uuid().optional(),
        archived: z.enum(['true', 'false']).default('false'),
      })
      .parse(request.query);
    const { q, limit, offset } = pagination(request.query);
    const parameters: unknown[] = [workspace(request), like(q), archived === 'true'];
    let where = '"workspaceId"=$1 AND (name ILIKE $2 OR data::text ILIKE $2) AND archived=$3';
    if (kind) {
      parameters.push(kind);
      where += ` AND kind=$${parameters.length}`;
    }
    if (accountId) {
      await owned(db, 'accounts', workspace(request), accountId);
      parameters.push(accountId);
      where += ` AND ("accountId" IS NULL OR "accountId"=$${parameters.length})`;
    }
    where += ` AND ${accountScope(parameters)}`;
    const items = await db.rows<StudioItem>(
      `SELECT * FROM creator_items WHERE ${where} ORDER BY "updatedAt" DESC,id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM creator_items WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/studio/items', async (request, reply) => {
    const result = await db.transaction((sql) => createItem(sql, workspace(request), request.body));
    reply.code(201);
    return result;
  });
  app.get('/api/studio/items/:id', async (request) => item(db, workspace(request), recordId(request)));
  app.put('/api/studio/items/:id', async (request) => {
    const { expectedRevision, ...input } = studioInputSchema
      .extend({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    return db.transaction((sql) =>
      saveItem(sql, workspace(request), recordId(request), expectedRevision, input),
    );
  });
  app.get('/api/studio/items/:id/revisions', async (request) => {
    await item(db, workspace(request), recordId(request));
    return db.rows(
      'SELECT revision,data,"createdAt" FROM creator_item_revisions WHERE "workspaceId"=$1 AND "itemId"=$2 ORDER BY revision DESC',
      [workspace(request), recordId(request)],
    );
  });
  app.delete('/api/studio/items/:id', async (request) => {
    const current = await item(db, workspace(request), recordId(request));
    return db.transaction((sql) =>
      saveItem(sql, workspace(request), current.id, current.revision, { ...current, archived: true }),
    );
  });
  app.get('/api/studio/items/:id/export', async (request, reply) => {
    const current = await item(db, workspace(request), recordId(request));
    reply.header('Content-Disposition', `attachment; filename="creator-${current.kind}.json"`);
    return {
      format: 'one-creator-resource',
      version: 1,
      resource: { kind: current.kind, name: current.name, accountId: null, data: current.data },
    };
  });
  app.post('/api/studio/import', async (request, reply) => {
    const input = z
      .object({
        format: z.literal('one-creator-resource'),
        version: z.literal(1),
        resource: studioInputSchema,
      })
      .parse(request.body);
    const result = await db.transaction((sql) => createItem(sql, workspace(request), input.resource));
    reply.code(201);
    return result;
  });
  app.get('/api/collaborations/export', async (request, reply) => {
    const params: unknown[] = [workspace(request)];
    const scope = accountScope(params);
    const records = await db.rows<StudioItem>(
      `SELECT * FROM creator_items WHERE "workspaceId"=$1 AND kind='collaboration' AND archived=false AND ${scope} ORDER BY "updatedAt" DESC`,
      params,
    );
    // Linked content is listed by title; only documents the reader may see are named.
    const linked = [...new Set(records.flatMap((row) => (row.data.documentIds ?? []) as string[]))];
    const docParams: unknown[] = [workspace(request), linked];
    const docScope = accountScope(docParams);
    const titles = new Map(
      (linked.length
        ? await db.rows<{ id: string; title: string }>(
            `SELECT id,title FROM documents WHERE "workspaceId"=$1 AND id::text=ANY($2::text[]) AND ${docScope}`,
            docParams,
          )
        : []
      ).map((row) => [row.id, row.title]),
    );
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="collaborations.csv"');
    return csvExport([
      ['名称', '合作方', '联系方式', '关联内容', '金额', '已收', '币种', '到期', '状态', '备注'],
      ...records.map((row) => [
        row.name,
        row.data.partner,
        row.data.contact,
        ((row.data.documentIds ?? []) as string[])
          .map((id) => titles.get(id) ?? '（无权查看或已删除）')
          .join('；'),
        row.data.amount,
        row.data.paid,
        row.data.currency,
        row.data.dueDate,
        row.data.status,
        row.data.notes,
      ]),
    ]);
  });
}
