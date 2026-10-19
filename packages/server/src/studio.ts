import { z } from 'zod';
import { studioInputSchema, studioSchemas, type StudioItem, type StudioKind } from '@one-creator/core';
import type { Sql } from './database.js';
import { checkReference, id, insert, owned, update } from './records.js';
import { identity } from './permissions.js';
import { AppError, conflict } from './errors.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function item(sql: Sql, ws: string, itemId: string, kind?: StudioKind) {
  const result = await owned<StudioItem>(sql, 'creator_items', ws, itemId);
  if (kind && result.kind !== kind) throw new AppError(400, 'ITEM_KIND', '引用的资源类型不匹配');
  return result;
}
export async function validateItem(sql: Sql, ws: string, value: unknown) {
  const input = studioInputSchema.parse(value);
  const data = studioSchemas[input.kind].parse(input.data) as Record<string, unknown>;
  await checkReference(sql, 'accounts', ws, input.accountId);
  for (const field of ['materialIds', 'documentIds'] as const)
    for (const resourceId of (data[field] ?? []) as string[])
      await checkReference(sql, field === 'materialIds' ? 'materials' : 'documents', ws, resourceId);
  for (const [field, table] of Object.entries({
    personaId: 'personas',
    publishTaskId: 'publish_tasks',
    assetId: 'assets',
    feedId: 'feeds',
  }))
    await checkReference(sql, table, ws, data[field] as string | null);
  if (data.publishTaskId) {
    const publication = await owned<{ accountId: string }>(
      sql,
      'publish_tasks',
      ws,
      String(data.publishTaskId),
    );
    if (input.accountId && input.accountId !== publication.accountId)
      throw new AppError(400, 'ACCOUNT_MISMATCH', '关联发布记录与所选账号不一致');
    input.accountId = publication.accountId;
  }
  if (input.kind === 'series')
    for (const entry of data.entries as { ideaId: string }[])
      await checkReference(sql, 'ideas', ws, entry.ideaId);
  // A workflow is checked when saved, with the same rules a run applies, so it cannot fail later for a fixable setup.
  if (input.kind === 'workflow')
    for (const [index, step] of (
      data.steps as {
        name: string;
        kind: string;
        promptId: string | null;
        variables: Record<string, string>;
      }[]
    ).entries()) {
      if (!step.promptId) {
        if (Object.keys(step.variables).length)
          throw new AppError(400, 'TEMPLATE_VARIABLE', `第 ${index + 1} 步没有选择预设，不能填写变量`);
        continue;
      }
      const prompt = await item(sql, ws, step.promptId, 'prompt');
      if (String(prompt.data.scenario) !== step.kind)
        throw new AppError(
          400,
          'TEMPLATE_SCENARIO',
          `第 ${index + 1} 步「${step.name}」的预设适用于其他步骤类型`,
        );
      if (prompt.accountId && prompt.accountId !== input.accountId)
        throw new AppError(400, 'TEMPLATE_SCOPE', `第 ${index + 1} 步的预设属于另一个账号`);
      try {
        renderPrompt(prompt, step.variables);
      } catch (error) {
        if (error instanceof AppError)
          throw new AppError(400, error.code, `第 ${index + 1} 步：${error.message}`);
        throw error;
      }
    }
  if (input.kind === 'prompt') {
    const variables = (data.variables as { key: string }[]).map((v) => v.key);
    if (new Set(variables).size !== variables.length)
      throw new AppError(400, 'TEMPLATE_VARIABLE', '变量名称不能重复');
    const used = [...(data.template as string).matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map(
      (m) => m[1],
    );
    if (used.some((key) => !variables.includes(key)))
      throw new AppError(400, 'TEMPLATE_VARIABLE', '模板中的变量需要先声明');
  }
  if (input.kind === 'preference' && !input.accountId && !data.personaId)
    throw new AppError(400, 'PREFERENCE_TARGET', '偏好必须关联一个账号或人设');
  if (input.kind === 'collaboration' && Number(data.paid) > Number(data.amount))
    throw new AppError(400, 'PAYMENT_AMOUNT', '已收款不能超过约定费用');
  if (input.kind === 'transcript')
    for (const segment of data.segments as { start: number; end: number }[])
      if (segment.end <= segment.start)
        throw new AppError(400, 'SEGMENT_RANGE', '转写的结束时间必须大于开始时间');
  if (input.kind === 'video_script') {
    if (data.transcriptId) await item(sql, ws, String(data.transcriptId), 'transcript');
    for (const scene of data.scenes as { imageAssetId: string | null }[])
      await checkReference(sql, 'assets', ws, scene.imageAssetId);
  }
  if (input.kind === 'review')
    for (const metricId of data.metricIds as string[])
      await checkReference(sql, 'metric_snapshots', ws, metricId);
  return { ...input, data };
}
export async function createItem(sql: Sql, ws: string, value: unknown, externalKey?: string) {
  const input = await validateItem(sql, ws, value);
  const result = await insert<StudioItem>(sql, 'creator_items', {
    ...input,
    id: id(),
    workspaceId: ws,
    createdBy: identity()?.id ?? null,
    externalKey: externalKey ?? null,
  });
  await insert(sql, 'creator_item_revisions', {
    id: id(),
    workspaceId: ws,
    itemId: result.id,
    revision: result.revision,
    data: result,
  });
  return result;
}
export async function saveItem(
  sql: Sql,
  ws: string,
  itemId: string,
  expectedRevision: number,
  value: unknown,
) {
  const current = await owned<StudioItem>(sql, 'creator_items', ws, itemId, true);
  if (current.revision !== expectedRevision) throw conflict();
  const input = await validateItem(sql, ws, value);
  if (input.kind !== current.kind) throw new AppError(400, 'ITEM_KIND', '资源类型不能更改');
  const result = await update<StudioItem>(sql, 'creator_items', ws, itemId, {
    ...input,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  await insert(sql, 'creator_item_revisions', {
    id: id(),
    workspaceId: ws,
    itemId,
    revision: result.revision,
    data: result,
  });
  return result;
}
export function renderPrompt(template: StudioItem, values: Record<string, string>) {
  const data = studioSchemas.prompt.parse(template.data);
  const params: Record<string, string> = {};
  for (const variable of data.variables) {
    const value = values[variable.key] ?? variable.default;
    if (variable.required && !value.trim())
      throw new AppError(400, 'TEMPLATE_VARIABLE', `请填写变量：${variable.label}`);
    params[variable.key] = value;
  }
  for (const key of Object.keys(values))
    if (!data.variables.some((v) => v.key === key))
      throw new AppError(400, 'TEMPLATE_VARIABLE', `未声明的变量：${key}`);
  return {
    instruction: data.template.replace(
      /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g,
      (_match, key: string) => params[key] ?? '',
    ),
    params,
    template: { id: template.id, name: template.name, revision: template.revision, data },
    creativity: data.creativity,
  };
}
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  // The BOM written by csvExport (and by spreadsheet apps) must not count as field content before a quote.
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (!quoted && value.length) throw new AppError(400, 'CSV_FORMAT', 'CSV 引号位置不正确');
      else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  if (quoted) throw new AppError(400, 'CSV_FORMAT', 'CSV 引号没有闭合');
  row.push(value);
  if (row.some(Boolean)) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows;
}
export function csvExport(rows: unknown[][]) {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = value === null || value === undefined ? '' : String(value);
            if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
            return `"${text.replaceAll('"', '""')}"`;
          })
          .join(','),
      )
      .join('\r\n')
  );
}
