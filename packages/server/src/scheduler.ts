import type { PublishTask, WorkerJob } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import { createAutomation } from './automation.js';
import { createDraftJob } from './draft-jobs.js';
import { owned } from './records.js';
import { AppError } from './errors.js';

type ScheduledTask = PublishTask & { dispatchedRevision: number };
const graceMs = 10 * 60000;

async function wait(sql: Sql, task: ScheduledTask, reason: string) {
  await sql.rows(
    `UPDATE publish_tasks SET status=CASE WHEN status='planned' THEN 'waiting_user' ELSE status END,"dispatchedRevision"="executionRevision",
     "platformResult"="platformResult"||jsonb_build_object('scheduleError',$1::text,'scheduleRevision',"executionRevision"),"updatedAt"=now() WHERE id=$2`,
    [reason, task.id],
  );
}
async function dispatched(sql: Sql, task: ScheduledTask) {
  await sql.rows(
    `UPDATE publish_tasks SET "dispatchedRevision"="executionRevision","updatedAt"=now() WHERE id=$1`,
    [task.id],
  );
}
/** One due plan always resolves to queued work, an explicit wait, or a no-op; it never blocks later plans. */
async function dispatchOne(sql: Sql, due: ScheduledTask) {
  await owned(sql, 'accounts', due.workspaceId, due.accountId, true);
  const task = await owned<ScheduledTask>(sql, 'publish_tasks', due.workspaceId, due.id, true);
  if (task.executionMode === 'manual' || task.dispatchedRevision >= task.executionRevision) return;
  if (!task.scheduledAt || Date.parse(task.scheduledAt) > Date.now()) return;
  const key = `schedule:${task.id}:${task.executionRevision}`;
  const [draft] = await sql.rows<WorkerJob>(
    'SELECT * FROM jobs WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
    [task.workspaceId, `${key}:draft`],
  );
  // The overdue rule applies when execution would start; a chained draft that already ran keeps its slot.
  if (!draft && task.overduePolicy === 'wait' && Date.parse(task.scheduledAt) < Date.now() - graceMs)
    return wait(sql, task, '排期已过期超过 10 分钟，未自动补发；请确认后手动执行或重新排期');
  try {
    if (task.executionMode === 'wechat_draft') {
      if (task.status !== 'planned') return dispatched(sql, task);
      await createDraftJob(sql, task.workspaceId, task.id, `${key}:draft`);
      return dispatched(sql, task);
    }
    if (task.executionMode === 'wechat_publish' && task.status === 'planned') {
      // Scheduled publication first saves the frozen snapshot as an official draft, then publishes that draft.
      const job = draft ?? (await createDraftJob(sql, task.workspaceId, task.id, `${key}:draft`));
      if (['failed', 'cancelled'].includes(job.status))
        return wait(sql, task, `草稿保存未完成：${job.error || '请查看任务记录'}`);
      return;
    }
    if (task.executionMode === 'wechat_publish' && task.status !== 'draft_saved')
      return wait(sql, task, '定时正式发布需要先保存官方草稿');
    let nodeId = task.nodeId;
    if (task.executionMode === 'browser_publish' && !nodeId) {
      const [connection] = await sql.rows<{ nodeId: string }>(
        'SELECT "nodeId" FROM browser_connections WHERE "workspaceId"=$1 AND "accountId"=$2',
        [task.workspaceId, task.accountId],
      );
      if (!connection) return wait(sql, task, '请先为账号配置浏览器执行节点并完成扫码登录');
      nodeId = connection.nodeId;
    }
    await createAutomation(
      sql,
      task.workspaceId,
      {
        kind: task.executionMode === 'wechat_publish' ? 'wechat_publish' : 'browser_publish',
        accountId: task.accountId,
        data: { publishTaskId: task.id, ...(nodeId ? { nodeId } : {}) },
      },
      key,
    );
    await dispatched(sql, task);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await wait(sql, task, error.message);
  }
}
export async function dispatchSchedules(db: Database) {
  const due = await db.rows<ScheduledTask>(
    `SELECT * FROM publish_tasks WHERE status IN ('planned','draft_saved') AND "executionMode"<>'manual' AND "scheduledAt"<=now()
     AND "executionRevision">"dispatchedRevision" ORDER BY "scheduledAt" LIMIT 20`,
  );
  for (const task of due) {
    try {
      await db.transaction((sql) => dispatchOne(sql, task));
    } catch (error) {
      // An unexpected failure on one plan is recorded and skipped so other accounts keep running.
      await db
        .transaction((sql) =>
          wait(sql, task, error instanceof Error ? error.message.slice(0, 300) : '调度失败'),
        )
        .catch(() => {});
    }
  }
  // Submitted publications are re-queried until the platform reports a final state.
  const pending = await db.rows<PublishTask>(
    `SELECT p.* FROM publish_tasks p WHERE p.status='submitted' AND (
       (p.channel='wechat_api' AND p."publishId" IS NOT NULL AND EXISTS(SELECT 1 FROM account_connections c WHERE c."accountId"=p."accountId" AND c.status='connected'))
       OR (p.channel='browser' AND p."nodeId" IS NOT NULL AND EXISTS(SELECT 1 FROM browser_connections b WHERE b."accountId"=p."accountId" AND b."nodeId"=p."nodeId" AND b.status='connected')))
     AND NOT EXISTS(SELECT 1 FROM automation_jobs j WHERE j."publishTaskId"=p.id AND (j.status IN ('queued','running') OR (j.kind IN ('wechat_verify','browser_verify') AND j."createdAt">now()-CASE WHEN p.channel='browser' THEN interval '10 minutes' ELSE interval '1 minute' END)))
     AND (SELECT count(*) FROM automation_jobs j WHERE j."publishTaskId"=p.id AND j.kind IN ('wechat_verify','browser_verify') AND j."createdAt">COALESCE(p."submittedAt",p."updatedAt"))<CASE WHEN p.channel='browser' THEN 6 ELSE 60 END
     ORDER BY p."submittedAt" LIMIT 10`,
  );
  for (const task of pending) {
    const kind = task.channel === 'browser' ? 'browser_verify' : 'wechat_verify';
    const data =
      kind === 'browser_verify'
        ? { publishTaskId: task.id, nodeId: task.nodeId }
        : { publishTaskId: task.id, queryOnly: true };
    await db
      .transaction((sql) =>
        createAutomation(
          sql,
          task.workspaceId,
          { kind, accountId: task.accountId, data },
          `query:${task.id}:${Math.floor(Date.now() / 60000)}`,
        ),
      )
      .catch(() => {});
  }
}
