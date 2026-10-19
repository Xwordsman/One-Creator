import {
  jobSchema,
  type AIJob,
  type ContentDocument,
  type JobInput,
  type WorkerJob,
} from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import { decryptSecret, tokenHash } from './crypto.js';
import { AppError, conflict } from './errors.js';
import { id, owned } from './records.js';
import { getDocument, saveDocument } from './content.js';
import { buildMessages, callModel } from './ai.js';
import { runDraftJob, failDraftJob } from './draft-jobs.js';
import { recoverExpiredTasks, reportJob, withHeartbeat } from './task-state.js';
import { reviewSources } from './source-review.js';
import { identity } from './permissions.js';
import { measuredModel } from './usage.js';
import { deliverWebhooks } from './webhooks.js';
import { startAutomationWorker } from './automation.js';
import { canonical, item, renderPrompt } from './studio.js';
import { acquireAccountLease } from './execution-leases.js';
import { dispatchSchedules } from './scheduler.js';
export const jobSummarySql = (alias = 'j') =>
  `(to_jsonb(${alias})-'input'-'leaseToken'-'leaseUntil'-'idempotencyKey'-'requestHash') || jsonb_build_object('input',jsonb_build_object('document',jsonb_build_object('id',${alias}."documentId",'title',${alias}.input->'document'->>'title','revision',${alias}.input->'document'->'revision'),'template',${alias}.input->'template','creativity',${alias}.input->'creativity'))`;

export interface ProviderRecord {
  workspaceId: string;
  name: string;
  baseUrl: string;
  model: string;
  keyCipher: string;
  updatedAt: string;
}
export async function getProvider(sql: Sql, workspaceId: string) {
  const [provider] = await sql.rows<ProviderRecord>('SELECT * FROM providers WHERE "workspaceId"=$1', [
    workspaceId,
  ]);
  if (!provider) throw new AppError(400, 'MODEL_NOT_CONFIGURED', '请先在设置中配置文本模型，再使用 AI 创作');
  return provider;
}
function sameRequest(job: AIJob & { requestHash?: string | null }, input: JobInput) {
  if (job.requestHash) return job.requestHash === tokenHash(canonical(input));
  if (input.templateId || Object.keys(input.variables).length || input.creativity !== undefined) return false;
  return (
    job.documentId === input.documentId &&
    job.kind === input.kind &&
    job.input.document.revision === input.expectedRevision &&
    job.input.instruction === input.instruction &&
    JSON.stringify(job.input.selection) === JSON.stringify(input.selection)
  );
}
export async function createJob(
  sql: Sql,
  workspaceId: string,
  payload: JobInput,
  idempotencyKey: string,
  parent?: AIJob,
): Promise<AIJob> {
  const input = jobSchema.parse(payload);
  const [existing] = await sql.rows<AIJob>(
    'SELECT * FROM jobs WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
    [workspaceId, idempotencyKey],
  );
  if (existing) {
    if (!sameRequest(existing, input)) throw conflict('同一个请求编号不能用于不同的生成任务');
    return existing;
  }
  const document = await getDocument(sql, workspaceId, input.documentId);
  if (document.revision !== input.expectedRevision) throw conflict();
  if (
    input.selection &&
    (input.selection.end <= input.selection.start ||
      document.body.slice(input.selection.start, input.selection.end) !== input.selection.text)
  )
    throw conflict('选中文字已经变化，请重新选择');
  const provider = await getProvider(sql, workspaceId);
  const templateId = input.templateId ?? parent?.input.template?.id;
  const template = templateId ? await item(sql, workspaceId, templateId, 'prompt') : null;
  if (template?.accountId && template.accountId !== document.accountId)
    throw new AppError(400, 'TEMPLATE_SCOPE', '这个预设属于另一个账号，请先复制成共享或目标账号预设');
  const rendered = input.templateId && template ? renderPrompt(template, input.variables) : null;
  if (rendered && String(rendered.template.data.scenario) !== input.kind)
    throw new AppError(400, 'TEMPLATE_SCENARIO', '写作预设与当前步骤场景不匹配');
  const instruction = [rendered?.instruction, input.instruction].filter(Boolean).join('\n');
  if (instruction.length > 30000)
    throw new AppError(400, 'TEMPLATE_TOO_LARGE', '填入变量后的预设超过 30,000 字符');
  const snapshot = {
    document,
    instruction,
    selection: input.selection,
    model: provider.model,
    baseUrl: provider.baseUrl,
    template: rendered ? { ...rendered.template, params: rendered.params } : parent?.input.template,
    creativity: input.creativity ?? rendered?.creativity,
  };
  const [created] = await sql.rows<AIJob>(
    `INSERT INTO jobs(id,"workspaceId","documentId",kind,input,model,"idempotencyKey","parentId",attempt,"createdBy","requestHash")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT("workspaceId","idempotencyKey") DO NOTHING RETURNING *`,
    [
      id(),
      workspaceId,
      document.id,
      input.kind,
      JSON.stringify(snapshot),
      provider.model,
      idempotencyKey,
      parent?.id ?? null,
      parent ? parent.attempt + 1 : 1,
      identity()?.id ?? null,
      tokenHash(canonical(input)),
    ],
  );
  if (created) return created;
  const [duplicate] = await sql.rows<AIJob>(
    'SELECT * FROM jobs WHERE "workspaceId"=$1 AND "idempotencyKey"=$2',
    [workspaceId, idempotencyKey],
  );
  if (!sameRequest(duplicate, input)) throw conflict('请求编号已被其他任务使用');
  return duplicate;
}
export async function applyJob(sql: Sql, workspaceId: string, jobId: string, expectedRevision: number) {
  const job = await owned<WorkerJob>(sql, 'jobs', workspaceId, jobId, true);
  if (job.kind === 'wechat_draft')
    throw new AppError(400, 'CHANNEL_RESULT', '平台回执不能覆盖文稿，请在发布日历中查看');
  if (job.status !== 'succeeded' || !job.output)
    throw new AppError(400, 'JOB_NOT_READY', '这项生成还没有可采用的结果');
  if (job.appliedRevision !== null) throw conflict('该结果已经采用，请在历史版本中查看');
  if (job.kind === 'titles' || job.kind === 'opening')
    throw new AppError(400, 'CHOICE_REQUIRED', '这是候选结果，请复制合适的一项到稿件中再编辑');
  if (job.input.document.revision !== expectedRevision)
    throw conflict('生成后文稿有新修改。AI 结果已保留，可复制需要的部分，不会覆盖当前稿件');
  const document = await owned<ContentDocument>(sql, 'documents', workspaceId, job.documentId);
  if (document.revision !== expectedRevision) throw conflict();
  const data = { ...document };
  if (job.kind === 'outline') data.outline = job.output;
  else if (job.input.selection)
    data.body =
      document.body.slice(0, job.input.selection.start) +
      job.output +
      document.body.slice(job.input.selection.end);
  else data.body = job.output;
  const saved = await saveDocument(sql, workspaceId, document.id, expectedRevision, data, '采用 AI 生成结果');
  await sql.rows('UPDATE jobs SET "appliedRevision"=$1 WHERE id=$2 AND "workspaceId"=$3', [
    saved.revision,
    jobId,
    workspaceId,
  ]);
  return saved;
}

export function startWorker(db: Database, config: AppConfig, interval = 1500) {
  const automationWorker = startAutomationWorker(db, config, interval);
  const publicationWorker = startAutomationWorker(db, config, interval, 'publication');
  let scheduling: Promise<unknown> | null = null;
  const scheduleTimer = setInterval(
    () => {
      if (scheduling) return;
      scheduling = dispatchSchedules(db)
        .catch(() => {})
        .finally(() => {
          scheduling = null;
        });
    },
    Math.max(1000, interval),
  );
  let stopped = false;
  let busy = false;
  const controllers = new Map<string, AbortController>();
  let current: Promise<void> | undefined;
  const integrationController = new AbortController();
  let delivering: Promise<void> | null = null;
  const integrationTimer = setInterval(
    () => {
      if (stopped || delivering) return;
      delivering = deliverWebhooks(db, config, integrationController.signal)
        .catch(() => {})
        .finally(() => {
          delivering = null;
        });
    },
    Math.max(interval, 3000),
  );
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      await recoverExpiredTasks(db);
      const claimed = await db.transaction(async (sql) => {
        const [job] = await sql.rows<WorkerJob>(
          `SELECT j.* FROM jobs j WHERE j.status='queued' AND (j.kind<>'wechat_draft' OR NOT EXISTS(SELECT 1 FROM account_execution_leases l WHERE l."accountId"::text=j.input->'document'->>'accountId' AND l."expiresAt">now())) ORDER BY j."createdAt" LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        );
        if (!job) return null;
        const leaseToken = id();
        await sql.rows(
          `UPDATE jobs SET status='running',stage='preparing',"startedAt"=now(),"leaseToken"=$1,"leaseUntil"=now()+interval '3 minutes' WHERE id=$2`,
          [leaseToken, job.id],
        );
        return { job, leaseToken };
      });
      if (!claimed) return;
      const { job, leaseToken } = claimed;
      if (
        job.kind === 'wechat_draft' &&
        job.input.document.accountId &&
        !(await acquireAccountLease(db, job.workspaceId, job.input.document.accountId, job.id, leaseToken))
      ) {
        await db.rows(
          `UPDATE jobs SET status='queued',stage='queued',"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseToken"=$2`,
          [job.id, leaseToken],
        );
        return;
      }
      const controller = new AbortController();
      controllers.set(job.id, controller);
      try {
        await withHeartbeat(
          db,
          job.id,
          leaseToken,
          async (signal) => {
            if (job.kind === 'wechat_draft') {
              await runDraftJob(db, config, job, leaseToken, signal);
              return;
            }
            const provider = await getProvider(db, job.workspaceId);
            if (provider.baseUrl !== job.input.baseUrl || provider.model !== job.model)
              throw new AppError(409, 'PROVIDER_CHANGED', '模型配置已改变，请重新创建任务');
            await reportJob(db, job, leaseToken, 'generating');
            const result = await measuredModel(
              db,
              {
                ...provider,
                apiKey: decryptSecret(provider.keyCipher, config.encryptionKey, job.workspaceId),
                creativity: job.input.creativity,
              },
              buildMessages({ kind: job.kind, input: job.input }),
              {
                workspaceId: job.workspaceId,
                accountId: job.input.document.accountId,
                jobId: job.id,
                callKey: `${job.id}:text`,
                title: job.input.document.title,
              },
              signal,
            );
            await reportJob(db, job, leaseToken, 'reviewing');
            const reviewed = reviewSources(result.output, job.input.document);
            await db.rows(
              `UPDATE jobs SET status='succeeded',stage='done',output=$1,usage=$2,warnings=$3,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$4 AND "leaseToken"=$5 AND status='running' AND "leaseUntil">now()`,
              [
                reviewed.output,
                result.usage ? JSON.stringify(result.usage) : null,
                JSON.stringify(reviewed.warnings),
                job.id,
                leaseToken,
              ],
            );
          },
          controller.signal,
        );
      } catch (error) {
        if (job.kind === 'wechat_draft') {
          await failDraftJob(db, job, leaseToken, error);
          return;
        }
        const message = error instanceof AppError ? error.message : '任务执行失败，请检查模型配置后重试';
        await db.rows(
          `UPDATE jobs SET status='failed',error=$1,"finishedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$2 AND "leaseToken"=$3 AND status='running' AND "leaseUntil">now()`,
          [message, job.id, leaseToken],
        );
      } finally {
        controllers.delete(job.id);
      }
    } finally {
      busy = false;
    }
  }
  const run = () => {
    if (!stopped && !busy)
      current = tick().catch(() => {
        /* Database outages are retried on the next tick; leases remain authoritative. */
      });
  };
  const timer = setInterval(run, interval);
  run();
  return {
    tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await automationWorker.stop();
      await publicationWorker.stop();
      clearInterval(scheduleTimer);
      await scheduling;
      clearInterval(integrationTimer);
      integrationController.abort();
      await delivering;
      for (const controller of controllers.values()) controller.abort();
      await current;
    },
  };
}
