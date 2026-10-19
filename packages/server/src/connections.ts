import type {
  Account,
  AccountConnection,
  ConnectionInput,
  ConnectionStatus,
  Capability,
} from '@one-creator/core';
import type { AppConfig } from './config.js';
import type { Database, Sql } from './database.js';
import { encryptSecret } from './crypto.js';
import { AppError, conflict } from './errors.js';
import { id, insert, owned, update } from './records.js';

export interface ConnectionRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  method: 'wechat_api';
  appId: string;
  secretCipher: string;
  tokenCipher: string;
  tokenExpiresAt: string | null;
  revision: number;
  status: Exclude<ConnectionStatus, 'unconfigured'>;
  checkedAt: string | null;
  error: string;
  createdAt: string;
  updatedAt: string;
  capabilities: Record<string, Capability>;
}
export const credentialScope = (connection: Pick<ConnectionRecord, 'workspaceId' | 'accountId'>) =>
  `${connection.workspaceId}:${connection.accountId}:wechat_api`;

export async function findConnection(sql: Sql, workspaceId: string, accountId: string) {
  const [connection] = await sql.rows<ConnectionRecord>(
    'SELECT * FROM account_connections WHERE "workspaceId"=$1 AND "accountId"=$2 AND method=\'wechat_api\'',
    [workspaceId, accountId],
  );
  return connection ?? null;
}
export function publicConnection(accountId: string, connection: ConnectionRecord | null): AccountConnection {
  return {
    id: connection?.id ?? null,
    accountId,
    method: 'wechat_api',
    appId: connection?.appId ?? '',
    hasSecret: !!connection?.secretCipher,
    revision: connection?.revision ?? 0,
    status: connection?.status ?? 'unconfigured',
    error: connection?.error ?? '',
    checkedAt: connection?.checkedAt ?? null,
    updatedAt: connection?.updatedAt ?? null,
  };
}
export async function assertNoPendingDrafts(
  sql: Sql,
  workspaceId: string,
  accountId: string,
  allowVerification = false,
) {
  const pending = await sql.rows(
    `SELECT j.id FROM jobs j JOIN publish_tasks p ON p.id=j."publishTaskId"
     WHERE j."workspaceId"=$1 AND p."accountId"=$2 AND j.kind='wechat_draft'
       AND j.status IN (${allowVerification ? "'queued','running'" : "'queued','running','needs_verification'"})
     UNION ALL SELECT id FROM automation_jobs WHERE "workspaceId"=$1 AND "accountId"=$2 AND kind IN ('wechat_publish','browser_publish','browser_verify','browser_login')
       AND status IN (${allowVerification ? "'queued','running'" : "'queued','running','needs_verification'"})
     UNION ALL SELECT id FROM publish_tasks WHERE "workspaceId"=$1 AND "accountId"=$2 AND status='submitted' AND ${allowVerification ? 'false' : 'true'} LIMIT 1`,
    [workspaceId, accountId],
  );
  if (pending.length) throw conflict('这个账号还有执行中或待核对的草稿，请先处理任务再更改连接');
}
export async function saveConnection(
  db: Database,
  config: AppConfig,
  workspaceId: string,
  accountId: string,
  input: ConnectionInput,
) {
  return db.transaction(async (sql) => {
    const account = await owned<Account>(sql, 'accounts', workspaceId, accountId, true);
    if (account.platform !== 'wechat')
      throw new AppError(400, 'CONNECTION_UNSUPPORTED', '当前账号尚未接入自动连接方式');
    const previous = await findConnection(sql, workspaceId, accountId);
    await assertNoPendingDrafts(sql, workspaceId, accountId, previous?.appId === input.appId);
    if (input.expectedRevision !== (previous?.revision ?? 0))
      throw conflict('连接配置已修改，请重新打开后再保存');
    if ((!previous || previous.appId !== input.appId) && !input.appSecret)
      throw new AppError(400, 'SECRET_REQUIRED', '首次连接或更换 AppID 时需要填写 AppSecret');
    const duplicate = await sql.rows(
      'SELECT id FROM account_connections WHERE "workspaceId"=$1 AND "appId"=$2 AND "accountId"<>$3',
      [workspaceId, input.appId, accountId],
    );
    if (duplicate.length) throw conflict('这个 AppID 已绑定到另一个账号，请使用对应的账号档案');
    const data = {
      appId: input.appId,
      secretCipher: input.appSecret
        ? encryptSecret(input.appSecret, config.encryptionKey, credentialScope({ workspaceId, accountId }))
        : previous!.secretCipher,
      tokenCipher: '',
      tokenExpiresAt: null,
      status: 'unchecked',
      checkedAt: null,
      error: '',
      revision: (previous?.revision ?? 0) + 1,
      capabilities: {},
      updatedAt: new Date().toISOString(),
    };
    return previous
      ? update<ConnectionRecord>(sql, 'account_connections', workspaceId, previous.id, data)
      : insert<ConnectionRecord>(sql, 'account_connections', {
          id: id(),
          workspaceId,
          accountId,
          method: 'wechat_api',
          ...data,
        });
  });
}
export async function removeConnection(
  db: Database,
  workspaceId: string,
  accountId: string,
  expectedRevision: number,
) {
  await db.transaction(async (sql) => {
    await owned(sql, 'accounts', workspaceId, accountId, true);
    await assertNoPendingDrafts(sql, workspaceId, accountId);
    const connection = await findConnection(sql, workspaceId, accountId);
    if ((connection?.revision ?? 0) !== expectedRevision) throw conflict('连接已变化，请刷新后再断开');
    await sql.rows('DELETE FROM account_connections WHERE "workspaceId"=$1 AND "accountId"=$2', [
      workspaceId,
      accountId,
    ]);
  });
  return publicConnection(accountId, null);
}
export async function recordConnectionCheck(
  sql: Sql,
  connection: ConnectionRecord,
  status: ConnectionRecord['status'],
  error = '',
) {
  await sql.rows(
    'UPDATE account_connections SET status=$1,error=$2,"checkedAt"=now() WHERE id=$3 AND "workspaceId"=$4 AND revision=$5',
    [status, error, connection.id, connection.workspaceId, connection.revision],
  );
}
