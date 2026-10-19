import type { Activity, ActivityKind } from '@one-creator/core';
import type { Sql } from './database.js';
import { id, insert, owned } from './records.js';
import { AppError, conflict } from './errors.js';

export async function startActivity(
  sql: Sql,
  workspaceId: string,
  input: { kind: ActivityKind; title: string; documentId?: string | null; parentId?: string },
) {
  if (input.documentId) await owned(sql, 'documents', workspaceId, input.documentId);
  const parent = input.parentId
    ? await owned<Activity>(sql, 'activities', workspaceId, input.parentId)
    : null;
  if (
    parent &&
    (parent.status !== 'failed' ||
      parent.kind !== input.kind ||
      parent.documentId !== (input.documentId ?? null))
  )
    throw conflict('只能从同一操作的失败记录重新尝试');
  const stage =
    input.kind === 'import_text' ? 'importing' : input.kind === 'export_document' ? 'exporting' : 'rendering';
  return insert<Activity>(sql, 'activities', {
    id: id(),
    workspaceId,
    documentId: input.documentId ?? null,
    title: input.title,
    kind: input.kind,
    stage,
    parentId: parent?.id ?? null,
    attempt: parent ? parent.attempt + 1 : 1,
  });
}
export async function finishActivity(
  sql: Sql,
  workspaceId: string,
  activityId: string,
  status: 'succeeded' | 'failed',
  message = '',
) {
  await owned(sql, 'activities', workspaceId, activityId);
  const [result] = await sql.rows<Activity>(
    `UPDATE activities SET status=$1,stage=CASE WHEN $1='succeeded' THEN 'done' ELSE stage END,output=$2,error=$3,"finishedAt"=now()
    WHERE id=$4 AND "workspaceId"=$5 AND status='running' AND "leaseUntil">now() RETURNING *`,
    [
      status,
      status === 'succeeded' ? message : '',
      status === 'failed' ? message : '',
      activityId,
      workspaceId,
    ],
  );
  if (!result) throw conflict('操作已结束或页面离开，不能覆盖这条记录');
  return result;
}
export async function trackExport<T>(
  sql: Sql,
  workspaceId: string,
  documentId: string,
  title: string,
  run: () => Promise<T>,
  parentId?: string,
) {
  const activity = await startActivity(sql, workspaceId, {
    kind: 'export_document',
    documentId,
    title,
    parentId,
  });
  try {
    const result = await run();
    await finishActivity(sql, workspaceId, activity.id, 'succeeded', '发布包已生成，下载不代表已发布');
    return result;
  } catch (error) {
    await finishActivity(
      sql,
      workspaceId,
      activity.id,
      'failed',
      error instanceof AppError ? error.message : '导出失败，请重试',
    ).catch(() => {});
    throw error;
  }
}
