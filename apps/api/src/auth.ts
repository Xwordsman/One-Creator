import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionUser } from '@one-creator/core';
import { hashPassword, newToken, tokenHash, verifyPassword } from '@one-creator/server/crypto';
import { AppError, conflict } from '@one-creator/server/errors';
import { id, insert } from '@one-creator/server/records';
import type { Sql } from '@one-creator/server/database';
import type { ApiContext } from './context.js';

const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(200),
});
const cookieName = 'one_creator_session';
export async function findSession(sql: Sql, request: FastifyRequest): Promise<SessionUser | null> {
  const bearer = request.headers.authorization?.match(/^Bearer (oc_[A-Za-z0-9_-]{20,180})$/)?.[1];
  if (request.headers.authorization && !bearer) return null;
  if (bearer) {
    const [record] = await sql.rows<
      SessionUser & { scopes: string[]; tokenAccountIds: string[] | null; tokenId: string }
    >(
      `SELECT u.id,u.username,u.name,u."workspaceId",u.role,u."accountIds",w.name AS "workspaceName",t.scopes,t."accountIds" AS "tokenAccountIds",t.id AS "tokenId"
       FROM api_tokens t JOIN users u ON u.id=t."userId" JOIN workspaces w ON w.id=u."workspaceId"
       WHERE t.hash=$1 AND t."workspaceId"=u."workspaceId" AND t."revokedAt" IS NULL AND t."expiresAt">now() AND u.active=true`,
      [tokenHash(bearer)],
    );
    if (!record) return null;
    await sql.rows('UPDATE api_tokens SET "lastUsedAt"=now() WHERE id=$1', [record.tokenId]);
    const accountIds =
      record.accountIds === null
        ? record.tokenAccountIds
        : record.tokenAccountIds === null
          ? record.accountIds
          : record.accountIds.filter((accountId) => record.tokenAccountIds!.includes(accountId));
    return {
      id: record.id,
      username: record.username,
      name: record.name,
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName,
      role: record.role,
      accountIds,
      tokenScopes: record.scopes,
    };
  }
  const token = request.cookies[cookieName];
  if (!token || token.length > 200) return null;
  const [user] = await sql.rows<SessionUser>(
    `SELECT u.id,u.username,u.name,u."workspaceId",u.role,u."accountIds",w.name AS "workspaceName" FROM sessions s JOIN users u ON u.id=s."userId" JOIN workspaces w ON w.id=u."workspaceId" WHERE s.hash=$1 AND s."expiresAt">now() AND u.active=true`,
    [tokenHash(token)],
  );
  return user ?? null;
}
export async function authRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  const cookie = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookie,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  };
  async function issueSession(sql: Sql, userId: string, reply: FastifyReply) {
    const token = newToken();
    await sql.rows('DELETE FROM sessions WHERE "expiresAt"<=now()');
    await sql.rows(
      'INSERT INTO sessions(hash,"userId","expiresAt") VALUES($1,$2,now()+interval \'7 days\')',
      [tokenHash(token), userId],
    );
    reply.setCookie(cookieName, token, cookie);
  }
  app.get('/api/auth/bootstrap', { config: { public: true } }, async (request) => {
    const [{ count }] = await db.rows<{ count: number }>('SELECT count(*)::int AS count FROM users');
    return {
      needsSetup: count === 0,
      user: await findSession(db, request),
      version: '0.1.0-alpha.1',
      database: db.kind,
    };
  });
  app.post(
    '/api/auth/setup',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentials
        .extend({
          name: z.string().trim().min(1).max(80),
          workspaceName: z.string().trim().min(1).max(80).default('我的创作空间'),
        })
        .parse(request.body);
      const passwordHash = await hashPassword(input.password);
      return db.transaction(async (sql) => {
        await sql.rows('SELECT id FROM installation WHERE id=1 FOR UPDATE');
        const existing = await sql.rows('SELECT id FROM users LIMIT 1');
        if (existing.length) throw conflict('工作台已初始化，请直接登录');
        const workspaceId = id();
        const userId = id();
        await insert(sql, 'workspaces', { id: workspaceId, name: input.workspaceName });
        await insert(sql, 'users', {
          id: userId,
          workspaceId,
          username: input.username,
          name: input.name,
          passwordHash,
        });
        await issueSession(sql, userId, reply);
        reply.code(201);
        return {
          id: userId,
          username: input.username,
          name: input.name,
          workspaceId,
          workspaceName: input.workspaceName,
        };
      });
    },
  );
  app.post(
    '/api/auth/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentials.parse(request.body);
      const [user] = await db.rows<SessionUser & { passwordHash: string }>(
        'SELECT u.*,w.name AS "workspaceName" FROM users u JOIN workspaces w ON w.id=u."workspaceId" WHERE username=$1',
        [input.username],
      );
      const valid = await verifyPassword(
        input.password,
        user?.passwordHash ?? `scrypt$one-creator$${'0'.repeat(128)}`,
      );
      if (!user || !valid || !(user as unknown as { active: boolean }).active)
        throw new AppError(401, 'LOGIN_FAILED', '账号、密码不正确或成员已停用');
      await issueSession(db, user.id, reply);
      return {
        id: user.id,
        username: user.username,
        name: user.name,
        workspaceId: user.workspaceId,
        workspaceName: user.workspaceName,
      };
    },
  );
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) await db.rows('DELETE FROM sessions WHERE hash=$1', [tokenHash(token)]);
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });
}
