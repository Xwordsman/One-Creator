import type { JobProgress, JobStage, WorkerJob } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import { AppError } from './errors.js';
import { renewAccountLease, releaseAccountLease } from './execution-leases.js';

export async function reportJob(
  sql: Sql,
  job: WorkerJob,
  leaseToken: string,
  stage: JobStage,
  progress = job.progress,
) {
  const rows = await sql.rows(
    `UPDATE jobs SET stage=$1,progress=$2 WHERE id=$3 AND "workspaceId"=$4 AND "leaseToken"=$5 AND status='running' AND "leaseUntil">now() RETURNING id`,
    [stage, JSON.stringify(progress), job.id, job.workspaceId, leaseToken],
  );
  if (!rows.length) throw new AppError(409, 'LEASE_LOST', '任务已经取消或执行权已过期');
  job.stage = stage;
  job.progress = structuredClone(progress) as JobProgress;
}

/** Lease recovery never replays a possible external write. */
export async function recoverExpiredTasks(db: Database) {
  await db.transaction(async (sql) => {
    await sql.exec(`
      UPDATE publish_tasks p SET status=CASE WHEN j.stage IN ('creating_draft','verifying_draft') THEN 'verification_required'
        WHEN p."scheduledAt" IS NOT NULL THEN 'planned' ELSE 'waiting_user' END,"updatedAt"=now()
      FROM jobs j WHERE j."publishTaskId"=p.id AND j.status='running' AND j."leaseUntil"<now()
        AND p.status IN ('submitting','verification_required');
      UPDATE jobs SET status=CASE WHEN kind='wechat_draft' AND stage IN ('creating_draft','verifying_draft') THEN 'needs_verification' ELSE 'failed' END,
        error=CASE WHEN kind='wechat_draft' AND stage IN ('creating_draft','verifying_draft') THEN '执行进程中断，平台可能已接收草稿，请先核对，不能直接重试'
        ELSE '执行进程已中断，请检查后手动重试' END,
        "finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE status='running' AND "leaseUntil"<now();
      UPDATE activities SET status='failed',error='页面或执行进程已离开，请回到原页面重新操作',"finishedAt"=now()
        WHERE status='running' AND "leaseUntil"<now();
    `);
  });
}

export async function withHeartbeat<T>(
  db: Database,
  jobId: string,
  leaseToken: string,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let heartbeat: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = db
      .transaction(async (sql) => {
        const rows = await sql.rows<{ kind: string }>(
          `UPDATE jobs SET "leaseUntil"=now()+interval '3 minutes' WHERE id=$1 AND "leaseToken"=$2 AND status='running' AND "leaseUntil">now() RETURNING kind`,
          [jobId, leaseToken],
        );
        if (rows[0]?.kind === 'wechat_draft' && !(await renewAccountLease(sql, jobId, leaseToken)))
          throw new AppError(409, 'LEASE_LOST', '账号执行权过期');
        return rows;
      })
      .then(
        (rows) => {
          if (!rows.length) controller.abort();
        },
        () => controller.abort(),
      )
      .finally(() => {
        heartbeat = null;
      });
  }, 3000);
  try {
    return await run(outer ? AbortSignal.any([outer, controller.signal]) : controller.signal);
  } finally {
    clearInterval(timer);
    await heartbeat;
    await releaseAccountLease(db, jobId, leaseToken);
  }
}
