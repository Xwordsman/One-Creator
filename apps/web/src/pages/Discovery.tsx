import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Rss, Plus, RefreshCw, Search, Sparkles } from 'lucide-react';
import { automationNames, type AutomationKind, type Feed, type FeedEntry } from '@one-creator/core';
import { api, dateTime, useGet, useCommand, useReferenceOptions } from '../lib/api';
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
  Pagination,
  QueryError,
  useToast,
} from '../components/ui';

const schema: SchemaNode = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 200 },
    kind: { type: 'string', enum: ['rss', 'json_feed'], default: 'rss' },
    url: { type: 'string', format: 'uri' },
    accountId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }], default: null },
    enabled: { type: 'boolean', default: true },
    include: { type: 'array', items: { type: 'string' }, default: [] },
    exclude: { type: 'array', items: { type: 'string' }, default: [] },
    intervalMinutes: { type: 'integer', minimum: 5, maximum: 10080, default: 60 },
  },
  required: ['name', 'kind', 'url'],
};
function FeedForm({ feed, onClose }: { feed: Feed | null; onClose: () => void }) {
  const [data, setData] = useState(feed ?? (schemaDefault(schema) as Record<string, unknown>));
  const refs = useReferenceOptions<ReferenceOptions>();
  const save = useCommand(
    () =>
      api(feed ? `/feeds/${feed.id}` : '/feeds', feed ? 'PUT' : 'POST', {
        ...data,
        expectedRevision: feed?.revision,
      }),
    () => onClose(),
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <SchemaFields
        schema={schema}
        value={data as unknown as Record<string, unknown>}
        onChange={setData}
        options={refs.data ?? {}}
      />
      <Alert>{save.error?.message}</Alert>
      <Button type="submit" busy={save.isPending}>
        保存订阅
      </Button>
    </form>
  );
}
export default function Discovery() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'feeds';
  const [offset, setOffset] = useState(0),
    [feedId, setFeedId] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [editing, setEditing] = useState<Feed | 'new' | null>(null),
    [task, setTask] = useState<{ kind: AutomationKind; data?: Record<string, unknown> } | null>(null),
    [keyword, setKeyword] = useState(''),
    [search, setSearch] = useState(''),
    [accountId, setAccountId] = useState('');
  const feeds = useGet<{ items: Feed[] }>('/feeds?limit=500');
  const entries = useGet<{ items: FeedEntry[]; total: number }>(
    `/feed-entries?limit=15&offset=${offset}${feedId ? `&feedId=${feedId}` : ''}`,
  );
  const options = useReferenceOptions<ReferenceOptions>();
  const results = useGet<{
    mode: string;
    reason?: string;
    model?: string;
    items: {
      materialId: string;
      title: string;
      url: string;
      body: string;
      revision: number;
      score?: number;
    }[];
  }>(
    `/materials/search?q=${encodeURIComponent(search)}${accountId ? `&accountId=${accountId}` : ''}`,
    !!search,
  );
  const refresh = useCommand((feed: Feed) =>
    api(`/feeds/${feed.id}/refresh`, 'POST', {}, { 'idempotency-key': crypto.randomUUID() }),
  );
  const toast = useToast();
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="GOOD IDEAS START WITH GOOD INPUT"
        title="订阅、选题与资料召回"
        description="保留来源、采集时间和失败状态，把输入整理成可用的创作线索。"
      >
        <Button variant="secondary" onClick={() => setTask({ kind: 'import' })}>
          网页 / 历史文章导入
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus size={16} />
          添加订阅
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="tabs">
          <button className={tab === 'feeds' ? 'active' : ''} onClick={() => setParams({ tab: 'feeds' })}>
            <Rss size={16} />
            订阅内容
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setParams({ tab: 'search' })}>
            <Search size={16} />
            语义检索
          </button>
        </div>
        {tab === 'feeds' && (
          <Button
            variant="secondary"
            disabled={!selected.length}
            onClick={() => setTask({ kind: 'topics', data: { feedEntryIds: selected } })}
          >
            <Sparkles size={15} />
            为账号推荐选题（{selected.length}）
          </Button>
        )}
      </div>
      <Alert>{refresh.error?.message}</Alert>
      {tab === 'feeds' ? (
        <div className="discovery-layout">
          <aside className="panel source-list">
            <button
              className={!feedId ? 'active' : ''}
              onClick={() => {
                setFeedId('');
                setOffset(0);
              }}
            >
              全部来源
            </button>
            {feeds.data?.items.map((feed) => (
              <article key={feed.id}>
                <button
                  className={feedId === feed.id ? 'active' : ''}
                  onClick={() => {
                    setFeedId(feed.id);
                    setOffset(0);
                  }}
                >
                  {feed.name}
                </button>
                <small>
                  {feed.kind === 'rss' ? 'RSS / Atom' : 'JSON Feed'} · {feed.enabled ? '启用' : '停用'} · 每{' '}
                  {feed.intervalMinutes} 分钟
                </small>
                <small>最近采集：{feed.lastFetchedAt ? dateTime(feed.lastFetchedAt) : '尚未采集'}</small>
                {feed.error && <p className="text-error">{feed.error}</p>}
                <div className="table-actions">
                  <Button variant="ghost" onClick={() => setEditing(feed)}>
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!feed.enabled}
                    busy={refresh.isPending}
                    onClick={() =>
                      refresh.mutate(feed, { onSuccess: () => toast('刷新任务已排队，可在任务中心查看') })
                    }
                  >
                    <RefreshCw size={14} />
                    刷新
                  </Button>
                </div>
              </article>
            ))}
          </aside>
          <section>
            {entries.isPending ? (
              <Loading />
            ) : entries.error ? (
              <QueryError error={entries.error} />
            ) : entries.data!.items.length ? (
              <div className="result-list">
                {entries.data!.items.map((entry) => (
                  <article className="panel feed-entry" key={entry.id}>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={selected.includes(entry.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, entry.id]
                              : selected.filter((id) => id !== entry.id),
                          )
                        }
                      />
                      <strong>{entry.title}</strong>
                    </label>
                    <p>{entry.body.slice(0, 400)}</p>
                    <small>
                      {entry.feedName} · 采集于 {dateTime(entry.fetchedAt)}
                      {entry.publishedAt && ` · 来源时间 ${dateTime(entry.publishedAt)}`}
                    </small>
                    <a className="text-link" href={entry.url} target="_blank" rel="noreferrer">
                      阅读原始来源
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="panel">
                <Empty
                  icon={Rss}
                  title="等待你的第一条订阅内容"
                  description="添加 RSS / Atom 或 JSON Feed，启用后自动按间隔抓取；也可以手动刷新。"
                />
              </div>
            )}
            {entries.data && (
              <Pagination total={entries.data.total} offset={offset} limit={15} onChange={setOffset} />
            )}
          </section>
        </div>
      ) : (
        <section className="panel result-panel">
          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (keyword.trim() === search) void results.refetch();
              else setSearch(keyword.trim());
            }}
          >
            <Field label="想找什么资料">
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                required
                placeholder="描述你想找的观点、例子或片段"
              />
            </Field>
            <Field label="资料可用账号">
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">全部授权范围</option>
                {options.data?.accounts?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit">搜索资料</Button>
            <Button variant="secondary" onClick={() => setTask({ kind: 'embedding_rebuild' })}>
              重建语义索引
            </Button>
          </form>
          {!search ? (
            <Empty
              icon={Search}
              title="按含义寻找资料"
              description="配置向量服务并重建索引后可按语义召回；服务不可用时自动回退关键词检索。"
            />
          ) : results.isPending ? (
            <Loading />
          ) : results.error ? (
            <QueryError error={results.error} />
          ) : (
            <>
              <div className="info-note">
                {results.data?.mode === 'semantic'
                  ? `语义检索 · ${results.data.model}`
                  : `关键词检索 · ${results.data?.reason}`}
              </div>
              <div className="result-list">
                {results.data?.items.map((item, index) => (
                  <article key={`${item.materialId}-${index}`}>
                    <h2>{item.title}</h2>
                    <small>
                      素材 v{item.revision}
                      {item.score !== undefined && ` · 相似度 ${(item.score * 100).toFixed(1)}%`}
                    </small>
                    <blockquote>{item.body}</blockquote>
                    {item.url && (
                      <a className="text-link" href={item.url} target="_blank" rel="noreferrer">
                        查看出处
                      </a>
                    )}
                  </article>
                ))}
              </div>
              {!results.data?.items.length && <p className="field-hint">没有匹配的资料，筛选条件已保留。</p>}
            </>
          )}
        </section>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="订阅来源" wide>
        {editing && <FeedForm feed={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </Modal>
      <Modal
        open={!!task}
        onClose={() => setTask(null)}
        title={task ? automationNames[task.kind] : '创建任务'}
        wide
      >
        {task && (
          <AutomationComposer kind={task.kind} initialData={task.data} onCreated={() => setTask(null)} />
        )}
      </Modal>
    </div>
  );
}
