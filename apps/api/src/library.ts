import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ideaSchema,
  materialSchema,
  type Asset,
  type Idea,
  type IdeaInput,
  type Material,
} from '@one-creator/core';
import type { Sql } from '@one-creator/server/database';
import { checkReference, id, insert, owned, update } from '@one-creator/server/records';
import { AppError, conflict } from '@one-creator/server/errors';
import { assetPath, storeAsset, storeMedia } from '@one-creator/server/files';
import { accountScope, identity } from '@one-creator/server/permissions';
import { createReadStream } from 'node:fs';
import { searchMaterials } from '@one-creator/server/semantic';
import { like, pagination, recordId, workspace, type ApiContext } from './context.js';

/** An idea may collect shared materials or materials owned by its target account. */
async function checkIdeaReferences(sql: Sql, workspaceId: string, input: IdeaInput) {
  await checkReference(sql, 'accounts', workspaceId, input.accountId);
  for (const materialId of new Set(input.materialIds)) {
    const material = await owned<Material>(sql, 'materials', workspaceId, materialId);
    if (material.accountId && material.accountId !== input.accountId)
      throw new AppError(
        400,
        'MATERIAL_SCOPE',
        `「${material.title}」属于另一个账号，请选择共享素材或目标账号的素材`,
      );
  }
}

export async function libraryRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/materials/search', async (request) => {
    const { q, accountId } = z
      .object({ q: z.string().trim().min(1).max(500), accountId: z.uuid().optional() })
      .parse(request.query);
    return searchMaterials(db, config, workspace(request), q, accountId);
  });
  app.get('/api/ideas', async (request) => {
    const ws = workspace(request);
    const { q, limit, offset } = pagination(request.query);
    const { status } = z
      .object({ status: z.enum(['inbox', 'selected', 'parked', 'archived']).optional() })
      .parse(request.query);
    const parameters: unknown[] = [ws, like(q)];
    let where = `"workspaceId"=$1 AND (title ILIKE $2 OR body ILIKE $2 OR tags::text ILIKE $2)`;
    if (status) {
      parameters.push(status);
      where += ' AND status=$3';
    }
    where += ` AND ${accountScope(parameters)}`;
    const items = await db.rows<Idea>(
      `SELECT i.*,(SELECT d.id FROM documents d WHERE d."ideaId"=i.id ORDER BY d."createdAt" LIMIT 1) AS "documentId" FROM ideas i WHERE ${where} ORDER BY "updatedAt" DESC,i.id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM ideas WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/ideas', async (request, reply) => {
    const input = ideaSchema.parse(request.body);
    const ws = workspace(request);
    await checkIdeaReferences(db, ws, input);
    const idea = await insert<Idea>(db, 'ideas', { id: id(), workspaceId: ws, ...input });
    reply.code(201);
    return idea;
  });
  app.put('/api/ideas/:id', async (request) => {
    const input = ideaSchema.parse(request.body);
    const ws = workspace(request);
    await checkIdeaReferences(db, ws, input);
    return update<Idea>(db, 'ideas', ws, recordId(request), {
      ...input,
      updatedAt: new Date().toISOString(),
    });
  });
  app.get('/api/materials', async (request) => {
    const ws = workspace(request);
    const { q, limit, offset } = pagination(request.query);
    const { accountId, archived, kind, shared } = z
      .object({
        accountId: z.uuid().optional(),
        archived: z.enum(['true', 'false']).default('false'),
        kind: z.enum(['text', 'link', 'image']).optional(),
        shared: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    const parameters: unknown[] = [ws, like(q), archived === 'true'];
    let where =
      '"workspaceId"=$1 AND (title ILIKE $2 OR body ILIKE $2 OR tags::text ILIKE $2) AND archived=$3';
    if (accountId) {
      await checkReference(db, 'accounts', ws, accountId);
      parameters.push(accountId);
      where += ` AND ("accountId" IS NULL OR "accountId"=$${parameters.length})`;
    } else if (shared === 'true') where += ' AND "accountId" IS NULL';
    if (kind) {
      parameters.push(kind);
      where += ` AND kind=$${parameters.length}`;
    }
    where += ` AND ${accountScope(parameters)}`;
    const items = await db.rows<Material>(
      `SELECT * FROM materials WHERE ${where} ORDER BY "updatedAt" DESC,id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM materials WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/materials', async (request, reply) => {
    const input = materialSchema.parse(request.body);
    const ws = workspace(request);
    await checkReference(db, 'accounts', ws, input.accountId);
    await checkReference(db, 'assets', ws, input.assetId);
    if (input.kind === 'image' && !input.assetId) throw new AppError(400, 'IMAGE_REQUIRED', '请选择一张图片');
    const result = await insert<Material>(db, 'materials', { id: id(), workspaceId: ws, ...input });
    reply.code(201);
    return result;
  });
  app.put('/api/materials/:id', async (request) => {
    const input = materialSchema
      .extend({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    const { expectedRevision, ...data } = input;
    const ws = workspace(request);
    const materialId = recordId(request);
    return db.transaction(async (sql) => {
      const current = await owned<Material>(sql, 'materials', ws, materialId, true);
      if (current.revision !== expectedRevision) throw conflict();
      await checkReference(sql, 'accounts', ws, data.accountId);
      await checkReference(sql, 'assets', ws, data.assetId);
      if (data.kind === 'image' && !data.assetId) throw new AppError(400, 'IMAGE_REQUIRED', '请选择一张图片');
      return update<Material>(sql, 'materials', ws, materialId, {
        ...data,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.get('/api/materials/:id/references', async (request) => {
    const ws = workspace(request);
    const material = await owned<Material>(db, 'materials', ws, recordId(request));
    const parameters: unknown[] = [ws, JSON.stringify([material.id])];
    let match = 'd."materialIds" @> $2::jsonb';
    // Image materials are also in use wherever their file is attached or chosen as a cover.
    if (material.assetId) {
      parameters.push(JSON.stringify([material.assetId]), material.assetId);
      match += ' OR d."assetIds" @> $3::jsonb OR d."coverAssetId"=$4';
    }
    const documentScope = accountScope(parameters, 'd."accountId"');
    const documents = await db.rows(
      `SELECT d.id,d.title,d.revision,d."sourceId",a.name AS "accountName" FROM documents d LEFT JOIN accounts a ON a.id=d."accountId" WHERE d."workspaceId"=$1 AND (${match}) AND ${documentScope} ORDER BY d."updatedAt" DESC LIMIT 100`,
      parameters,
    );
    const ideaParameters: unknown[] = [ws, JSON.stringify([material.id])];
    const ideaScope = accountScope(ideaParameters);
    const ideas = await db.rows(
      `SELECT id,title,status FROM ideas WHERE "workspaceId"=$1 AND "materialIds" @> $2::jsonb AND ${ideaScope} ORDER BY "updatedAt" DESC LIMIT 100`,
      ideaParameters,
    );
    return { documents, ideas };
  });
  app.post('/api/assets', async (request, reply) => {
    const input = z
      .object({ accountId: z.uuid().optional(), documentId: z.uuid().optional() })
      .parse(request.query);
    let accountId: string | null = input.accountId ?? null;
    if (input.documentId)
      accountId = (
        await owned<{ accountId: string | null }>(db, 'documents', workspace(request), input.documentId)
      ).accountId;
    await checkReference(db, 'accounts', workspace(request), accountId);
    const file = await request.file();
    if (!file) throw new AppError(400, 'FILE_REQUIRED', '请选择图片文件');
    const buffer = await file.toBuffer();
    const asset = await storeAsset(db, workspace(request), config.dataDir, file.filename, buffer, {
      accountId,
      createdBy: identity()?.id,
    });
    reply.code(asset.duplicate ? 200 : 201);
    return asset;
  });
  app.get('/api/assets/:id', async (request, reply) => {
    const asset = await owned<Asset>(db, 'assets', workspace(request), recordId(request));
    reply
      .header('Content-Type', asset.mime)
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff');
    reply.header('Accept-Ranges', 'bytes');
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      const start = match?.[1]
        ? Number(match[1])
        : match?.[2]
          ? Math.max(0, asset.size - Number(match[2]))
          : NaN;
      const end = match?.[1] && match[2] ? Math.min(asset.size - 1, Number(match[2])) : asset.size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= asset.size
      )
        return reply.code(416).header('Content-Range', `bytes */${asset.size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${asset.size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(assetPath(config.dataDir, asset.storageKey), { start, end }));
    }
    reply.header('Content-Length', asset.size);
    return reply.send(createReadStream(assetPath(config.dataDir, asset.storageKey)));
  });
  app.post('/api/media', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.uuid().optional() }).parse(request.query);
    await checkReference(db, 'accounts', workspace(request), accountId);
    const file = await request.file({ limits: { fileSize: 128 * 1024 * 1024, files: 1 } });
    if (!file) throw new AppError(400, 'FILE_REQUIRED', '请选择媒体文件');
    const asset = await storeMedia(
      db,
      workspace(request),
      config.dataDir,
      file.filename,
      await file.toBuffer(),
      { accountId: accountId ?? null, createdBy: identity()?.id },
    );
    reply.code(asset.duplicate ? 200 : 201);
    return asset;
  });
  app.get('/api/assets', async (request) => {
    const { limit, offset } = pagination(request.query);
    const ws = workspace(request);
    const { kind } = z.object({ kind: z.enum(['image', 'media']).optional() }).parse(request.query);
    const parameters: unknown[] = [ws];
    let scope = accountScope(parameters);
    if (kind === 'media') scope += " AND (mime LIKE 'video/%' OR mime LIKE 'audio/%')";
    if (kind === 'image') scope += " AND mime LIKE 'image/%'";
    const items = await db.rows<Asset>(
      `SELECT * FROM assets WHERE "workspaceId"=$1 AND ${scope} ORDER BY "createdAt" DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM assets WHERE "workspaceId"=$1 AND ${scope}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
}
