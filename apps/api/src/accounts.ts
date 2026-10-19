import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountSchema, personaSchema, platformSchema, type Account, type Persona } from '@one-creator/core';
import { conflict } from '@one-creator/server/errors';
import { checkReference, id, insert, owned, update } from '@one-creator/server/records';
import { writingContext } from '@one-creator/server/content';
import { findConnection, assertNoPendingDrafts } from '@one-creator/server/connections';
import { accountCapabilities } from '@one-creator/server/platforms/index';
import { accountScope } from '@one-creator/server/permissions';
import { browserConnection, browserPublishCapability } from '@one-creator/server/nodes';
import { like, pagination, recordId, workspace, type ApiContext } from './context.js';

export async function accountRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/accounts', async (request) => {
    const { q, limit, offset } = pagination(request.query);
    const ws = workspace(request);
    const { platform, category } = z
      .object({ platform: platformSchema.optional(), category: z.string().trim().min(1).max(50).optional() })
      .parse(request.query);
    const parameters: unknown[] = [ws, like(q)];
    let where = 'a."workspaceId"=$1 AND (a.name ILIKE $2 OR a.category ILIKE $2 OR a.handle ILIKE $2)';
    if (platform) {
      parameters.push(platform);
      where += ` AND a.platform=$${parameters.length}`;
    }
    if (category) {
      parameters.push(category);
      where += ` AND a.category=$${parameters.length}`;
    }
    where += ` AND ${accountScope(parameters, 'a.id', false)}`;
    const items = await db.rows<Account>(
      `SELECT a.*,p.name AS "personaName",(SELECT count(*)::int FROM documents d WHERE d."accountId"=a.id AND d.status<>'archived') AS "documentCount" FROM accounts a LEFT JOIN personas p ON p.id=a."personaId" WHERE ${where} ORDER BY a."createdAt" DESC,a.id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM accounts a WHERE ${where}`,
      parameters,
    );
    return { items, total, limit, offset };
  });
  app.get('/api/accounts/categories', async (request) => {
    const parameters: unknown[] = [workspace(request)];
    const scope = accountScope(parameters, 'id', false);
    const rows = await db.rows<{ category: string }>(
      `SELECT DISTINCT category FROM accounts WHERE "workspaceId"=$1 AND category<>'' AND ${scope} ORDER BY category`,
      parameters,
    );
    return rows.map((row) => row.category);
  });
  app.post('/api/accounts', async (request, reply) => {
    const input = accountSchema.parse(request.body);
    const ws = workspace(request);
    await checkReference(db, 'personas', ws, input.personaId);
    const result = await insert<Account>(db, 'accounts', { id: id(), workspaceId: ws, ...input });
    reply.code(201);
    return result;
  });
  app.put('/api/accounts/:id', async (request) => {
    const input = accountSchema.parse(request.body);
    const ws = workspace(request);
    return db.transaction(async (sql) => {
      const account = await owned<Account>(sql, 'accounts', ws, recordId(request), true);
      if (input.platform !== account.platform || input.handle !== account.handle) {
        await assertNoPendingDrafts(sql, ws, account.id);
        if (input.platform !== account.platform && (await findConnection(sql, ws, account.id)))
          throw conflict('请先断开平台连接，再更改账号平台');
        if (await browserConnection(sql, ws, account.id))
          throw conflict('请先断开浏览器连接，再更改平台或真实账号 ID');
      }
      await checkReference(sql, 'personas', ws, input.personaId);
      return update<Account>(sql, 'accounts', ws, account.id, {
        ...input,
        updatedAt: new Date().toISOString(),
      });
    });
  });
  app.get('/api/accounts/:id/context', async (request) =>
    writingContext(db, workspace(request), recordId(request)),
  );
  app.get('/api/accounts/:id/capabilities', async (request) => {
    const account = await owned<Account>(db, 'accounts', workspace(request), recordId(request));
    const capabilities = accountCapabilities(
      account,
      await findConnection(db, workspace(request), account.id),
    );
    if (account.platform !== 'wechat') {
      const browser = await browserConnection(db, workspace(request), account.id);
      capabilities.capabilities.publish = await browserPublishCapability(
        db,
        workspace(request),
        account,
        browser,
      );
      capabilities.capabilities.schedule =
        capabilities.capabilities.publish.status === 'unsupported'
          ? capabilities.capabilities.publish
          : {
              status: capabilities.capabilities.publish.status,
              reason: '可选择到时由执行节点发布；节点离线时任务排队，错过时间按计划设置处理',
            };
    }
    return capabilities;
  });
  app.get('/api/personas', async (request) => {
    const { limit, offset, q } = pagination(request.query);
    const ws = workspace(request);
    const items = await db.rows<Persona>(
      'SELECT * FROM personas WHERE "workspaceId"=$1 AND name ILIKE $2 ORDER BY "updatedAt" DESC LIMIT $3 OFFSET $4',
      [ws, like(q), limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      'SELECT count(*)::int AS total FROM personas WHERE "workspaceId"=$1 AND name ILIKE $2',
      [ws, like(q)],
    );
    return { items, total, limit, offset };
  });
  app.post('/api/personas', async (request, reply) => {
    const input = personaSchema.parse(request.body);
    const ws = workspace(request);
    return db.transaction(async (sql) => {
      const persona = await insert<Persona>(sql, 'personas', { id: id(), workspaceId: ws, ...input });
      await insert(sql, 'persona_revisions', {
        id: id(),
        workspaceId: ws,
        personaId: persona.id,
        revision: 1,
        data: persona,
      });
      reply.code(201);
      return persona;
    });
  });
  app.put('/api/personas/:id', async (request) => {
    const input = personaSchema.extend({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const { expectedRevision, ...data } = input;
    const ws = workspace(request);
    const personaId = recordId(request);
    return db.transaction(async (sql) => {
      const current = await owned<Persona>(sql, 'personas', ws, personaId, true);
      if (current.revision !== expectedRevision) throw conflict();
      const persona = await update<Persona>(sql, 'personas', ws, personaId, {
        ...data,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await insert(sql, 'persona_revisions', {
        id: id(),
        workspaceId: ws,
        personaId,
        revision: persona.revision,
        data: persona,
      });
      return persona;
    });
  });
  app.get('/api/personas/:id/revisions', async (request) => {
    const ws = workspace(request);
    const personaId = recordId(request);
    await owned(db, 'personas', ws, personaId);
    return db.rows(
      'SELECT id,revision,data,"createdAt" FROM persona_revisions WHERE "workspaceId"=$1 AND "personaId"=$2 ORDER BY revision DESC',
      [ws, personaId],
    );
  });
}
