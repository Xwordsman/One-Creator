import { z } from 'zod';
import type {
  Account,
  AutomationJob,
  ExecutionNode,
  BrowserConnection,
  PublishTask,
  Capability,
} from '@one-creator/core';
import { browserProfiles, allowedBrowserUrl } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import type { AutomationInput } from './automation-types.js';
import { id, owned, insert, update } from './records.js';
import { newToken, tokenHash, encryptSecret, decryptSecret } from './crypto.js';
import { AppError, conflict } from './errors.js';
import { acquireAccountLease, renewAccountLease, releaseAccountLease } from './execution-leases.js';
import { storeAsset } from './files.js';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface NodeRecord extends ExecutionNode {
  workspaceId: string;
  tokenHash: string;
  instanceId: string | null;
}
export const nodeInput = z.object({
  name: z.string().trim().min(1).max(100),
  accountIds: z.array(z.uuid()).min(1).max(500),
  platforms: z
    .array(z.enum(['xiaohongshu', 'toutiao', 'zhihu', 'baijiahao', 'bilibili']))
    .min(1)
    .max(5),
  active: z.boolean().default(true),
});
export function nodeView(node: NodeRecord): ExecutionNode {
  const { id, name, prefix, accountIds, platforms, active, lastSeenAt, agentVersion, reported } = node;
  return { id, name, prefix, accountIds, platforms, active, lastSeenAt, agentVersion, reported };
}
export const online = (node: Pick<NodeRecord, 'active' | 'lastSeenAt'>) =>
  node.active && !!node.lastSeenAt && Date.parse(node.lastSeenAt) > Date.now() - 60000;
export async function registerNode(db: Database, ws: string, payload: unknown) {
  const data = nodeInput.parse(payload);
  for (const accountId of data.accountIds) await owned(db, 'accounts', ws, accountId);
  const token = `ocn_${newToken()}`;
  const node = await insert<NodeRecord>(db, 'execution_nodes', {
    id: id(),
    workspaceId: ws,
    ...data,
    tokenHash: tokenHash(token),
    prefix: token.slice(0, 12),
  });
  return { node: nodeView(node), token };
}
export async function authenticateNode(db: Database, authorization: unknown, instanceId: unknown) {
  const value = z
      .string()
      .regex(/^Bearer ocn_[\w-]+$/)
      .parse(authorization),
    instance = z.uuid().parse(instanceId);
  const [node] = await db.rows<NodeRecord>(
    'SELECT * FROM execution_nodes WHERE "tokenHash"=$1 AND active=true',
    [tokenHash(value.slice(7))],
  );
  if (!node) throw new AppError(401, 'NODE_TOKEN', '节点令牌无效或已撤销');
  if (node.instanceId && node.instanceId !== instance && online(node))
    throw conflict('此节点令牌已有在线实例，请为另一个执行器单独注册');
  return { ...node, instanceId: instance };
}
export async function saveBrowserConnection(
  db: Database,
  ws: string,
  accountId: string,
  nodeId: string,
  selectors: Record<string, string> = {},
) {
  return db.transaction(async (sql) => {
    const account = await owned<Account>(sql, 'accounts', ws, accountId, true);
    if (!(account.platform in browserProfiles))
      throw new AppError(400, 'BROWSER_PLATFORM', '此平台没有浏览器适配器');
    const node = await owned<NodeRecord>(sql, 'execution_nodes', ws, nodeId);
    if (
      !node.active ||
      !node.accountIds.includes(accountId) ||
      !node.platforms.includes(account.platform as never)
    )
      throw new AppError(403, 'NODE_SCOPE', '节点未获准执行这个账号 / 平台');
    for (const key of ['loginUrl', 'publishUrl', 'listUrl'])
      if (
        selectors[key] &&
        !allowedBrowserUrl(account.platform as keyof typeof browserProfiles, selectors[key])
      )
        throw new AppError(400, 'BROWSER_URL', '浏览器地址必须属于所选平台的已知域名');
    const pending = await sql.rows(
      "SELECT id FROM automation_jobs WHERE \"workspaceId\"=$1 AND \"accountId\"=$2 AND kind LIKE 'browser_%' AND status IN ('queued','running','needs_verification') LIMIT 1",
      [ws, accountId],
    );
    if (pending.length) throw conflict('先完成或核对当前浏览器任务，再更换连接');
    const [result] = await sql.rows<BrowserConnection>(
      `INSERT INTO browser_connections(id,"workspaceId","accountId","nodeId",platform,selectors) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT("accountId") DO UPDATE SET "nodeId"=excluded."nodeId",platform=excluded.platform,selectors=excluded.selectors,status='unconfigured',identity='',error='',"checkedAt"=NULL,"screenshotAssetId"=NULL,"updatedAt"=now() RETURNING *`,
      [id(), ws, accountId, nodeId, account.platform, JSON.stringify(selectors)],
    );
    return result;
  });
}
/**
 * Selectors are written against public pages and change without notice, so a channel counts as
 * supported only after this account has a publication the node verified on the platform itself.
 */
export async function browserPublishCapability(
  sql: Sql,
  ws: string,
  account: Account,
  connection: { status: string; nodeOnline?: boolean; identity: string; error: string } | null,
): Promise<Capability> {
  const profile = browserProfiles[account.platform as keyof typeof browserProfiles];
  if (!profile) return { status: 'unsupported', reason: '此平台没有浏览器发布适配器，可导出后手动发布' };
  if (!account.active) return { status: 'unsupported', reason: '账号已停用' };
  if (!connection) return { status: 'unsupported', reason: `尚未为账号配置执行节点（${profile.name}）` };
  if (connection.status !== 'connected')
    return { status: 'unknown', reason: connection.error || '浏览器账号尚未完成扫码登录与身份核对' };
  if (!connection.nodeOnline) return { status: 'unknown', reason: '执行节点当前不在线，任务会排队等待节点' };
  const [verified] = await sql.rows<{ at: string }>(
    `SELECT "publicationCheckedAt" AS at FROM publish_tasks WHERE "workspaceId"=$1 AND "accountId"=$2 AND status='published' AND "resultSource"='node_observed' ORDER BY "publicationCheckedAt" DESC LIMIT 1`,
    [ws, account.id],
  );
  return verified
    ? {
        status: 'supported',
        reason: `${profile.name}：账号 ${connection.identity} 已有经节点核验的发布记录；平台改版后请留意截图`,
      }
    : {
        status: 'unknown',
        reason: `${profile.name}：适配器尚未在这个账号上完成核验，首次发布请对照截图确认，结果不确定时会进入待核对`,
      };
}
export async function browserConnection(sql: Sql, ws: string, accountId: string) {
  const [result] = await sql.rows<BrowserConnection & { nodeActive: boolean; lastSeenAt: string | null }>(
    `SELECT b.*,n.active AS "nodeActive",n."lastSeenAt" FROM browser_connections b JOIN execution_nodes n ON n.id=b."nodeId" WHERE b."workspaceId"=$1 AND b."accountId"=$2`,
    [ws, accountId],
  );
  return result
    ? { ...result, nodeOnline: online({ active: result.nodeActive, lastSeenAt: result.lastSeenAt }) }
    : null;
}
export async function authorizeBrowserJob(
  sql: Sql,
  ws: string,
  account: Account | null,
  kind: string,
  data: Record<string, unknown>,
) {
  if (!account || !(account.platform in browserProfiles))
    throw new AppError(400, 'BROWSER_ACCOUNT', '请选择支持浏览器通道的账号');
  const node = await owned<NodeRecord>(sql, 'execution_nodes', ws, String(data.nodeId));
  if (
    !node.active ||
    !node.accountIds.includes(account.id) ||
    !node.platforms.includes(account.platform as never)
  )
    throw new AppError(403, 'NODE_SCOPE', '节点没有这个账号和平台的执行授权');
  const connection = await browserConnection(sql, ws, account.id);
  if (!connection || connection.nodeId !== node.id || connection.platform !== account.platform)
    throw new AppError(400, 'BROWSER_CONNECTION', '请先在账号中选择这个节点并保存连接');
  if (kind !== 'browser_login' && (connection.status !== 'connected' || !connection.identity))
    throw new AppError(400, 'BROWSER_LOGIN', '请先扫码登录并确认实际账号身份');
  if (kind === 'browser_publish' && !account.active)
    throw new AppError(400, 'ACCOUNT_DISABLED', '账号已停用');
  return connection;
}
async function jobForNode(db: Database, node: NodeRecord, jobId: string, leaseToken: string) {
  const [job] = await db.rows<
    AutomationJob & {
      leaseToken: string | null;
      leaseUntil: string | null;
      nodeInstanceId: string | null;
      nodeId: string | null;
    }
  >('SELECT * FROM automation_jobs WHERE id=$1 AND "workspaceId"=$2 AND "nodeId"=$3', [
    jobId,
    node.workspaceId,
    node.id,
  ]);
  if (
    !job ||
    !job.accountId ||
    !node.accountIds.includes(job.accountId) ||
    job.status !== 'running' ||
    job.leaseToken !== leaseToken ||
    job.nodeInstanceId !== node.instanceId ||
    Date.parse(job.leaseUntil ?? '') <= Date.now()
  )
    throw new AppError(409, 'NODE_LEASE', '任务执行权无效、已取消或已过期');
  return job;
}
export async function claimNodeJob(
  db: Database,
  node: NodeRecord,
  report: { version?: string; capabilities?: unknown },
) {
  await db.rows(
    'UPDATE execution_nodes SET "lastSeenAt"=now(),"instanceId"=$1,"agentVersion"=$2,reported=$3 WHERE id=$4',
    [node.instanceId, report.version ?? '', JSON.stringify(report.capabilities ?? {}), node.id],
  );
  await db.rows('DELETE FROM node_commands WHERE "expiresAt"<now()');
  const [job] = await db.rows<AutomationJob>(
    `SELECT j.* FROM automation_jobs j WHERE j."workspaceId"=$1 AND j."nodeId"=$2 AND j.status='queued' AND j.kind LIKE 'browser_%'
   AND NOT EXISTS(SELECT 1 FROM automation_jobs active WHERE active."nodeId"=$2 AND active.status='running')
   AND NOT EXISTS(SELECT 1 FROM account_execution_leases l WHERE l."accountId"=j."accountId" AND l."expiresAt">now())
   ORDER BY j."createdAt" LIMIT 1`,
    [node.workspaceId, node.id],
  );
  if (!job || !job.accountId) return null;
  const token = id();
  if (!(await acquireAccountLease(db, node.workspaceId, job.accountId, job.id, token))) return null;
  try {
    const claimed = await db.transaction(async (sql) => {
      const current = await owned<AutomationJob>(sql, 'automation_jobs', node.workspaceId, job.id, true);
      if (current.status !== 'queued') return null;
      if (!node.accountIds.includes(job.accountId!))
        throw new AppError(403, 'NODE_SCOPE', '节点已不再获准执行这个账号');
      const input = current.input as unknown as AutomationInput;
      const account = await owned<Account>(sql, 'accounts', node.workspaceId, job.accountId!);
      const connection = await authorizeBrowserJob(sql, node.workspaceId, account, job.kind, input.data);
      let publication: PublishTask | null = null;
      if (input.data.publishTaskId) {
        publication = await owned<PublishTask>(
          sql,
          'publish_tasks',
          node.workspaceId,
          String(input.data.publishTaskId),
          true,
        );
        if (job.kind === 'browser_publish') {
          if (!['planned', 'waiting_user'].includes(publication.status))
            throw conflict('这项计划的状态已变化，不能再次提交');
          await sql.rows(
            `UPDATE publish_tasks SET status='submitting',operation='browser',channel='browser',"nodeId"=$1,"updatedAt"=now() WHERE id=$2`,
            [node.id, publication.id],
          );
        }
      }
      const lease = await sql.rows(
        `UPDATE automation_jobs SET status='running',stage='preparing',"startedAt"=now(),"leaseToken"=$1,"leaseUntil"=now()+interval '3 minutes',"nodeInstanceId"=$2 WHERE id=$3 RETURNING id`,
        [token, node.instanceId, job.id],
      );
      if (!lease.length) return null;
      const document = publication?.snapshot ?? input.document;
      const assetIds = boundAssets(document);
      const assets = [];
      for (const assetId of assetIds) {
        const asset = await owned<Record<string, unknown>>(sql, 'assets', node.workspaceId, assetId);
        assets.push({ id: asset.id, filename: asset.filename, mime: asset.mime, size: asset.size });
      }
      return {
        id: job.id,
        kind: job.kind,
        leaseToken: token,
        account: {
          id: account.id,
          name: account.name,
          platform: account.platform,
          handle: connection.identity || account.handle,
        },
        selectors: connection.selectors,
        document,
        assets,
        submittedAt: publication?.submittedAt ?? null,
        resetSession: !!input.data.resetSession,
      };
    });
    if (!claimed) await releaseAccountLease(db, job.id, token);
    return claimed;
  } catch (error) {
    await releaseAccountLease(db, job.id, token);
    if (!(error instanceof AppError)) throw error;
    // A job that can never start must leave the node queue, otherwise it blocks every later job.
    await db.transaction(async (sql) => {
      const rows = await sql.rows<{ publishTaskId: string | null }>(
        `UPDATE automation_jobs SET status='failed',error=$1,"finishedAt"=now() WHERE id=$2 AND status='queued' RETURNING "publishTaskId"`,
        [error.message, job.id],
      );
      if (rows[0]?.publishTaskId && job.kind === 'browser_publish')
        await sql.rows(
          `UPDATE publish_tasks SET status='waiting_user',"platformResult"=jsonb_build_object('scheduleError',$1::text),"updatedAt"=now() WHERE id=$2 AND status='planned'`,
          [error.message, rows[0].publishTaskId],
        );
    });
    return null;
  }
}
export async function nodeHeartbeat(
  db: Database,
  node: NodeRecord,
  jobId: string,
  token: string,
  stage: string,
  progress: Record<string, unknown>,
) {
  await jobForNode(db, node, jobId, token);
  if (!['preparing', 'waiting_user', 'uploading', 'filling', 'publishing', 'verifying'].includes(stage))
    throw new AppError(400, 'NODE_STAGE', '未知节点阶段');
  await db.transaction(async (sql) => {
    if (!(await renewAccountLease(sql, jobId, token))) throw conflict('账号执行权已过期');
    const rows = await sql.rows(
      `UPDATE automation_jobs SET stage=$1,progress=progress||$2::jsonb,"leaseUntil"=now()+interval '3 minutes' WHERE id=$3 AND "leaseToken"=$4 AND status='running' RETURNING "publishTaskId",kind`,
      [stage, JSON.stringify(progress), jobId, token],
    );
    if (!rows.length) throw conflict('任务已停止');
    if (stage === 'publishing')
      await sql.rows(
        'UPDATE publish_tasks SET "submittedAt"=COALESCE("submittedAt",now()),"updatedAt"=now() WHERE id=$1',
        [rows[0].publishTaskId],
      );
  });
  await db.rows('UPDATE execution_nodes SET "lastSeenAt"=now() WHERE id=$1', [node.id]);
}
export const loginScreenPath = (dataDir: string, jobId: string) =>
  path.join(dataDir, 'browser-login', `${z.uuid().parse(jobId)}.png`);
export async function removeLoginScreen(dataDir: string, jobId: string) {
  await rm(loginScreenPath(dataDir, jobId), { force: true });
}
export async function nodeScreenshot(
  db: Database,
  config: AppConfig,
  node: NodeRecord,
  jobId: string,
  token: string,
  bytes: Buffer,
) {
  const job = await jobForNode(db, node, jobId, token);
  if (bytes.length > 4 * 1024 * 1024 || bytes.subarray(1, 4).toString() !== 'PNG')
    throw new AppError(400, 'SCREENSHOT_FORMAT', '截图必须是 4 MB 以内的 PNG');
  if (job.kind === 'browser_login') {
    // A login screen may show a QR code or account data: one overwritten file, admin-only, never a library asset.
    const target = loginScreenPath(config.dataDir, jobId),
      temp = `${target}.${id()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, target);
    await db.rows(
      `UPDATE automation_jobs SET progress=jsonb_set(progress,'{screenVersion}',to_jsonb(COALESCE((progress->>'screenVersion')::int,0)+1),true) WHERE id=$1 AND "leaseToken"=$2 AND status='running'`,
      [jobId, token],
    );
    await db.rows(
      `UPDATE browser_connections SET status='waiting_user',"updatedAt"=now() WHERE "accountId"=$1 AND "nodeId"=$2 AND status<>'connected'`,
      [job.accountId, node.id],
    );
    return { ok: true };
  }
  const evidence = (job.progress.evidenceAssetIds ?? []) as string[];
  if (evidence.length >= 6) return { ok: true, skipped: true };
  const asset = await storeAsset(db, node.workspaceId, config.dataDir, 'browser-evidence.png', bytes, {
    accountId: job.accountId,
    metadata: { nodeId: node.id, jobId, kind: 'browser_evidence' },
  });
  await db.rows(
    `UPDATE automation_jobs SET progress=jsonb_set(jsonb_set(progress,'{screenshotAssetId}',to_jsonb($1::text),true),'{evidenceAssetIds}',COALESCE(progress->'evidenceAssetIds','[]'::jsonb)||to_jsonb($1::text),true) WHERE id=$2 AND "leaseToken"=$3 AND status='running'`,
    [asset.id, jobId, token],
  );
  return { assetId: asset.id };
}
export async function nodeResult(
  db: Database,
  config: AppConfig,
  node: NodeRecord,
  jobId: string,
  token: string,
  result: {
    state: string;
    identity?: string;
    url?: string;
    message?: string;
    receipt?: Record<string, unknown>;
  },
) {
  const original = await jobForNode(db, node, jobId, token);
  await db.transaction(async (sql) => {
    const job = await owned<AutomationJob>(sql, 'automation_jobs', node.workspaceId, jobId, true);
    const account = await owned<Account>(sql, 'accounts', node.workspaceId, job.accountId!);
    if (!node.platforms.includes(account.platform as never))
      throw new AppError(403, 'NODE_PLATFORM', '节点平台授权已改变');
    let status: AutomationJob['status'] = 'succeeded';
    let output: Record<string, unknown> = { ...result, source: 'node_observed' };
    if (job.kind === 'browser_login') {
      if (result.state !== 'connected' || !result.identity) {
        status = 'failed';
        await sql.rows(
          `UPDATE browser_connections SET status='expired',error=$1,"checkedAt"=now() WHERE "accountId"=$2`,
          [result.message ?? '未完成登录', account.id],
        );
      } else if (account.handle && account.handle !== result.identity) {
        status = 'failed';
        output = { ...output, message: '识别到的账号与档案 ID 不一致' };
        await sql.rows(
          `UPDATE browser_connections SET status='mismatch',identity=$1,error='登录账号与档案不一致',"checkedAt"=now() WHERE "accountId"=$2`,
          [result.identity, account.id],
        );
      } else
        await sql.rows(
          `UPDATE browser_connections SET status=$1,identity=$2,error='',"checkedAt"=now(),"updatedAt"=now() WHERE "accountId"=$3`,
          [account.handle ? 'connected' : 'waiting_confirmation', result.identity, account.id],
        );
      output.pendingConfirmation = !account.handle && !!result.identity;
    } else {
      const task = await owned<PublishTask>(
        sql,
        'publish_tasks',
        node.workspaceId,
        String((job.input as unknown as AutomationInput).data.publishTaskId),
        true,
      );
      if (['published', 'submitted'].includes(result.state) && result.identity !== account.handle)
        throw conflict('执行器返回的账号身份不一致');
      if (result.receipt?.connectionState === 'expired' || result.receipt?.connectionState === 'mismatch')
        await sql.rows(
          'UPDATE browser_connections SET status=$1,error=$2,"checkedAt"=now() WHERE "accountId"=$3 AND "nodeId"=$4',
          [result.receipt.connectionState, result.message ?? '浏览器账号需要重新验证', account.id, node.id],
        );
      if (
        result.state === 'published' &&
        result.url &&
        allowedBrowserUrl(account.platform as keyof typeof browserProfiles, result.url)
      ) {
        await sql.rows(
          `UPDATE publish_tasks SET status='published',url=$1,"resultSource"='node_observed',"publicationCheckedAt"=now(),"platformResult"=$2,"updatedAt"=now() WHERE id=$3`,
          [result.url, JSON.stringify({ ...result, source: 'node_observed' }), task.id],
        );
        if (job.kind === 'browser_verify')
          await sql.rows(
            `UPDATE automation_jobs SET status='succeeded',stage='done',error='',result=$1,"finishedAt"=now() WHERE "publishTaskId"=$2 AND kind='browser_publish' AND status='needs_verification'`,
            [JSON.stringify({ ...result, verifiedBy: job.id }), task.id],
          );
      } else if (result.state === 'submitted')
        await sql.rows(
          `UPDATE publish_tasks SET status='submitted',"platformResult"=$1,"updatedAt"=now() WHERE id=$2`,
          [JSON.stringify(result), task.id],
        );
      else if (job.kind === 'browser_verify')
        output = {
          ...output,
          found: false,
          message: result.message ?? '没有足够证据证明发布结果，继续保持原状态',
        };
      else if (['publishing', 'verifying'].includes(job.stage)) {
        status = 'needs_verification';
        await sql.rows(
          `UPDATE publish_tasks SET status='verification_required',"platformResult"=$1,"updatedAt"=now() WHERE id=$2`,
          [JSON.stringify(result), task.id],
        );
      } else {
        status = 'failed';
        await sql.rows(
          `UPDATE publish_tasks SET status='waiting_user',"platformResult"=$1,"updatedAt"=now() WHERE id=$2`,
          [JSON.stringify(result), task.id],
        );
      }
    }
    const updated = await sql.rows(
      `UPDATE automation_jobs SET status=$1,stage=CASE WHEN $1='succeeded' THEN 'done' ELSE stage END,result=$2,error=$3,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$4 AND "leaseToken"=$5 AND status='running' AND "leaseUntil">now() RETURNING id`,
      [
        status,
        JSON.stringify(output),
        status === 'succeeded' ? '' : String(output.message ?? '节点任务未完成'),
        job.id,
        token,
      ],
    );
    if (!updated.length) throw conflict('迟到的节点结果已忽略');
  });
  await releaseAccountLease(db, original.id, token);
  if (original.kind === 'browser_login') await removeLoginScreen(config.dataDir, original.id);
  return { ok: true };
}
export async function nodeCommands(
  db: Database,
  config: AppConfig,
  node: NodeRecord,
  jobId: string,
  token: string,
) {
  const job = await jobForNode(db, node, jobId, token);
  if (job.kind !== 'browser_login') return [];
  const rows = await db.rows<{ id: string; commandCipher: string }>(
    'SELECT id,"commandCipher" FROM node_commands WHERE "jobId"=$1 AND "nodeId"=$2 AND "expiresAt">now() ORDER BY "createdAt"',
    [jobId, node.id],
  );
  return rows.map((row) => ({
    id: row.id,
    ...JSON.parse(
      decryptSecret(row.commandCipher, config.encryptionKey, `${node.workspaceId}:command:${jobId}`),
    ),
  }));
}
export async function queueNodeCommand(
  db: Database,
  config: AppConfig,
  ws: string,
  jobId: string,
  value: unknown,
) {
  const command = z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('click'), x: z.number().min(0).max(3000), y: z.number().min(0).max(3000) }),
      z.object({ kind: z.literal('type'), text: z.string().max(1000) }),
      z.object({ kind: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace']) }),
    ])
    .parse(value);
  const job = await owned<AutomationJob & { nodeId: string }>(db, 'automation_jobs', ws, jobId);
  if (job.kind !== 'browser_login' || job.status !== 'running' || job.stage !== 'waiting_user')
    throw conflict('仅在当前登录交互阶段接收操作');
  await insert(db, 'node_commands', {
    id: id(),
    workspaceId: ws,
    nodeId: job.nodeId,
    jobId,
    commandCipher: encryptSecret(JSON.stringify(command), config.encryptionKey, `${ws}:command:${jobId}`),
  });
  return { ok: true };
}
function boundAssets(document: AutomationInput['document']) {
  return [
    ...new Set([
      ...(document?.assetIds ?? []),
      ...(document?.coverAssetId ? [document.coverAssetId] : []),
      ...(document?.videoAssetId ? [document.videoAssetId] : []),
      ...[...(document?.body ?? '').matchAll(/\/api\/assets\/([a-f\d-]{36})/g)].map((match) => match[1]),
    ]),
  ];
}
export async function nodeAsset(
  db: Database,
  node: NodeRecord,
  jobId: string,
  token: string,
  assetId: string,
) {
  const job = await jobForNode(db, node, jobId, token),
    input = job.input as unknown as AutomationInput;
  const publication = input.data.publishTaskId
    ? await owned<PublishTask>(db, 'publish_tasks', node.workspaceId, String(input.data.publishTaskId))
    : null;
  const document = publication?.snapshot ?? input.document;
  if (!document || !boundAssets(document).includes(assetId))
    throw new AppError(403, 'NODE_ASSET', '此文件不属于节点正在执行的任务');
  return owned<{ storageKey: string; mime: string; size: number }>(db, 'assets', node.workspaceId, assetId);
}
