import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MetricSnapshot, PublishTask, StudioItem } from '@one-creator/core';
import { metricInput, metricLabels, recordMetric } from '@one-creator/server/metrics';
import { csvRows, csvExport, createItem } from '@one-creator/server/studio';
import { accountScope } from '@one-creator/server/permissions';
import { owned } from '@one-creator/server/records';
import { tokenHash } from '@one-creator/server/crypto';
import { AppError } from '@one-creator/server/errors';
import { workspace, recordId, pagination, type ApiContext } from './context.js';

export async function analyticsRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get('/api/metrics', async (request) => {
    const { limit, offset } = pagination(request.query);
    const { publishTaskId, accountId } = z
      .object({ publishTaskId: z.uuid().optional(), accountId: z.uuid().optional() })
      .parse(request.query);
    const params: unknown[] = [workspace(request)];
    let where = 'm."workspaceId"=$1';
    for (const [field, value] of Object.entries({ publishTaskId, accountId }))
      if (value) {
        params.push(value);
        where += ` AND m."${field}"=$${params.length}`;
      }
    where += ` AND ${accountScope(params, 'm."accountId"')}`;
    const items = await db.rows(
      `SELECT m.*,p.snapshot->>'title' AS title,p.url FROM metric_snapshots m JOIN publish_tasks p ON p.id=m."publishTaskId" WHERE ${where} ORDER BY m."capturedAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      `SELECT count(*)::int AS total FROM metric_snapshots m WHERE ${where}`,
      params,
    );
    return { items, total, limit, offset };
  });
  app.post('/api/metrics', async (request) =>
    db.transaction((sql) => recordMetric(sql, workspace(request), request.body)),
  );
  app.put('/api/metrics/:id', async (request) => {
    const current = await owned<MetricSnapshot>(
      db,
      'metric_snapshots',
      workspace(request),
      recordId(request),
    );
    const input = metricInput.extend({ expectedRevision: z.number().int().positive() }).parse(request.body);
    if (
      input.publishTaskId !== current.publishTaskId ||
      new Date(input.capturedAt).toISOString() !== current.capturedAt ||
      input.basis !== current.basis
    )
      throw new AppError(400, 'METRIC_IDENTITY', '修改时保留发布记录、统计时间和口径；新的时间请新增快照');
    return db.transaction((sql) =>
      recordMetric(sql, workspace(request), input, 'manual', input.expectedRevision),
    );
  });
  app.post('/api/metrics/import', async (request) => {
    const { csv } = z.object({ csv: z.string().max(1500000) }).parse(request.body);
    const rows = csvRows(csv);
    const headers = rows.shift() ?? [];
    const results = [];
    for (const [index, row] of rows.slice(0, 2000).entries()) {
      try {
        const fields = Object.fromEntries(headers.map((header, i) => [header, row[i] ?? '']));
        let publishTaskId = fields.publishTaskId;
        if (!publishTaskId && fields.url) {
          const [publication] = await db.rows<PublishTask>(
            'SELECT * FROM publish_tasks WHERE "workspaceId"=$1 AND url=$2 LIMIT 1',
            [workspace(request), fields.url],
          );
          if (publication) publishTaskId = publication.id;
        }
        if (!publishTaskId)
          throw new AppError(
            400,
            'PUBLICATION_REQUIRED',
            '未找到对应发布记录，请先回填链接或填写 publishTaskId',
          );
        const values = Object.fromEntries(
          Object.keys(metricLabels).map((key) => [key, fields[key]?.trim() ? Number(fields[key]) : null]),
        );
        const result = await db.transaction((sql) =>
          recordMetric(
            sql,
            workspace(request),
            {
              publishTaskId,
              capturedAt: fields.capturedAt,
              basis: fields.basis || 'cumulative',
              periodStart: fields.periodStart || null,
              values,
            },
            'csv',
          ),
        );
        results.push({ row: index + 2, status: result.status, id: result.snapshot.id });
      } catch (error) {
        results.push({
          row: index + 2,
          status: 'failed',
          error: error instanceof AppError ? error.message : '字段格式错误，请检查数字、时间与口径',
        });
      }
    }
    return { results, limited: rows.length > 2000 };
  });
  app.get('/api/metrics/export', async (request, reply) => {
    const params: unknown[] = [workspace(request)];
    const scope = accountScope(params);
    const rows = await db.rows<MetricSnapshot>(
      `SELECT * FROM metric_snapshots WHERE "workspaceId"=$1 AND ${scope} ORDER BY "capturedAt" DESC`,
      params,
    );
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="metrics.csv"');
    return csvExport([
      ['publishTaskId', 'capturedAt', 'basis', 'periodStart', ...Object.keys(metricLabels)],
      ...rows.map((row) => [
        row.publishTaskId,
        row.capturedAt,
        row.basis,
        row.periodStart,
        ...Object.keys(metricLabels).map((key) => row.values[key]),
      ]),
    ]);
  });
  app.get('/api/analytics', async (request) => {
    const filter = z
      .object({
        accountId: z.uuid().optional(),
        platform: z.string().optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        seriesId: z.uuid().optional(),
      })
      .parse(request.query);
    const params: unknown[] = [workspace(request)];
    let where = 'm."workspaceId"=$1';
    if (filter.accountId) {
      params.push(filter.accountId);
      where += ` AND m."accountId"=$${params.length}`;
    }
    if (filter.platform) {
      params.push(filter.platform);
      where += ` AND p.snapshot->'context'->'account'->>'platform'=$${params.length}`;
    }
    if (filter.from) {
      params.push(filter.from);
      where += ` AND m."capturedAt">=$${params.length}`;
    }
    if (filter.to) {
      params.push(filter.to);
      where += ` AND m."capturedAt"<$${params.length}`;
    }
    if (filter.seriesId) {
      const series = await owned<StudioItem>(db, 'creator_items', workspace(request), filter.seriesId);
      if (series.kind !== 'series') throw new AppError(400, 'SERIES_KIND', '请选择栏目系列');
      params.push(JSON.stringify((series.data.entries as { ideaId: string }[]).map((entry) => entry.ideaId)));
      where += ` AND p.snapshot->>'ideaId' IN(SELECT jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    where += ` AND ${accountScope(params, 'm."accountId"')}`;
    const rows = await db.rows<MetricSnapshot & { title: string; platform: string; accountName: string }>(
      `SELECT m.*,p.snapshot->>'title' AS title,p.snapshot->'context'->'account'->>'platform' AS platform,a.name AS "accountName" FROM metric_snapshots m JOIN publish_tasks p ON p.id=m."publishTaskId" JOIN accounts a ON a.id=m."accountId" WHERE ${where} ORDER BY m."capturedAt" DESC LIMIT 10000`,
      params,
    );
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (row.basis === 'cumulative' && !latest.has(row.publishTaskId)) latest.set(row.publishTaskId, row);
    const summarize = (samples: typeof rows) =>
      Object.fromEntries(
        Object.entries(metricLabels).map(([key, label]) => {
          const known = samples
            .map((row) => row.values[key])
            .filter((value) => value !== null && value !== undefined);
          return [
            key,
            {
              label,
              knownTotal:
                key === 'completionRate'
                  ? null
                  : known.length
                    ? known.reduce((sum, value) => sum + value, 0)
                    : null,
              missing: samples.length - known.length,
              samples: samples.length,
            },
          ];
        }),
      );
    const periods = rows.filter((row) => row.basis === 'period');
    return {
      latest: [...latest.values()],
      periods,
      cumulativeSummary: summarize([...latest.values()]),
      periodSummary: summarize(periods),
      definitions:
        '累计值每篇只取筛选范围内最后一次快照；增量值单列，不与累计相加。跨平台阅读/播放口径可能不同，空值代表缺失，不是零。比例指标不直接加总。',
      range: {
        from: filter.from ?? null,
        to: filter.to ?? null,
        rows: rows.length,
        limited: rows.length === 10000,
      },
    };
  });
  app.post('/api/comments/import', async (request) => {
    const { csv } = z.object({ csv: z.string().max(1500000) }).parse(request.body);
    const rows = csvRows(csv);
    const headers = rows.shift() ?? [];
    const results = [];
    for (const [index, row] of rows.slice(0, 2000).entries()) {
      try {
        const fields = Object.fromEntries(headers.map((header, i) => [header, row[i] ?? '']));
        const publication = await owned<PublishTask>(
          db,
          'publish_tasks',
          workspace(request),
          fields.publishTaskId,
        );
        const key = tokenHash(
          `${publication.id}:${fields.externalId || `${fields.author}:${fields.publishedAt}:${fields.text}`}`,
        );
        const [old] = await db.rows<{ id: string }>(
          'SELECT id FROM creator_items WHERE "workspaceId"=$1 AND kind=\'comment\' AND "externalKey"=$2',
          [workspace(request), key],
        );
        if (old) {
          results.push({ row: index + 2, status: 'reused', id: old.id });
          continue;
        }
        const item = await db.transaction((sql) =>
          createItem(
            sql,
            workspace(request),
            {
              kind: 'comment',
              name: fields.text?.slice(0, 80) || '导入评论',
              accountId: publication.accountId,
              data: {
                publishTaskId: publication.id,
                author: fields.author,
                text: fields.text,
                publishedAt: fields.publishedAt,
                externalId: fields.externalId,
              },
            },
            key,
          ),
        );
        results.push({ row: index + 2, status: 'created', id: item.id });
      } catch (error) {
        results.push({
          row: index + 2,
          status: 'failed',
          error: error instanceof AppError ? error.message : '评论字段格式不正确',
        });
      }
    }
    return { results, limited: rows.length > 2000 };
  });
}
