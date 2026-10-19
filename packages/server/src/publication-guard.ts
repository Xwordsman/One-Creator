import { browserProfiles, type Account, type PublishTask } from '@one-creator/core';
import type { Sql } from './database.js';
import { owned } from './records.js';
import { AppError, conflict } from './errors.js';
import { findConnection } from './connections.js';
import { draftCapability, publicationCapability } from './platforms/index.js';
import { browserConnection } from './nodes.js';

export interface ExecutionPlan {
  executionMode: PublishTask['executionMode'];
  scheduledAt: string | null;
  nodeId?: string | null;
}
/** Validate an automatic execution choice before it is stored on a plan. */
export async function checkExecutionPlan(
  sql: Sql,
  workspaceId: string,
  account: Account,
  plan: ExecutionPlan,
) {
  if (plan.executionMode === 'manual') return { nodeId: null };
  if (!plan.scheduledAt) throw new AppError(400, 'SCHEDULE_REQUIRED', '自动执行需要设置计划时间');
  if (Date.parse(plan.scheduledAt) < Date.now() + 30000)
    throw new AppError(400, 'SCHEDULE_PAST', '自动执行的计划时间需要晚于当前至少 30 秒');
  if (!account.active) throw new AppError(400, 'ACCOUNT_DISABLED', '账号已停用');
  if (plan.executionMode === 'wechat_draft' || plan.executionMode === 'wechat_publish') {
    if (account.platform !== 'wechat')
      throw new AppError(400, 'CHANNEL_PLATFORM', '只有公众号账号可以使用官方草稿或正式发布');
    const connection = await findConnection(sql, workspaceId, account.id);
    const draft = draftCapability(account, connection);
    if (draft.status !== 'supported') throw new AppError(400, 'CHANNEL_UNAVAILABLE', draft.reason);
    if (plan.executionMode === 'wechat_publish') {
      const publish = publicationCapability(account, connection);
      if (publish.status === 'unsupported') throw new AppError(400, 'CHANNEL_UNAVAILABLE', publish.reason);
    }
    return { nodeId: null };
  }
  if (!(account.platform in browserProfiles))
    throw new AppError(400, 'CHANNEL_PLATFORM', '此平台没有浏览器发布适配器');
  const connection = await browserConnection(sql, workspaceId, account.id);
  if (!connection) throw new AppError(400, 'BROWSER_CONNECTION', '请先为账号选择执行节点并完成扫码登录');
  if (plan.nodeId && plan.nodeId !== connection.nodeId)
    throw conflict('所选节点不是这个账号当前绑定的执行节点');
  if (connection.status !== 'connected')
    throw new AppError(400, 'BROWSER_LOGIN', '浏览器账号尚未完成登录与身份核对');
  return { nodeId: connection.nodeId };
}

const publishKinds = ['wechat_publish', 'browser_publish'];
const verifyKinds = ['wechat_verify', 'browser_verify'];

/** Pre-submission rules shared by manual requests, schedules and the public API. */
export async function guardPublication(
  sql: Sql,
  workspaceId: string,
  kind: string,
  taskId: string,
  account: Account | null,
  data: Record<string, unknown>,
) {
  if (![...publishKinds, ...verifyKinds].includes(kind)) return;
  const task = await owned<PublishTask>(sql, 'publish_tasks', workspaceId, taskId, true);
  if (!account || account.id !== task.accountId) throw conflict('发布计划与目标账号不一致');
  if (task.snapshot.context.account?.platform !== account.platform)
    throw conflict('账号平台已变化，请从当前账号建立新的发布计划');
  const active = await sql.rows<{ kind: string }>(
    `SELECT kind FROM automation_jobs WHERE "publishTaskId"=$1 AND status IN ('queued','running') LIMIT 1`,
    [task.id],
  );
  if (active.length) throw conflict('这项计划已有正在排队或执行的平台任务，请等待其结束');
  if (verifyKinds.includes(kind)) {
    if (kind === 'wechat_verify' && account.platform !== 'wechat')
      throw conflict('只有公众号计划可以查询官方发布结果');
    if (
      kind === 'wechat_verify' &&
      !task.publishId &&
      task.status !== 'verification_required' &&
      !data.publishId
    )
      throw conflict('这项计划还没有可查询的发布任务');
    if (
      kind === 'browser_verify' &&
      !['submitted', 'verification_required', 'published'].includes(task.status)
    )
      throw conflict('只能核对已提交、待核对或已发布的浏览器计划');
    return;
  }
  if (!account.active) throw new AppError(400, 'ACCOUNT_DISABLED', '账号已停用');
  const uncertain = await sql.rows(
    `SELECT id FROM automation_jobs WHERE "publishTaskId"=$1 AND kind=ANY($2::text[]) AND status='needs_verification' LIMIT 1`,
    [task.id, publishKinds],
  );
  if (uncertain.length || task.status === 'verification_required')
    throw conflict('上一次提交结果不确定，请先核对平台结果，不能直接重发');
  if (kind === 'wechat_publish') {
    if (account.platform !== 'wechat') throw conflict('只有公众号账号可以使用官方发布');
    if (!['draft_saved', 'publish_failed'].includes(task.status) || !task.platformDraftId)
      throw new AppError(400, 'DRAFT_REQUIRED', '请先保存官方草稿，再选择这份草稿正式发布');
    const capability = publicationCapability(account, await findConnection(sql, workspaceId, account.id));
    if (capability.status === 'unsupported')
      throw new AppError(400, 'CHANNEL_UNAVAILABLE', capability.reason);
    return;
  }
  if (!(account.platform in browserProfiles)) throw conflict('此平台没有浏览器发布适配器');
  if (!['planned', 'waiting_user'].includes(task.status))
    throw conflict('这项计划已提交、发布或取消，不能再次提交');
  if (account.platform === 'bilibili' && !task.snapshot.videoAssetId)
    throw new AppError(400, 'VIDEO_REQUIRED', 'B 站视频投稿需要在稿件中选择视频文件');
}
