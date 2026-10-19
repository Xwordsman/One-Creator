import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, newToken, tokenHash } from '@one-creator/server/crypto';
import { accountScope } from '@one-creator/server/permissions';
import { id, owned, insert, update, checkReference } from '@one-creator/server/records';
import { conflict } from '@one-creator/server/errors';
import { validateProviderUrl } from '@one-creator/server/ai';
import { pagination, recordId, workspace, type ApiContext } from './context.js';

const grants = z.array(z.uuid()).max(500).nullable().default(null);
const memberInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(['admin', 'editor', 'viewer']),
  accountIds: grants,
  active: z.boolean().default(true),
});
const tokenScopes = z.enum(['content:read', 'content:write', 'ai:run', 'publish:write', 'settings:admin']);
const priceInput = z.object({
  baseUrl: z.url(),
  model: z.string().trim().min(1).max(150),
  currency: z.enum(['CNY', 'USD']),
  inputPerMillion: z.number().min(0).max(1000000).nullable(),
  outputPerMillion: z.number().min(0).max(1000000).nullable(),
  unitPrice: z.number().min(0).max(1000000).nullable().default(null),
});

export async function administrationRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/members', async (request) => ({
    items: await db.rows(
      'SELECT id,username,name,role,active,"accountIds","createdAt" FROM users WHERE "workspaceId"=$1 ORDER BY "createdAt"',
      [workspace(request)],
    ),
  }));
  app.post('/api/members', async (request, reply) => {
    const input = memberInput
      .extend({
        username: z
          .string()
          .trim()
          .min(3)
          .max(40)
          .regex(/^[a-zA-Z0-9_.-]+$/),
        password: z.string().min(10).max(200),
      })
      .parse(request.body);
    const ws = workspace(request);
    for (const accountId of input.accountIds ?? []) await checkReference(db, 'accounts', ws, accountId);
    const { password, ...data } = input;
    const member = await insert<{ id: string }>(db, 'users', {
      ...data,
      username: data.username.toLowerCase(),
      id: id(),
      workspaceId: ws,
      passwordHash: await hashPassword(password),
    });
    reply.code(201);
    return {
      id: member.id,
      username: data.username,
      name: data.name,
      role: data.role,
      active: data.active,
      accountIds: data.accountIds,
    };
  });
  app.put('/api/members/:id', async (request) => {
    const input = memberInput.parse(request.body);
    const ws = workspace(request);
    const userId = recordId(request);
    return db.transaction(async (sql) => {
      await sql.rows('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws]);
      const current = await owned<{ role: string }>(sql, 'users', ws, userId, true);
      if (current.role === 'admin' && (!input.active || input.role !== 'admin')) {
        const others = await sql.rows(
          'SELECT id FROM users WHERE "workspaceId"=$1 AND role=\'admin\' AND active=true AND id<>$2',
          [ws, userId],
        );
        if (!others.length) throw conflict('工作空间至少保留一名启用的管理员');
      }
      for (const accountId of input.accountIds ?? []) await checkReference(sql, 'accounts', ws, accountId);
      await update(sql, 'users', ws, userId, input);
      if (!input.active) {
        await sql.rows('DELETE FROM sessions WHERE "userId"=$1', [userId]);
        await sql.rows('UPDATE api_tokens SET "revokedAt"=now() WHERE "userId"=$1', [userId]);
      }
      return { id: userId, ...input };
    });
  });
  app.get('/api/tokens', async (request) => ({
    items: await db.rows(
      'SELECT id,name,prefix,scopes,"accountIds","expiresAt","revokedAt","lastUsedAt","createdAt" FROM api_tokens WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC',
      [workspace(request)],
    ),
  }));
  app.post('/api/tokens', async (request, reply) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(tokenScopes).min(1).max(5),
        accountIds: grants,
        days: z.number().int().min(1).max(365).default(30),
      })
      .parse(request.body);
    const ws = workspace(request);
    for (const accountId of input.accountIds ?? []) await checkReference(db, 'accounts', ws, accountId);
    const token = `oc_${newToken()}`;
    const tokenId = id();
    const expiresAt = new Date(Date.now() + input.days * 86400000).toISOString();
    await insert(db, 'api_tokens', {
      id: tokenId,
      workspaceId: ws,
      userId: request.user!.id,
      name: input.name,
      hash: tokenHash(token),
      prefix: token.slice(0, 12),
      scopes: input.scopes,
      accountIds: input.accountIds,
      expiresAt,
    });
    reply.code(201);
    return { id: tokenId, token, expiresAt };
  });
  app.delete('/api/tokens/:id', async (request) => {
    await update(db, 'api_tokens', workspace(request), recordId(request), {
      revokedAt: new Date().toISOString(),
    });
    return { ok: true };
  });
  app.get('/api/notifications', async (request) => {
    const ws = workspace(request);
    const { limit, offset } = pagination(request.query);
    const parameters: unknown[] = [ws, request.user!.id];
    const scope = accountScope(parameters, 'n."accountId"');
    const items = await db.rows(
      `SELECT n.*,r."readAt" FROM notifications n LEFT JOIN notification_reads r ON r."notificationId"=n.id AND r."userId"=$2 WHERE n."workspaceId"=$1 AND ${scope} ORDER BY n."createdAt" DESC,n.id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [counts] = await db.rows<{ total: number; unread: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE r."readAt" IS NULL)::int AS unread FROM notifications n LEFT JOIN notification_reads r ON r."notificationId"=n.id AND r."userId"=$2 WHERE n."workspaceId"=$1 AND ${scope}`,
      parameters,
    );
    return { items, ...counts, limit, offset };
  });
  app.post('/api/notifications/read', async (request) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).max(500) }).parse(request.body);
    const ws = workspace(request);
    for (const noticeId of ids) {
      await owned(db, 'notifications', ws, noticeId);
      await db.rows(
        'INSERT INTO notification_reads("workspaceId","notificationId","userId") VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [ws, noticeId, request.user!.id],
      );
    }
    return { ok: true };
  });
  app.get('/api/model-prices', async (request) => ({
    items: await db.rows('SELECT * FROM model_prices WHERE "workspaceId"=$1 ORDER BY model', [
      workspace(request),
    ]),
  }));
  app.post('/api/model-prices', async (request) => {
    const input = priceInput.parse(request.body);
    const baseUrl = validateProviderUrl(input.baseUrl);
    const [price] = await db.rows(
      `INSERT INTO model_prices(id,"workspaceId","baseUrl",model,currency,"inputPerMillion","outputPerMillion","unitPrice") VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT("workspaceId","baseUrl",model) DO UPDATE SET currency=excluded.currency,"inputPerMillion"=excluded."inputPerMillion","outputPerMillion"=excluded."outputPerMillion","unitPrice"=excluded."unitPrice",revision=model_prices.revision+1,"updatedAt"=now() RETURNING *`,
      [
        id(),
        workspace(request),
        baseUrl,
        input.model,
        input.currency,
        input.inputPerMillion,
        input.outputPerMillion,
        input.unitPrice,
      ],
    );
    return price;
  });
  app.get('/api/usage', async (request) => {
    const { limit, offset } = pagination(request.query);
    const filter = z
      .object({
        accountId: z.uuid().optional(),
        jobId: z.uuid().optional(),
        model: z.string().optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
      })
      .parse(request.query);
    const parameters: unknown[] = [workspace(request)];
    let where = '"workspaceId"=$1';
    for (const field of ['accountId', 'jobId', 'model'] as const)
      if (filter[field]) {
        parameters.push(filter[field]);
        where += ` AND "${field}"=$${parameters.length}`;
      }
    if (filter.from) {
      parameters.push(filter.from);
      where += ` AND "createdAt">=$${parameters.length}`;
    }
    if (filter.to) {
      parameters.push(filter.to);
      where += ` AND "createdAt"<$${parameters.length}`;
    }
    where += ` AND ${accountScope(parameters)}`;
    const items = await db.rows(
      `SELECT * FROM usage_entries WHERE ${where} ORDER BY "createdAt" DESC,id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM usage_entries WHERE ${where}`,
      parameters,
    );
    const totals = await db.rows(
      `SELECT currency,sum(cost)::text AS "knownCost",count(*) FILTER(WHERE cost IS NULL)::int AS "unknownCosts",sum("inputTokens")::text AS "inputTokens",sum("outputTokens")::text AS "outputTokens",count(*) FILTER(WHERE "usageSource"='estimated')::int AS estimates FROM usage_entries WHERE ${where} GROUP BY currency`,
      parameters,
    );
    return { items, total, totals, limit, offset };
  });
}
