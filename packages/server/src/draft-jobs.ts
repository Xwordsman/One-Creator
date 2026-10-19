import type { Account, DraftPayload, JobProgress, PublishTask, WorkerJob } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import { AppError, conflict } from './errors.js';
import { findConnection, type ConnectionRecord } from './connections.js';
import { id, owned } from './records.js';
import { draftAdapter, draftCapability } from './platforms/index.js';
import { WechatError } from './platforms/wechat.js';
import type { DraftContext } from './platforms/types.js';
import { reportJob, withHeartbeat } from './task-state.js';
import { acquireAccountLease } from './execution-leases.js';

export async function createDraftJob(
  sql: Sql,
  workspaceId: string,
  taskId: string,
  key: string,
): Promise<WorkerJob> {
  const original = await owned<PublishTask>(sql, 'publish_tasks', workspaceId, taskId);
  // Connection mutations lock this same account, preventing credential changes during task creation.
  const account = await owned<Account>(sql, 'accounts', workspaceId, original.accountId, true);
  const task = await owned<PublishTask>(sql, 'publish_tasks', workspaceId, taskId, true);
  const [existing] = await sql.rows<WorkerJob>(
    'SELECT * FROM jobs WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
    [workspaceId, key],
  );
  if (existing) {
    if (existing.kind !== 'wechat_draft' || existing.publishTaskId !== task.id)
      throw conflict('请求编号已用于另一项任务');
    return existing;
  }
  if (task.status === 'verification_required') throw conflict('平台写入结果尚未确定，请先核对草稿箱');
  if (task.status === 'submitting') throw conflict('这项草稿任务正在执行，请等待结果');
  if (task.platformDraftId || !['planned', 'waiting_user'].includes(task.status))
    throw conflict('这项计划已保存草稿、发布或取消，不能再次提交');
  if (task.snapshot.context.account?.platform !== account.platform)
    throw conflict('账号平台已变化，请从当前账号建立新的发布计划');
  const connection = await findConnection(sql, workspaceId, account.id);
  const capability = draftCapability(account, connection);
  if (capability.status !== 'supported' || !connection)
    throw new AppError(400, 'CHANNEL_UNAVAILABLE', capability.reason);
  if (!task.snapshot.coverAssetId)
    throw new AppError(400, 'COVER_REQUIRED', '此计划的快照没有封面，请设置封面后建立新的发布计划');
  if ([...task.snapshot.title].length > 32)
    throw new AppError(400, 'WECHAT_TITLE', '此快照的标题超过 32 字，请修改后建立新的计划');
  const [previous] = await sql.rows<WorkerJob>(
    'SELECT * FROM jobs WHERE "workspaceId"=$1 AND "publishTaskId"=$2 ORDER BY attempt DESC,"createdAt" DESC LIMIT 1',
    [workspaceId, task.id],
  );
  const reusable =
    previous?.input.connectionId === connection.id &&
    previous.input.connectionRevision === connection.revision;
  const progress: JobProgress = reusable
    ? {
        images: previous.progress.images,
        coverAssetId: previous.progress.coverAssetId,
        coverMediaId: previous.progress.coverMediaId,
      }
    : {};
  const input = {
    document: task.snapshot,
    instruction: '',
    model: '微信公众号官方接口',
    baseUrl: '',
    appId: connection.appId,
    connectionId: connection.id,
    connectionRevision: connection.revision,
  };
  const [created] = await sql.rows<WorkerJob>(
    `INSERT INTO jobs(id,"workspaceId","documentId",kind,input,model,"idempotencyKey","parentId",attempt,"publishTaskId",progress)
     VALUES($1,$2,$3,'wechat_draft',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      id(),
      workspaceId,
      task.documentId,
      JSON.stringify(input),
      input.model,
      key,
      previous?.id ?? null,
      previous ? previous.attempt + 1 : 1,
      task.id,
      JSON.stringify(progress),
    ],
  );
  await sql.rows(
    `UPDATE publish_tasks SET status='submitting',operation='draft',channel='wechat_api',"channelAppId"=$1,"updatedAt"=now() WHERE id=$2`,
    [connection.appId, task.id],
  );
  return created;
}

async function jobConnection(db: Database, job: WorkerJob, readOnly = false): Promise<ConnectionRecord> {
  const task = await owned<PublishTask>(db, 'publish_tasks', job.workspaceId, job.publishTaskId!);
  const connection = await findConnection(db, job.workspaceId, task.accountId);
  if (
    !connection ||
    connection.id !== job.input.connectionId ||
    (!readOnly && connection.revision !== job.input.connectionRevision) ||
    connection.appId !== job.input.appId
  )
    throw conflict('账号连接与任务快照不一致，请重新检查连接');
  return connection;
}
async function finishDraft(db: Database, job: WorkerJob, leaseToken: string, mediaId: string) {
  await db.transaction(async (sql) => {
    await owned(sql, 'publish_tasks', job.workspaceId, job.publishTaskId!, true);
    const duplicate = await sql.rows(
      'SELECT id FROM publish_tasks WHERE "accountId"=$1 AND "channelAppId"=$2 AND "platformDraftId"=$3 AND id<>$4',
      [job.input.document.accountId, job.input.appId, mediaId, job.publishTaskId],
    );
    if (duplicate.length) throw conflict('这个平台草稿已由另一项计划记录，请在平台核对');
    const rows = await sql.rows(
      `UPDATE jobs SET status='succeeded',stage='done',output=$1,error='',"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL
       WHERE id=$2 AND status='running' AND "leaseToken"=$3 AND "leaseUntil">now() RETURNING id`,
      [`已保存公众号草稿：${mediaId}。这是草稿，尚未正式发布。`, job.id, leaseToken],
    );
    if (!rows.length) throw new AppError(409, 'LEASE_LOST', '旧执行进程的返回已忽略，请从发布计划核对草稿');
    await sql.rows(
      `UPDATE publish_tasks SET status='draft_saved',"platformDraftId"=$1,"updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
      [mediaId, job.publishTaskId, job.workspaceId],
    );
  });
}

/** Failure preserves upload checkpoints; possible draft writes must go through reconciliation. */
export async function failDraftJob(
  db: Database,
  job: WorkerJob,
  leaseToken: string,
  error: unknown,
  forceUncertain = false,
) {
  await db.transaction(async (sql) => {
    const task = await owned<PublishTask>(sql, 'publish_tasks', job.workspaceId, job.publishTaskId!, true);
    const current = await owned<WorkerJob & { leaseToken: string | null }>(
      sql,
      'jobs',
      job.workspaceId,
      job.id,
      true,
    );
    if (current.status !== 'running' || current.leaseToken !== leaseToken) return;
    const uncertain =
      forceUncertain ||
      (['creating_draft', 'verifying_draft'].includes(current.stage) &&
        !(error instanceof WechatError && error.definitive));
    const message = error instanceof AppError ? error.message : '任务执行中断，请检查结果';
    await sql.rows(
      `UPDATE jobs SET status=$1,error=$2,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$3 AND "leaseToken"=$4`,
      [
        uncertain ? 'needs_verification' : 'failed',
        uncertain ? `${message}；平台可能已接收草稿，请核对后再操作` : message,
        job.id,
        leaseToken,
      ],
    );
    await sql.rows('UPDATE publish_tasks SET status=$1,"updatedAt"=now() WHERE id=$2', [
      uncertain ? 'verification_required' : task.scheduledAt ? 'planned' : 'waiting_user',
      task.id,
    ]);
  });
}

export async function runDraftJob(
  db: Database,
  config: AppConfig,
  job: WorkerJob,
  leaseToken: string,
  signal: AbortSignal,
) {
  const connection = await jobConnection(db, job);
  const account = await owned<Account>(db, 'accounts', job.workspaceId, connection.accountId);
  if (!account.active || account.platform !== 'wechat')
    throw new AppError(400, 'ACCOUNT_DISABLED', '目标账号已停用或平台改变');
  const adapter = draftAdapter(account.platform)!;
  const context: DraftContext = {
    db,
    config,
    connection,
    signal,
    job,
    report: (stage, progress) => reportJob(db, job, leaseToken, stage, progress),
  };
  const payload = await adapter.prepare(context);
  // The fence, attempted submission time and exact payload are durable before the external write starts.
  const submittedAt = new Date().toISOString();
  await db.transaction(async (sql) => {
    const task = await owned<PublishTask>(sql, 'publish_tasks', job.workspaceId, job.publishTaskId!, true);
    if (task.status !== 'submitting') throw conflict('发布计划状态已变化');
    const currentAccount = await owned<Account>(sql, 'accounts', job.workspaceId, task.accountId);
    if (!currentAccount.active) throw new AppError(400, 'ACCOUNT_DISABLED', '目标账号已停用');
    await reportJob(sql, job, leaseToken, 'creating_draft', { ...job.progress, payload, submittedAt });
    await sql.rows('UPDATE publish_tasks SET "submittedAt"=$1,"updatedAt"=now() WHERE id=$2', [
      submittedAt,
      task.id,
    ]);
  });
  const mediaId = await adapter.submit(context, payload);
  await finishDraft(db, job, leaseToken, mediaId);
}

export async function verifyDraft(
  db: Database,
  config: AppConfig,
  workspaceId: string,
  taskId: string,
  jobId: string,
  mediaId?: string,
) {
  const leaseToken = id();
  const job = await db.transaction(async (sql) => {
    const task = await owned<PublishTask>(sql, 'publish_tasks', workspaceId, taskId, true);
    const current = await owned<WorkerJob>(sql, 'jobs', workspaceId, jobId, true);
    if (
      task.status !== 'verification_required' ||
      current.publishTaskId !== taskId ||
      current.status !== 'needs_verification'
    )
      throw conflict('任务状态已变化，请刷新后再核对');
    if (!current.progress.payload) throw conflict('缺少提交快照，请到平台人工核对');
    await sql.rows(
      `UPDATE jobs SET status='running',stage='verifying_draft',"leaseToken"=$1,"leaseUntil"=now()+interval '3 minutes' WHERE id=$2`,
      [leaseToken, jobId],
    );
    return current;
  });
  try {
    if (!(await acquireAccountLease(db, workspaceId, job.input.document.accountId!, job.id, leaseToken)))
      throw conflict('这个账号正在执行其他操作，请稍后再核对');
    return await withHeartbeat(db, jobId, leaseToken, async (signal) => {
      const connection = await jobConnection(db, job, true);
      const result = await draftAdapter('wechat')!.reconcile(
        {
          db,
          config,
          connection,
          signal,
          job,
          report: (stage, progress) => reportJob(db, job, leaseToken, stage, progress),
        },
        job.progress.payload as DraftPayload,
        mediaId,
      );
      if (result.mediaId) await finishDraft(db, job, leaseToken, result.mediaId);
      else
        await failDraftJob(db, job, leaseToken, new AppError(409, 'DRAFT_UNCERTAIN', result.message), true);
      return { found: !!result.mediaId, ...result };
    });
  } catch (error) {
    await failDraftJob(db, job, leaseToken, error, true);
    throw error;
  }
}
export async function confirmDraftAbsent(db: Database, workspaceId: string, taskId: string, jobId: string) {
  return db.transaction(async (sql) => {
    const task = await owned<PublishTask>(sql, 'publish_tasks', workspaceId, taskId, true);
    const job = await owned<WorkerJob>(sql, 'jobs', workspaceId, jobId, true);
    if (
      task.status !== 'verification_required' ||
      job.publishTaskId !== taskId ||
      job.status !== 'needs_verification'
    )
      throw conflict('任务状态已变化，请重新核对');
    await sql.rows(
      `UPDATE jobs SET status='failed',error='用户已在平台确认未创建草稿，允许手动重试',"finishedAt"=now() WHERE id=$1`,
      [jobId],
    );
    await sql.rows('UPDATE publish_tasks SET status=$1,"updatedAt"=now() WHERE id=$2', [
      task.scheduledAt ? 'planned' : 'waiting_user',
      taskId,
    ]);
    return { ok: true };
  });
}

export async function cancelWorkerJob(db: Database, workspaceId: string, jobId: string) {
  return db.transaction(async (sql) => {
    const original = await owned<WorkerJob>(sql, 'jobs', workspaceId, jobId);
    const task = original.publishTaskId
      ? await owned<PublishTask>(sql, 'publish_tasks', workspaceId, original.publishTaskId, true)
      : null;
    const job = await owned<WorkerJob>(sql, 'jobs', workspaceId, jobId, true);
    if (job.status === 'cancelled') return job;
    if (!['queued', 'running'].includes(job.status)) throw conflict('任务已结束或等待核对，不能取消');
    if (job.kind === 'wechat_draft' && ['creating_draft', 'verifying_draft'].includes(job.stage))
      throw conflict('平台可能正在接收草稿，不能在此阶段取消；请等待结果并核对');
    const [cancelled] = await sql.rows<WorkerJob>(
      `UPDATE jobs SET status='cancelled',error='用户取消了任务',"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 RETURNING *`,
      [job.id],
    );
    if (task)
      await sql.rows('UPDATE publish_tasks SET status=$1,"updatedAt"=now() WHERE id=$2', [
        task.scheduledAt ? 'planned' : 'waiting_user',
        task.id,
      ]);
    return cancelled;
  });
}
