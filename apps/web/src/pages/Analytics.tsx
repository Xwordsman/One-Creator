import { useState } from 'react';
import { BarChart3, Download, Plus, Upload } from 'lucide-react';
import { platforms, type MetricSnapshot } from '@one-creator/core';
import { api, dateTime, download, useCommand, useGet, useReferenceOptions } from '../lib/api';
import {
  SchemaFields,
  schemaDefault,
  type SchemaNode,
  type ReferenceOptions,
} from '../components/SchemaForm';
import { AutomationComposer } from '../components/AutomationComposer';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  Loading,
  Modal,
  PageHeading,
  QueryError,
  useToast,
} from '../components/ui';

const labels = {
  views: '阅读 / 播放',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  favorites: '收藏',
  followers: '粉丝',
  completionRate: '完读 / 完播率',
};
const valuesSchema: SchemaNode = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(labels).map((key) => [
      key,
      {
        anyOf: [
          { type: 'number', minimum: 0, ...(key === 'completionRate' ? { maximum: 100 } : {}) },
          { type: 'null' },
        ],
        default: null,
      },
    ]),
  ),
};
const schema: SchemaNode = {
  type: 'object',
  properties: {
    publishTaskId: { type: 'string', format: 'uuid' },
    capturedAt: { type: 'string', format: 'date-time' },
    basis: { type: 'string', enum: ['cumulative', 'period'], default: 'cumulative' },
    periodStart: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], default: null },
    values: valuesSchema,
  },
  required: ['publishTaskId', 'capturedAt', 'basis'],
};
interface Stat extends MetricSnapshot {
  title: string;
  platform: string;
  accountName: string;
}
interface AnalyticsData {
  latest: Stat[];
  periods: Stat[];
  cumulativeSummary: Record<
    string,
    { label: string; knownTotal: number | null; missing: number; samples: number }
  >;
  periodSummary: Record<
    string,
    { label: string; knownTotal: number | null; missing: number; samples: number }
  >;
  definitions: string;
}
function MetricForm({ record, onClose }: { record: Stat | null; onClose: () => void }) {
  const [value, setValue] = useState<Record<string, unknown>>(
    record
      ? { ...record }
      : { ...(schemaDefault(schema) as Record<string, unknown>), capturedAt: new Date().toISOString() },
  );
  const options = useReferenceOptions<ReferenceOptions>();
  const save = useCommand(
    () =>
      api(record ? `/metrics/${record.id}` : '/metrics', record ? 'PUT' : 'POST', {
        ...value,
        expectedRevision: record?.revision,
      }),
    onClose,
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {record && (
        <p>
          {record.title} · {dateTime(record.capturedAt)}
        </p>
      )}
      <SchemaFields
        schema={record ? { type: 'object', properties: { values: valuesSchema } } : schema}
        value={value}
        onChange={setValue}
        options={{
          ...options.data,
          publications: options.data?.publications?.filter((item) => item.status === 'published') ?? [],
        }}
      />
      <p className="field-hint">留空代表没有取得该指标，不会记为零。区间增量需填开始时间，不允许重叠累计。</p>
      <Alert>{save.error?.message}</Alert>
      <Button type="submit" busy={save.isPending}>
        保存统计快照
      </Button>
    </form>
  );
}
export default function Analytics() {
  const [accountId, setAccountId] = useState(''),
    [platform, setPlatform] = useState(''),
    [seriesId, setSeriesId] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [basis, setBasis] = useState<'cumulative' | 'period'>('cumulative'),
    [editing, setEditing] = useState<Stat | 'new' | null>(null),
    [retro, setRetro] = useState<Stat | null>(null),
    [error, setError] = useState(''),
    [importResults, setImportResults] = useState<Record<string, unknown>[] | null>(null);
  const options = useReferenceOptions<ReferenceOptions>();
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (platform) params.set('platform', platform);
  if (seriesId) params.set('seriesId', seriesId);
  if (from) params.set('from', new Date(`${from}T00:00`).toISOString());
  if (to) {
    const date = new Date(`${to}T00:00`);
    date.setDate(date.getDate() + 1);
    params.set('to', date.toISOString());
  }
  const query = useGet<AnalyticsData>(`/analytics?${params}`);
  const toast = useToast();
  const importCsv = useCommand(
    async (file: File) => {
      if (file.size > 1500000) throw new Error('CSV 文件最多 1.5 MB');
      return api<{ results: Record<string, unknown>[] }>('/metrics/import', 'POST', {
        csv: await file.text(),
      });
    },
    (result) => {
      setImportResults(result.results);
      toast('导入已逐项处理');
    },
  );
  const rows = basis === 'cumulative' ? query.data?.latest : query.data?.periods;
  const summary = basis === 'cumulative' ? query.data?.cumulativeSummary : query.data?.periodSummary;
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="UNDERSTAND WHAT RESONATES"
        title="表现数据与内容复盘"
        description="把真实统计、口径和作者观察放在一起，形成可追溯的经验。"
      >
        <label className="file-button secondary">
          <Upload size={15} />
          导入指标 CSV
          <input
            type="file"
            accept=".csv"
            onChange={(event) => {
              if (event.target.files?.[0]) importCsv.mutate(event.target.files[0]);
            }}
          />
        </label>
        <Button
          variant="secondary"
          onClick={() =>
            void download('/metrics/export', 'metrics.csv').catch((error) => setError(error.message))
          }
        >
          <Download size={15} />
          导出
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus size={16} />
          记录指标
        </Button>
      </PageHeading>
      <div className="analytics-filters">
        <Field label="账号">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">全部</option>
            {options.data?.accounts?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="平台">
          <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
            <option value="">全部</option>
            {Object.entries(platforms).map(([key, value]) => (
              <option value={key} key={key}>
                {value.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="栏目">
          <select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>
            <option value="">全部</option>
            {options.data?.items
              ?.filter((item) => item.kind === 'series')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="开始日期">
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="结束日期">
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button className={basis === 'cumulative' ? 'active' : ''} onClick={() => setBasis('cumulative')}>
            每篇最新累计快照
          </button>
          <button className={basis === 'period' ? 'active' : ''} onClick={() => setBasis('period')}>
            区间增量
          </button>
        </div>
      </div>
      <Alert>{error || importCsv.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : (
        <>
          <div className="info-note inline-note">{query.data!.definitions}</div>
          <div className="summary-grid">
            {['views', 'likes', 'comments', 'shares'].map((key) => (
              <section className="panel summary-card" key={key}>
                <span>{summary?.[key].label}</span>
                <strong>
                  {summary?.[key].knownTotal === null ? '未知' : summary?.[key].knownTotal.toLocaleString()}
                </strong>
                <small>
                  {summary?.[key].missing} 项缺失 · {summary?.[key].samples} 个样本
                </small>
              </section>
            ))}
          </div>
          {rows?.length ? (
            <div className="panel data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>统计时间 / 口径</th>
                    {Object.values(labels).map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.title}</strong>
                        <small>
                          {row.accountName} ·{' '}
                          {platforms[row.platform as keyof typeof platforms]?.short ?? row.platform}
                        </small>
                      </td>
                      <td>
                        {dateTime(row.capturedAt)}
                        <small>
                          {row.source === 'wechat'
                            ? '平台接口'
                            : row.source === 'csv'
                              ? 'CSV 导入'
                              : '用户记录'}{' '}
                          · v{row.revision}
                        </small>
                      </td>
                      {Object.keys(labels).map((key) => (
                        <td key={key}>{row.values[key] ?? '—'}</td>
                      ))}
                      <td>
                        <div className="table-actions">
                          <Button variant="ghost" onClick={() => setEditing(row)}>
                            修正
                          </Button>
                          <Button variant="ghost" onClick={() => setRetro(row)}>
                            复盘
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel">
              <Empty
                icon={BarChart3}
                title="用真实数据建立基线"
                description="先为已发布内容记录统计快照，空值保持未知；这里不会填入演示指标。"
              />
            </div>
          )}
        </>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="统计快照" wide>
        {editing && (
          <MetricForm record={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
        )}
      </Modal>
      <Modal open={!!retro} onClose={() => setRetro(null)} title="生成内容复盘" wide>
        {retro && (
          <AutomationComposer
            kind="retrospective"
            accountId={retro.accountId}
            initialData={{ publishTaskId: retro.publishTaskId, metricIds: [retro.id] }}
            onCreated={() => setRetro(null)}
          />
        )}
      </Modal>
      <Modal open={!!importResults} onClose={() => setImportResults(null)} title="CSV 导入结果" wide>
        <p className="field-hint">
          列名：publishTaskId 或
          url、capturedAt、basis、periodStart、views、likes、comments、shares、favorites、followers、completionRate。
        </p>
        <div className="result-list">
          {importResults?.map((result, index) => (
            <article key={index}>
              <Badge>{String(result.status)}</Badge> 第 {String(result.row)} 行
              <p>{String(result.error ?? '已保存，不会重复累计')}</p>
            </article>
          ))}
        </div>
      </Modal>
    </div>
  );
}
