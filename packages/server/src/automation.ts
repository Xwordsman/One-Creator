import { z } from 'zod';
import {
  automationKindSchema,
  automationSchemas,
  automationNames,
  type Account,
  type AutomationJob,
  type ContentDocument,
  type SessionUser,
  type StudioItem,
} from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import { id, insert, owned } from './records.js';
import { AppError, conflict } from './errors.js';
import { tokenHash } from './crypto.js';
import { canonical, item } from './studio.js';
import { writingContext } from './content.js';
import { identity, accountScope, accessContext } from './permissions.js';
import { automationHandlers } from './automation-handlers.js';
import type { AutomationInput } from './automation-types.js';
import { acquireAccountLease, renewAccountLease, releaseAccountLease } from './execution-leases.js';
import { WechatError } from './platforms/wechat.js';
import { authorizeBrowserJob } from './nodes.js';
import { guardPublication } from './publication-guard.js';

const inputSchema = z.object({
  kind: automationKindSchema,
  accountId: z.uuid().nullable().default(null),
  documentId: z.uuid().nullable().default(null),
  data: z.record(z.string(), z.unknown()).default({}),
  parentId: z.uuid().optional(),
});
const requiredDocument = new Set(['workflow', 'images', 'language_review', 'fact_review']);
const textRequired = new Set([
  'style',
  'topics',
  'observer_analysis',
  'workflow',
  'compare',
  'retrospective',
  'comment_reply',
  'video_script',
]);
export async function createAutomation(sql: Sql, ws: string, payload: unknown, key: string) {
  const parsed = inputSchema.parse(payload);
  const data = automationSchemas[parsed.kind].parse(parsed.data) as Record<string, unknown>;
  const hash = tokenHash(canonical({ ...parsed, data }));
  const [existing] = await sql.rows<AutomationJob & { requestHash: string }>(
    'SELECT * FROM automation_jobs WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
    [ws, key],
  );
  if (existing) {
    await owned(sql, 'automation_jobs', ws, existing.id);
    if (existing.requestHash !== hash) throw conflict('请求编号已用于不同的任务');
    return existing;
  }
  if (!automationHandlers[parsed.kind] && !parsed.kind.startsWith('browser_'))
    throw new AppError(400, 'CAPABILITY_UNAVAILABLE', '此类任务的执行器尚未配置');
  const document = parsed.documentId
    ? await owned<ContentDocument>(sql, 'documents', ws, parsed.documentId)
    : null;
  if (requiredDocument.has(parsed.kind) && !document)
    throw new AppError(400, 'DOCUMENT_REQUIRED', '请先选择一份文稿');
  let accountId = parsed.accountId ?? document?.accountId ?? null;
  const references: Record<string, Record<string, unknown>> = {};
  const ref = async (resourceId: string, table: string) => {
    references[resourceId] = await owned(sql, table, ws, resourceId);
  };
  const fields: Record<string, string> = {
    personaId: 'personas',
    observerId: 'creator_items',
    dictionaryId: 'creator_items',
    workflowId: 'creator_items',
    scriptId: 'creator_items',
    transcriptId: 'creator_items',
    feedId: 'feeds',
    assetId: 'assets',
    audioAssetId: 'assets',
    publishTaskId: 'publish_tasks',
  };
  for (const [field, table] of Object.entries(fields)) if (data[field]) await ref(String(data[field]), table);
  for (const [field, table] of Object.entries({
    materialIds: 'materials',
    feedEntryIds: 'feed_entries',
    documentIds: 'documents',
    commentIds: 'creator_items',
    metricIds: 'metric_snapshots',
    publishTaskIds: 'publish_tasks',
  }))
    for (const resourceId of (data[field] ?? []) as string[]) await ref(resourceId, table);
  for (const page of (data.pages ?? []) as { referenceAssetId?: string }[])
    if (page.referenceAssetId) await ref(page.referenceAssetId, 'assets');
  if (data.publishTaskId) accountId = references[String(data.publishTaskId)].accountId as string;
  if (data.observerId) {
    const observer = await item(sql, ws, String(data.observerId), 'observer');
    for (const resourceId of (observer.data.materialIds ?? []) as string[])
      await ref(resourceId, 'materials');
    if (observer.data.feedId) {
      await ref(String(observer.data.feedId), 'feeds');
      const params: unknown[] = [ws, observer.data.feedId];
      const scope = accountScope(params);
      const entries = await sql.rows<Record<string, unknown>>(
        `SELECT * FROM feed_entries WHERE "workspaceId"=$1 AND "feedId"=$2 AND ${scope} ORDER BY "fetchedAt" DESC LIMIT 100`,
        params,
      );
      for (const entry of entries) references[String(entry.id)] = entry;
    }
  }
  if (data.workflowId) {
    const workflow = await item(sql, ws, String(data.workflowId), 'workflow');
    for (const step of workflow.data.steps as { promptId?: string }[])
      if (step.promptId) await ref(step.promptId, 'creator_items');
  }
  if (data.scriptId) {
    const script = await item(sql, ws, String(data.scriptId), 'video_script');
    for (const scene of script.data.scenes as { imageAssetId?: string }[])
      if (scene.imageAssetId) await ref(scene.imageAssetId, 'assets');
  }
  if (parsed.kind === 'embedding_rebuild' && !(data.materialIds as string[]).length) {
    const parameters: unknown[] = [ws];
    let where = '"workspaceId"=$1 AND archived=false';
    if (accountId) {
      parameters.push(accountId);
      where += ` AND ("accountId" IS NULL OR "accountId"=$${parameters.length})`;
    }
    where += ` AND ${accountScope(parameters)}`;
    const materials = await sql.rows<Record<string, unknown>>(
      `SELECT * FROM materials WHERE ${where} ORDER BY id LIMIT 2000`,
      parameters,
    );
    data.materialIds = materials.map((material) => String(material.id));
    for (const material of materials) references[String(material.id)] = material;
  }
  if (parsed.kind === 'import' && !(data.urls as string[]).length && !(data.articles as unknown[]).length)
    throw new AppError(400, 'IMPORT_EMPTY', '请填写网页地址或导入文章文件');
  if (parsed.kind === 'clip_video') {
    if (!String(references[String(data.assetId)]?.mime ?? '').startsWith('video/'))
      throw new AppError(400, 'VIDEO_REQUIRED', '请选择视频文件');
    if ((data.segments as { start: number; end: number }[]).some((segment) => segment.end <= segment.start))
      throw new AppError(400, 'SEGMENT_RANGE', '每个片段的结束时间需要晚于开始时间');
    if (
      data.transcriptId &&
      (references[String(data.transcriptId)]?.data as { assetId?: string } | undefined)?.assetId !==
        data.assetId
    )
      throw new AppError(400, 'TRANSCRIPT_SOURCE', '所选转写不属于这个原视频');
  }
  if (parsed.kind === 'embedding_rebuild')
    for (const resourceId of data.materialIds as string[]) {
      const record = references[resourceId];
      references[resourceId] = {
        id: record.id,
        accountId: record.accountId,
        title: record.title,
        revision: record.revision,
      };
    }
  if (!accountId) {
    const accounts = [
      ...new Set(
        Object.values(references)
          .map((record) => record.accountId)
          .filter(Boolean),
      ),
    ];
    if (accounts.length === 1) accountId = accounts[0] as string;
  }
  const account = accountId ? await owned<Account>(sql, 'accounts', ws, accountId) : null;
  if (parsed.kind.startsWith('browser_')) await authorizeBrowserJob(sql, ws, account, parsed.kind, data);
  if (data.publishTaskId)
    await guardPublication(sql, ws, parsed.kind, String(data.publishTaskId), account, data);
  const materialIds = (data.materialIds ?? []) as string[];
  const context =
    document?.context ??
    (await writingContext(
      sql,
      ws,
      accountId,
      ['style', 'topics'].includes(parsed.kind) ? materialIds.slice(0, 30) : [],
    ));
  const [provider] = await sql.rows<{ baseUrl: string; model: string }>(
    'SELECT "baseUrl",model FROM providers WHERE "workspaceId"=$1',
    [ws],
  );
  if (textRequired.has(parsed.kind) && !provider)
    throw new AppError(400, 'MODEL_NOT_CONFIGURED', '请先配置文本模型');
  const parent = parsed.parentId
    ? await owned<AutomationJob>(sql, 'automation_jobs', ws, parsed.parentId)
    : null;
  // Regenerating chosen images continues a finished image job; every other continuation needs a failed or cancelled parent.
  const regenerate = parsed.kind === 'images' ? (data.regenerate as number[]) : [];
  if (regenerate.length && !parent)
    throw new AppError(400, 'PARENT_REQUIRED', '重新生成单张图片需要指定原配图任务');
  if (
    parent &&
    (parent.kind !== parsed.kind ||
      parent.accountId !== accountId ||
      parent.documentId !== (document?.id ?? null) ||
      !(
        ['failed', 'cancelled'].includes(parent.status) ||
        (regenerate.length && parent.status === 'succeeded')
      ))
  )
    throw conflict('只能续接同类失败或取消任务');
  const parentInput = parent?.input as unknown as AutomationInput | undefined;
  const sameWorkflow =
    parent && parsed.kind === 'workflow' && parentInput?.data.workflowId === data.workflowId;
  const withoutRegenerate = (value: Record<string, unknown>) => {
    const { regenerate: _ignored, ...rest } = value;
    return rest;
  };
  const reuse =
    parent &&
    (sameWorkflow || canonical(withoutRegenerate(parentInput!.data)) === canonical(withoutRegenerate(data)));
  if (regenerate.length && !reuse) throw conflict('重新生成单张图片时不能修改其他页面');
  if (regenerate.some((index) => index >= ((data.pages ?? []) as unknown[]).length))
    throw new AppError(400, 'IMAGE_INDEX', '要重新生成的图片不存在');
  const jobId = id();
  const input: AutomationInput = reuse
    ? {
        ...structuredClone(parentInput!),
        operationId: parentInput!.operationId ?? parent!.id,
        data: sameWorkflow
          ? { ...parentInput!.data, startStep: data.startStep }
          : { ...parentInput!.data, ...(parsed.kind === 'images' ? { regenerate } : {}) },
      }
    : { operationId: jobId, data, document, account, context, references, textProvider: provider ?? null };
  const inheritedProgress = reuse
    ? {
        ...parent!.progress,
        ...(regenerate.length
          ? {
              images: ((parent!.progress.images ?? []) as { index: number }[]).filter(
                (image) => !regenerate.includes(image.index),
              ),
            }
          : {}),
      }
    : {};
  const job = await insert<AutomationJob>(sql, 'automation_jobs', {
    id: jobId,
    workspaceId: ws,
    accountId,
    documentId: document?.id ?? null,
    createdBy: identity()?.id ?? null,
    kind: parsed.kind,
    title: `${automationNames[parsed.kind]}${document ? ` · ${document.title}` : account ? ` · ${account.name}` : ''}`,
    input,
    idempotencyKey: key,
    requestHash: hash,
    parentId: parent?.id ?? null,
    attempt: parent ? parent.attempt + 1 : 1,
    progress: inheritedProgress,
    publishTaskId: data.publishTaskId ?? null,
    nodeId: data.nodeId ?? null,
  });
  return job;
}
export function startAutomationWorker(
  db: Database,
  config: AppConfig,
  interval = 1500,
  mode: 'general' | 'publication' = 'general',
) {
  let stopped = false,
    busy = false,
    current: Promise<void> | undefined;
  const controller = new AbortController();
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      await db.transaction(async (sql) => {
        const [feed] = await sql.rows<{
          id: string;
          accountId: string | null;
          workspaceId: string;
          revision: number;
          nextAt: string;
        }>(
          `SELECT * FROM feeds WHERE enabled=true AND "nextAt"<=now() ORDER BY "nextAt" LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (!feed) return;
        await sql.rows(
          'UPDATE feeds SET "nextAt"=now()+("intervalMinutes"::text||\' minutes\')::interval WHERE id=$1',
          [feed.id],
        );
        await createAutomation(
          sql,
          feed.workspaceId,
          { kind: 'feed_refresh', accountId: feed.accountId, data: { feedId: feed.id } },
          `feed:${feed.id}:${feed.revision}:${feed.nextAt}`,
        );
      });
      await db.transaction(async (sql) => {
        await sql.exec(`UPDATE publish_tasks p SET status=CASE WHEN j.stage NOT IN ('publishing','verifying') THEN CASE WHEN j.kind='wechat_publish' THEN 'draft_saved' ELSE 'waiting_user' END WHEN p."publishId" IS NOT NULL THEN 'submitted' ELSE 'verification_required' END,"updatedAt"=now() FROM automation_jobs j WHERE j."publishTaskId"=p.id AND j.status='running' AND j."leaseUntil"<now() AND j.kind IN ('wechat_publish','browser_publish');
      UPDATE browser_connections b SET status='expired',error='登录执行器已离线或中断',"updatedAt"=now() FROM automation_jobs j WHERE j."accountId"=b."accountId" AND j.kind='browser_login' AND j.status='running' AND j."leaseUntil"<now();
      UPDATE automation_jobs SET status=CASE WHEN kind IN ('wechat_publish','browser_publish') AND stage IN ('publishing','verifying') AND NOT EXISTS(SELECT 1 FROM publish_tasks p WHERE p.id=automation_jobs."publishTaskId" AND p."publishId" IS NOT NULL) THEN 'needs_verification' ELSE 'failed' END,error='执行进程中断，平台写入必须先核对，其余操作可从检查点继续',"leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=now() WHERE status='running' AND "leaseUntil"<now();`);
      });
      const claimed = await db.transaction(async (sql) => {
        const [job] = await sql.rows<AutomationJob>(
          `SELECT j.* FROM automation_jobs j WHERE j.status='queued' AND j.kind NOT IN ('browser_login','browser_publish','browser_verify') AND j.kind ${mode === 'publication' ? 'IN' : 'NOT IN'} ('wechat_publish','wechat_verify') AND (j.kind NOT IN ('wechat_publish','wechat_verify') OR NOT EXISTS(SELECT 1 FROM account_execution_leases l WHERE l."accountId"=j."accountId" AND l."expiresAt">now())) ORDER BY j."createdAt" LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        );
        if (!job) return null;
        const leaseToken = id();
        await sql.rows(
          `UPDATE automation_jobs SET status='running',stage='preparing',"startedAt"=now(),"leaseToken"=$1,"leaseUntil"=now()+interval '3 minutes' WHERE id=$2`,
          [leaseToken, job.id],
        );
        return { job, leaseToken };
      });
      if (!claimed) return;
      const { job, leaseToken } = claimed;
      if (
        ['wechat_publish', 'wechat_verify'].includes(job.kind) &&
        job.accountId &&
        !(await acquireAccountLease(db, job.workspaceId, job.accountId, job.id, leaseToken))
      ) {
        await db.rows(
          `UPDATE automation_jobs SET status='queued',stage='queued',"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseToken"=$2`,
          [job.id, leaseToken],
        );
        return;
      }
      const cancellation = new AbortController();
      let heartbeat: Promise<unknown> | null = null;
      const timer = setInterval(() => {
        if (heartbeat) return;
        heartbeat = db
          .transaction(async (sql) => {
            const rows = await sql.rows(
              `UPDATE automation_jobs SET "leaseUntil"=now()+interval '3 minutes' WHERE id=$1 AND "leaseToken"=$2 AND status='running' AND "leaseUntil">now() RETURNING id`,
              [job.id, leaseToken],
            );
            if (
              ['wechat_publish', 'wechat_verify'].includes(job.kind) &&
              !(await renewAccountLease(sql, job.id, leaseToken))
            )
              throw new AppError(409, 'LEASE_LOST', '账号执行权已过期');
            return rows;
          })
          .then((rows) => {
            if (!rows.length) cancellation.abort();
          })
          .catch(() => cancellation.abort())
          .finally(() => {
            heartbeat = null;
          });
      }, 3000);
      const signal = AbortSignal.any([controller.signal, cancellation.signal]);
      const report = async (stage: string, progress: Record<string, unknown>) => {
        signal.throwIfAborted();
        const rows = await db.rows(
          `UPDATE automation_jobs SET stage=$1,progress=$2 WHERE id=$3 AND "leaseToken"=$4 AND status='running' AND "leaseUntil">now() RETURNING id`,
          [stage, JSON.stringify(progress), job.id, leaseToken],
        );
        if (!rows.length) throw new AppError(409, 'LEASE_LOST', '任务已取消或执行权过期');
        job.progress = structuredClone(progress);
        job.stage = stage;
      };
      try {
        let actor: SessionUser | null = null;
        if (job.createdBy) {
          const [user] = await db.rows<SessionUser & { active: boolean }>(
            `SELECT u.*,w.name AS "workspaceName" FROM users u JOIN workspaces w ON w.id=u."workspaceId" WHERE u.id=$1 AND u."workspaceId"=$2`,
            [job.createdBy, job.workspaceId],
          );
          if (!user?.active || user.role === 'viewer')
            throw new AppError(403, 'ACTOR_REVOKED', '任务发起成员的权限已撤销');
          actor = user;
        }
        const result = await accessContext.run({ user: actor }, async () => {
          await owned(db, 'automation_jobs', job.workspaceId, job.id);
          return automationHandlers[job.kind]!({
            db,
            config,
            job,
            leaseToken,
            input: job.input as unknown as AutomationInput,
            signal,
            report,
          });
        });
        await db.rows(
          `UPDATE automation_jobs SET result=$1,status='succeeded',stage='done',"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$2 AND "leaseToken"=$3 AND status='running' AND "leaseUntil">now()`,
          [JSON.stringify(result), job.id, leaseToken],
        );
      } catch (error) {
        if (job.kind === 'wechat_publish')
          await db.transaction(async (sql) => {
            const taskId = (job.input as unknown as AutomationInput).data.publishTaskId;
            const [task] = await sql.rows<{ publishId: string | null; status: string }>(
              'SELECT "publishId",status FROM publish_tasks WHERE id=$1 FOR UPDATE',
              [taskId],
            );
            const uncertain =
              !task?.publishId &&
              ['publishing', 'verifying'].includes(job.stage) &&
              !(error instanceof WechatError && error.definitive);
            const rows = await sql.rows(
              `UPDATE automation_jobs SET status=$1,error=$2,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$3 AND "leaseToken"=$4 AND status='running' RETURNING id`,
              [
                uncertain ? 'needs_verification' : 'failed',
                error instanceof AppError ? error.message : '发布结果中断，请核对',
                job.id,
                leaseToken,
              ],
            );
            if (rows.length && task?.status === 'submitting')
              await sql.rows('UPDATE publish_tasks SET status=$1,"updatedAt"=now() WHERE id=$2', [
                uncertain ? 'verification_required' : task.publishId ? 'submitted' : 'draft_saved',
                taskId,
              ]);
          });
        else
          await db.rows(
            `UPDATE automation_jobs SET status='failed',error=$1,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$2 AND "leaseToken"=$3 AND status='running' AND "leaseUntil">now()`,
            [
              error instanceof AppError ? error.message : '任务失败或中断，已完成步骤会保留',
              job.id,
              leaseToken,
            ],
          );
      } finally {
        clearInterval(timer);
        await heartbeat;
        await releaseAccountLease(db, job.id, leaseToken);
      }
    } finally {
      busy = false;
    }
  }
  const run = () => {
    if (!stopped && !busy) current = tick().catch(() => {});
  };
  const timer = setInterval(run, interval);
  run();
  return {
    tick,
    stop: async () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      await current;
    },
  };
}
