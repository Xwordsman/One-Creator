import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionUser } from '@one-creator/core';
import type { Sql } from './database.js';
import { AppError, notFound } from './errors.js';

export const accessContext = new AsyncLocalStorage<{ user: SessionUser | null }>();
export const identity = () => accessContext.getStore()?.user ?? null;
export function canAccessAccount(accountId: string | null | undefined, user = identity()) {
  return !user || !accountId || user.accountIds === null || user.accountIds.includes(accountId);
}
export function accountScope(parameters: unknown[], column = '"accountId"', shared = true) {
  const user = identity();
  if (!user || user.accountIds === null) return 'true';
  parameters.push(JSON.stringify(user.accountIds));
  return `(${shared ? `${column} IS NULL OR ` : ''}${column}::text IN (SELECT jsonb_array_elements_text($${parameters.length}::jsonb)))`;
}
export function automationScope(parameters: unknown[], alias = 'j') {
  const user = identity();
  if (!user || user.accountIds === null) return 'true';
  parameters.push(JSON.stringify(user.accountIds));
  const permitted = `SELECT jsonb_array_elements_text($${parameters.length}::jsonb)`;
  return `((${alias}."accountId" IS NULL OR ${alias}."accountId"::text IN (${permitted}))
  AND (${alias}.input->'document'->>'accountId' IS NULL OR ${alias}.input->'document'->>'accountId' IN (${permitted}))
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(${alias}.input->'references','{}')) r WHERE r.value->>'accountId' IS NOT NULL AND r.value->>'accountId' NOT IN (${permitted})))`;
}
export async function checkRecordAccess(sql: Sql, table: string, row: Record<string, unknown>) {
  const user = identity();
  if (!user) return;
  if (
    table === 'assets' &&
    (row.metadata as Record<string, unknown> | undefined)?.sensitive &&
    user.role !== 'admin'
  )
    throw notFound();
  if (row.workspaceId && row.workspaceId !== user.workspaceId) throw notFound();
  let accountId = (table === 'accounts' ? row.id : row.accountId) as string | null | undefined;
  if (table === 'jobs') accountId = (row.input as { document?: { accountId?: string } })?.document?.accountId;
  if (table === 'automation_jobs') {
    if (row.kind === 'browser_login' && user.role !== 'admin') throw notFound();
    const input = row.input as {
      document?: { accountId?: string };
      references?: Record<string, { accountId?: string }>;
    };
    if (
      !canAccessAccount(input.document?.accountId, user) ||
      Object.values(input.references ?? {}).some((reference) => !canAccessAccount(reference.accountId, user))
    )
      throw notFound();
  }
  if (table === 'document_revisions') accountId = (row.data as { accountId?: string })?.accountId;
  if (table === 'activities' && row.documentId) {
    const [document] = await sql.rows<{ accountId: string | null }>(
      'SELECT "accountId" FROM documents WHERE id=$1 AND "workspaceId"=$2',
      [row.documentId, user.workspaceId],
    );
    accountId = document?.accountId;
  }
  if (!canAccessAccount(accountId, user)) {
    if (table === 'assets') {
      // References are authorized before content saves, so a guessed UUID cannot bootstrap a grant.
      const parameters: unknown[] = [row.id, user.workspaceId];
      const scope = accountScope(parameters, 'd."accountId"');
      const documents = await sql.rows(
        `SELECT d.id FROM documents d WHERE d."workspaceId"=$2 AND ${scope}
        AND (d."assetIds" @> jsonb_build_array($1::text) OR d."coverAssetId"=$1::uuid OR strpos(d.body,'/api/assets/'||$1::text)>0) LIMIT 1`,
        parameters,
      );
      if (documents.length) return;
      const materialParameters: unknown[] = [row.id, user.workspaceId];
      const materialScope = accountScope(materialParameters);
      const materials = await sql.rows(
        `SELECT id FROM materials WHERE "workspaceId"=$2 AND "assetId"=$1::uuid AND ${materialScope} LIMIT 1`,
        materialParameters,
      );
      if (materials.length) return;
    }
    throw notFound();
  }
}
export function authorize(method: string, pathname: string, user: SessionUser) {
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const management =
    /^\/api\/(members|tokens|webhooks|nodes|model-prices)(?:\/|$)/.test(pathname) ||
    /^\/api\/settings\/(backup|providers)(?:\/|$)/.test(pathname) ||
    (!read &&
      /^\/api\/(settings\/model|accounts\/[^/]+\/(connection|browser-connection|browser-login|confirm-browser-identity))/.test(
        pathname,
      )) ||
    /^\/api\/automation\/[^/]+\/(browser-command|browser-screen)$/.test(pathname);
  if (management && user.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '此操作需要管理员权限');
  if (management && user.accountIds !== null && !/^\/api\/(accounts\/[^/]+\/|automation\/)/.test(pathname))
    throw new AppError(403, 'WORKSPACE_SCOPE', '工作空间管理需要全部账号的授权范围');
  if (
    !read &&
    user.role === 'viewer' &&
    !['/api/auth/logout', '/api/notifications/read', '/api/mcp'].includes(pathname)
  )
    throw new AppError(403, 'READ_ONLY', '当前成员为只读角色');
  if (!user.tokenScopes || pathname === '/api/mcp') return;
  const scope = management
    ? 'settings:admin'
    : read
      ? 'content:read'
      : /\/apply$|\/adopt-preference$/.test(pathname)
        ? 'content:write'
        : /\/publishing(?:\/|$)/.test(pathname)
          ? 'publish:write'
          : /^\/api\/(jobs|automation)(?:\/|$)/.test(pathname)
            ? 'ai:run'
            : 'content:write';
  if (!user.tokenScopes.includes(scope)) throw new AppError(403, 'TOKEN_SCOPE', `访问令牌缺少 ${scope} 权限`);
}
