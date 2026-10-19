import { z } from 'zod';
import type { MetricSnapshot, PublishTask } from '@one-creator/core';
import type { Sql } from './database.js';
import { id, owned } from './records.js';
import { AppError, conflict } from './errors.js';
import { canonical } from './studio.js';

export const metricLabels = {
  views: '阅读/播放',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  favorites: '收藏',
  followers: '粉丝数',
  completionRate: '完读/完播率（%）',
} as const;
export const metricValues = z.object({
  views: z.number().min(0).nullable().default(null),
  likes: z.number().min(0).nullable().default(null),
  comments: z.number().min(0).nullable().default(null),
  shares: z.number().min(0).nullable().default(null),
  favorites: z.number().min(0).nullable().default(null),
  followers: z.number().min(0).nullable().default(null),
  completionRate: z.number().min(0).max(100).nullable().default(null),
});
export const metricInput = z.object({
  publishTaskId: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }),
  basis: z.enum(['cumulative', 'period']),
  periodStart: z.iso.datetime({ offset: true }).nullable().default(null),
  values: metricValues,
});
export async function recordMetric(
  sql: Sql,
  ws: string,
  value: unknown,
  source: MetricSnapshot['source'] = 'manual',
  expectedRevision?: number,
) {
  const input = metricInput.parse(value);
  const publication = await owned<PublishTask>(sql, 'publish_tasks', ws, input.publishTaskId);
  if (publication.status !== 'published')
    throw new AppError(400, 'PUBLICATION_REQUIRED', '请先记录实际发布结果，再录入表现指标');
  if (Date.parse(input.capturedAt) > Date.now() + 60000)
    throw new AppError(400, 'METRIC_TIME', '统计时间不能在未来');
  if (
    input.basis === 'period' &&
    (!input.periodStart || Date.parse(input.periodStart) >= Date.parse(input.capturedAt))
  )
    throw new AppError(400, 'METRIC_PERIOD', '增量指标需要有效的区间开始与结束时间');
  const [existing] = await sql.rows<MetricSnapshot>(
    'SELECT * FROM metric_snapshots WHERE "workspaceId"=$1 AND "publishTaskId"=$2 AND "capturedAt"=$3 AND basis=$4 FOR UPDATE',
    [ws, publication.id, input.capturedAt, input.basis],
  );
  if (expectedRevision !== undefined && existing?.revision !== expectedRevision) throw conflict();
  if (input.basis === 'period') {
    const overlaps = await sql.rows(
      'SELECT id FROM metric_snapshots WHERE "publishTaskId"=$1 AND basis=\'period\' AND "periodStart"<$2 AND "capturedAt">$3 AND id IS DISTINCT FROM $4::uuid LIMIT 1',
      [publication.id, input.capturedAt, input.periodStart, existing?.id ?? null],
    );
    if (overlaps.length)
      throw new AppError(400, 'METRIC_OVERLAP', '同一内容的增量统计区间不能重叠，避免重复累计');
  }
  if (
    existing &&
    canonical(existing.values) === canonical(input.values) &&
    existing.periodStart === (input.periodStart ? new Date(input.periodStart).toISOString() : null)
  )
    return { status: 'reused', snapshot: existing };
  const [snapshot] = await sql.rows<MetricSnapshot>(
    `INSERT INTO metric_snapshots(id,"workspaceId","accountId","publishTaskId","capturedAt",basis,"periodStart",source,"values") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT("publishTaskId","capturedAt",basis) DO UPDATE SET "periodStart"=excluded."periodStart",source=excluded.source,"values"=excluded."values",revision=metric_snapshots.revision+1,"updatedAt"=now() RETURNING *`,
    [
      existing?.id ?? id(),
      ws,
      publication.accountId,
      publication.id,
      input.capturedAt,
      input.basis,
      input.periodStart,
      source,
      JSON.stringify(input.values),
    ],
  );
  return { status: existing ? 'updated' : 'created', snapshot };
}
