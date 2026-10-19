import type { Sql } from './database.js';

/**
 * Serialize platform mutations for one account across local workers and external nodes.
 * Uncertain results are guarded per publication, so a lease only reflects work that is running now.
 */
export async function acquireAccountLease(
  db: Sql,
  workspaceId: string,
  accountId: string,
  ownerId: string,
  token: string,
) {
  const rows = await db.rows(
    `INSERT INTO account_execution_leases("accountId","workspaceId","ownerId",token,"expiresAt") VALUES($1,$2,$3,$4,now()+interval '3 minutes')
     ON CONFLICT("accountId") DO UPDATE SET "ownerId"=excluded."ownerId",token=excluded.token,"expiresAt"=excluded."expiresAt"
     WHERE account_execution_leases."expiresAt"<now() OR account_execution_leases.token=excluded.token RETURNING "accountId"`,
    [accountId, workspaceId, ownerId, token],
  );
  return !!rows.length;
}
export async function renewAccountLease(db: Sql, ownerId: string, token: string) {
  return !!(
    await db.rows(
      `UPDATE account_execution_leases SET "expiresAt"=now()+interval '3 minutes' WHERE "ownerId"=$1 AND token=$2 AND "expiresAt">now() RETURNING "accountId"`,
      [ownerId, token],
    )
  ).length;
}
export async function releaseAccountLease(db: Sql, ownerId: string, token: string) {
  await db.rows('DELETE FROM account_execution_leases WHERE "ownerId"=$1 AND token=$2', [ownerId, token]);
}
