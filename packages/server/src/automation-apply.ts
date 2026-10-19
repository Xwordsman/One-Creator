import {
  personaSchema,
  preferencesSchema,
  studioSchemas,
  type AutomationJob,
  type ContentDocument,
  type Persona,
  type StudioItem,
  type Account,
} from '@one-creator/core';
import type { Sql } from './database.js';
import { id, insert, owned, update } from './records.js';
import { createItem, saveItem, canonical } from './studio.js';
import { saveDocument } from './content.js';
import { importArticle } from './discovery.js';
import { identity } from './permissions.js';
import { AppError, conflict } from './errors.js';
import type { AutomationInput } from './automation-types.js';
import type { ReviewSuggestion } from './automation-ai.js';

export async function applyAutomation(
  sql: Sql,
  ws: string,
  jobId: string,
  input: { action: string; index?: number; expectedRevision?: number; data?: Record<string, unknown> },
) {
  const job = await owned<AutomationJob>(sql, 'automation_jobs', ws, jobId, true);
  if (!['succeeded', 'failed'].includes(job.status)) throw conflict('任务尚未结束');
  if (job.status === 'failed' && !['images', 'reply'].includes(input.action))
    throw conflict('此任务尚未生成可采用的完整结果');
  const source = job.input as unknown as AutomationInput,
    index = input.index ?? 0,
    itemKey = `${input.action}:${index}`;
  const [previous] = await sql.rows<{ data: Record<string, unknown> }>(
    'SELECT data FROM creator_decisions WHERE "jobId"=$1 AND "itemKey"=$2',
    [job.id, itemKey],
  );
  if (previous) {
    if (previous.data.request !== canonical(input))
      throw conflict('这个结果已处理，不能用同一次选择覆盖另一项修改');
    return previous.data.result;
  }
  let result: unknown;
  const document = async (replace: Partial<ContentDocument>, allowNewRevision = false) => {
    if (!job.documentId) throw new AppError(400, 'DOCUMENT_REQUIRED', '此任务没有目标文稿');
    const current = await owned<ContentDocument>(sql, 'documents', ws, job.documentId, true);
    const history = await sql.rows<{ data: { savedRevision?: number } }>(
      'SELECT data FROM creator_decisions WHERE "jobId"=$1',
      [job.id],
    );
    const baseline = Math.max(
      source.document?.revision ?? 0,
      ...history.map((record) => record.data.savedRevision ?? 0),
    );
    if (current.revision !== input.expectedRevision || (!allowNewRevision && current.revision !== baseline))
      throw conflict('文稿在生成后已改变，请重新运行或复制所需部分');
    return saveDocument(
      sql,
      ws,
      current.id,
      current.revision,
      { ...current, ...replace },
      `采用 ${job.kind} 结果`,
    );
  };
  if (input.action === 'style' && job.kind === 'style') {
    const preferences = preferencesSchema.parse(input.data ?? job.result);
    const personaId = source.data.personaId as string | null;
    if (personaId) {
      const current = await owned<Persona>(sql, 'personas', ws, personaId, true);
      if (current.revision !== job.result.personaRevision) throw conflict('人设已修改，请先比较再采用');
      const data = personaSchema.parse({
        ...current,
        ...preferences,
        sample: preferences.sample || current.sample,
      });
      const saved = await update<Persona>(sql, 'personas', ws, current.id, {
        ...data,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await insert(sql, 'persona_revisions', {
        id: id(),
        workspaceId: ws,
        personaId: saved.id,
        revision: saved.revision,
        data: saved,
      });
      result = saved;
    } else {
      const saved = await insert<Persona>(sql, 'personas', {
        id: id(),
        workspaceId: ws,
        ...personaSchema.parse({ name: String(source.data.newName || '从样文提炼的人设'), ...preferences }),
      });
      await insert(sql, 'persona_revisions', {
        id: id(),
        workspaceId: ws,
        personaId: saved.id,
        revision: 1,
        data: saved,
      });
      result = saved;
    }
  } else if (input.action === 'topic' && job.kind === 'topics') {
    const topic = (
      job.result.topics as { title: string; reason: string; angle: string; sourceIds: string[] }[]
    )[index];
    if (!topic) throw new AppError(400, 'RESULT_INDEX', '没有这条选题');
    const materialIds: string[] = [];
    for (const sourceId of topic.sourceIds) {
      const reference = source.references[sourceId];
      if (!reference) continue;
      if ((source.data.materialIds as string[]).includes(sourceId)) materialIds.push(sourceId);
      else {
        const imported = await importArticle(sql, ws, job.accountId, {
          title: reference.title,
          body: reference.body,
          url: reference.url,
        });
        materialIds.push(imported.materialId);
      }
    }
    // Same normalization as the duplicate hint, so a flagged topic is never adopted twice.
    const normalize = (value: string) => value.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
    const existing = (
      await sql.rows<{ title: string }>(
        'SELECT * FROM ideas WHERE "workspaceId"=$1 AND "accountId" IS NOT DISTINCT FROM $2 ORDER BY "createdAt" LIMIT 5000',
        [ws, job.accountId],
      )
    ).find((idea) => normalize(idea.title) === normalize(topic.title));
    result = existing
      ? { status: 'reused', idea: existing }
      : {
          status: 'created',
          idea: await insert(sql, 'ideas', {
            id: id(),
            workspaceId: ws,
            accountId: job.accountId,
            title: topic.title,
            body: `${topic.reason}\n\n角度：${topic.angle}`,
            materialIds,
            status: 'inbox',
          }),
        };
  } else if (
    input.action === 'skip' &&
    ['topics', 'compare', 'language_review', 'fact_review'].includes(job.kind)
  )
    result = { skipped: true, index };
  else if (input.action === 'workflow' && job.kind === 'workflow')
    result = await document({
      body: String(job.result.body ?? ''),
      outline: String(job.result.outline ?? ''),
    });
  else if (input.action === 'suggestion' && job.kind === 'language_review') {
    const suggestion = (job.result.suggestions as ReviewSuggestion[])[index];
    if (!suggestion) throw new AppError(400, 'RESULT_INDEX', '没有这条审校建议');
    const decisions = await sql.rows<{ data: { edit?: ReviewSuggestion } }>(
      'SELECT data FROM creator_decisions WHERE "jobId"=$1',
      [job.id],
    );
    const edits = decisions.flatMap((record) => (record.data.edit ? [record.data.edit] : []));
    if (edits.some((edit) => suggestion.start < edit.end && suggestion.end > edit.start))
      throw conflict('这条建议与已采用的修改重叠，请重新审校');
    const delta = edits
      .filter((edit) => edit.end <= suggestion.start)
      .reduce((sum, edit) => sum + edit.replacement.length - (edit.end - edit.start), 0);
    const current = await owned<ContentDocument>(sql, 'documents', ws, job.documentId!, true),
      start = suggestion.start + delta,
      end = suggestion.end + delta;
    if (current.body.slice(start, end) !== suggestion.original) throw conflict('建议对应的原文已变化');
    result = await document({
      body: current.body.slice(0, start) + suggestion.replacement + current.body.slice(end),
    });
  } else if (input.action === 'fact' && job.kind === 'fact_review') {
    const claim = (job.result.claims as { id: string }[])[index];
    if (!claim) throw new AppError(400, 'RESULT_INDEX', '没有这条待核查内容');
    const state = String(input.data?.state ?? 'unverified');
    if (!['supported', 'conflict', 'unverified'].includes(state))
      throw new AppError(400, 'FACT_STATE', '请选择有效核对结论');
    const sourceIds = Array.isArray(input.data?.sourceIds) ? (input.data!.sourceIds as string[]) : [];
    if (
      sourceIds.some((sourceId) => !source.context.citations.some((citation) => citation.id === sourceId)) ||
      (state !== 'unverified' && !sourceIds.length)
    )
      throw new AppError(400, 'FACT_SOURCE', '有来源或冲突结论需选择实际引用资料');
    result = {
      claimId: claim.id,
      state,
      sourceIds,
      note: String(input.data?.note ?? ''),
      source: 'user_checked',
    };
  } else if (input.action === 'choose' && job.kind === 'compare') {
    const candidate = (job.result.candidates as { id: string }[])[index];
    if (!candidate) throw new AppError(400, 'RESULT_INDEX', '没有这个候选版本');
    await owned(sql, 'documents', ws, candidate.id);
    result = { documentId: candidate.id, source: 'user_chosen' };
  } else if (input.action === 'preference' && job.kind === 'retrospective') {
    const suggestion = (job.result.suggestions as { content: string; metricIds: string[] }[])[index];
    if (!suggestion) throw new AppError(400, 'RESULT_INDEX', '没有这条复盘建议');
    result = await createItem(sql, ws, {
      kind: 'preference',
      name: '复盘建议',
      accountId: job.accountId,
      data: {
        content: String(input.data?.content ?? suggestion.content),
        sourceType: 'review',
        sourceId: job.id,
        state: 'proposed',
      },
    });
  } else if (input.action === 'reply' && job.kind === 'comment_reply') {
    const reply = (
      (job.result.replies ?? job.progress.replies) as { commentId: string; text: string; revision: number }[]
    )[index];
    if (!reply) throw new AppError(400, 'RESULT_INDEX', '没有这条回复');
    const current = await owned<StudioItem>(sql, 'creator_items', ws, reply.commentId, true);
    result = await saveItem(sql, ws, current.id, reply.revision, {
      ...current,
      data: { ...current.data, replyDraft: String(input.data?.text ?? reply.text), replyState: 'drafted' },
    });
  } else if (input.action === 'script' && job.kind === 'video_script')
    result = await createItem(sql, ws, {
      kind: 'video_script',
      name: String(input.data?.name ?? '转写生成的视频脚本'),
      accountId: job.accountId,
      data: job.result.script,
    });
  else if (input.action === 'images' && job.kind === 'images') {
    const images = (job.result.images ?? job.progress.images) as { assetId?: string; status: string }[];
    const current = await owned<ContentDocument>(sql, 'documents', ws, job.documentId!, true);
    const selected = Array.isArray(input.data?.indices)
      ? (input.data!.indices as number[])
      : images.map((_image, i) => i);
    const assetIds = [...current.assetIds];
    for (const i of selected) {
      const assetId = images[i]?.assetId;
      if (!assetId) continue;
      await owned(sql, 'assets', ws, assetId);
      if (!assetIds.includes(assetId)) assetIds.push(assetId);
    }
    result = await document({ assetIds }, true);
  } else throw new AppError(400, 'ACTION_UNSUPPORTED', '此结果不支持这项采用操作');
  const savedRevision =
    result && typeof result === 'object' && 'revision' in result && 'body' in result
      ? (result as ContentDocument).revision
      : undefined;
  const edit =
    input.action === 'suggestion' ? (job.result.suggestions as ReviewSuggestion[])[index] : undefined;
  await insert(sql, 'creator_decisions', {
    id: id(),
    workspaceId: ws,
    accountId: job.accountId,
    jobId: job.id,
    itemKey,
    decision: input.action,
    data: { request: canonical(input), result, savedRevision, edit },
    createdBy: identity()?.id ?? null,
  });
  // Style feedback belongs to the persona that was just adopted, not to the account whose samples were used.
  const feedback = String(input.data?.feedbackNote ?? '').trim();
  const style = job.kind === 'style';
  const owner = {
    accountId: style ? null : job.accountId,
    personaId: style ? (result as Persona).id : (source.context.persona?.id ?? null),
  };
  if (feedback && (owner.accountId || owner.personaId))
    await createItem(sql, ws, {
      kind: 'preference',
      name: '创作反馈',
      accountId: owner.accountId,
      data: {
        personaId: owner.personaId,
        content: feedback,
        sourceType: input.action === 'skip' ? 'rejection' : 'adoption',
        sourceId: job.id,
        state: 'proposed',
      },
    });
  return result;
}
export async function adoptPreference(sql: Sql, ws: string, itemId: string, field: string) {
  const preference = await owned<StudioItem>(sql, 'creator_items', ws, itemId, true);
  if (preference.kind !== 'preference') throw new AppError(400, 'PREFERENCE_KIND', '请选择偏好建议');
  const data = studioSchemas.preference.parse(preference.data);
  if (data.state === 'adopted') return preference;
  if (!['positioning', 'audience', 'tone', 'avoid'].includes(field))
    throw new AppError(400, 'PREFERENCE_FIELD', '请选择定位、读者、语气或避免表达');
  if (preference.accountId) {
    const account = await owned<Account>(sql, 'accounts', ws, preference.accountId, true);
    const key = field as keyof Account['preferences'];
    // An account value overrides the persona, so start from the value the author currently writes with.
    const inherited =
      account.personaId && !account.preferences[key]?.trim()
        ? String((await owned<Persona>(sql, 'personas', ws, account.personaId))[key as keyof Persona] ?? '')
        : '';
    const values = preferencesSchema.parse({
      ...account.preferences,
      [key]: [account.preferences[key]?.trim() || inherited, data.content].filter(Boolean).join('\n'),
    });
    await update(sql, 'accounts', ws, account.id, {
      preferences: values,
      updatedAt: new Date().toISOString(),
    });
  } else if (data.personaId) {
    const persona = await owned<Persona>(sql, 'personas', ws, data.personaId, true);
    const key = field as keyof Persona;
    const values = personaSchema.parse({
      ...persona,
      [key]: [persona[key], data.content].filter(Boolean).join('\n'),
    });
    const saved = await update<Persona>(sql, 'personas', ws, persona.id, {
      ...values,
      revision: persona.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await insert(sql, 'persona_revisions', {
      id: id(),
      workspaceId: ws,
      personaId: persona.id,
      revision: saved.revision,
      data: saved,
    });
  }
  return saveItem(sql, ws, preference.id, preference.revision, {
    ...preference,
    data: { ...data, state: 'adopted' },
  });
}
