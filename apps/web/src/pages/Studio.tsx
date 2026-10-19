import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Archive, Copy, Download, History, Play, Plus, Upload, Sparkles } from 'lucide-react';
import {
  studioNames,
  automationNames,
  type StudioItem,
  type StudioKind,
  type AutomationKind,
  type ContentDocument,
} from '@one-creator/core';
import { api, download, useGet, useCommand, dateTime, useReferenceOptions } from '../lib/api';
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

function ItemForm({
  kind,
  item,
  schema,
  onClose,
}: {
  kind: StudioKind;
  item: StudioItem | null;
  schema: SchemaNode;
  onClose: () => void;
}) {
  const [name, setName] = useState(item?.name ?? ''),
    [accountId, setAccountId] = useState(item?.accountId ?? ''),
    [data, setData] = useState(item?.data ?? (schemaDefault(schema) as Record<string, unknown>));
  const options = useReferenceOptions<ReferenceOptions>();
  const toast = useToast();
  const save = useCommand(
    () =>
      api(item ? `/studio/items/${item.id}` : '/studio/items', item ? 'PUT' : 'POST', {
        kind,
        name,
        accountId: accountId || null,
        data,
        expectedRevision: item?.revision,
      }),
    () => {
      toast('已保存，资源版本已记录');
      onClose();
    },
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-grid">
        <Field label="名称" required>
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
        </Field>
        <Field label="所属账号">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">工作空间共享</option>
            {options.data?.accounts?.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <SchemaFields schema={schema} value={data} onChange={setData} options={options.data ?? {}} />
      <Alert>{save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存{studioNames[kind]}
        </Button>
      </div>
    </form>
  );
}
function UsePrompt({ item, onClose }: { item: StudioItem; onClose: () => void }) {
  const [documentId, setDocumentId] = useState(''),
    [variables, setVariables] = useState<Record<string, string>>({});
  const options = useReferenceOptions<ReferenceOptions>();
  const navigate = useNavigate();
  const [key] = useState(() => crypto.randomUUID());
  const run = useCommand(
    async () => {
      const document = await api<ContentDocument>(`/documents/${documentId}`);
      return api(
        '/jobs',
        'POST',
        {
          documentId,
          expectedRevision: document.revision,
          kind: item.data.scenario,
          templateId: item.id,
          variables,
        },
        { 'idempotency-key': key },
      );
    },
    () => {
      onClose();
      navigate(`/contents/${documentId}`);
    },
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        run.mutate();
      }}
    >
      <Field label="目标文稿" required>
        <select value={documentId} onChange={(event) => setDocumentId(event.target.value)} required>
          <option value="">请选择</option>
          {options.data?.documents
            ?.filter((doc) => !item.accountId || doc.accountId === item.accountId)
            .map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.label}
              </option>
            ))}
        </select>
      </Field>
      {(item.data.variables as { key: string; label: string; default: string; required: boolean }[]).map(
        (variable) => (
          <Field label={variable.label} required={variable.required} key={variable.key}>
            <textarea
              value={variables[variable.key] ?? variable.default}
              required={variable.required}
              rows={2}
              onChange={(event) => setVariables({ ...variables, [variable.key]: event.target.value })}
            />
          </Field>
        ),
      )}
      <p className="field-hint">使用预设 v{item.revision}；生成结果保留为候选，不会自动替换文稿。</p>
      <Alert>{run.error?.message}</Alert>
      <Button type="submit" busy={run.isPending}>
        使用预设生成
      </Button>
    </form>
  );
}
function ItemHistory({ item }: { item: StudioItem }) {
  const query = useGet<{ revision: number; data: StudioItem; createdAt: string }[]>(
    `/studio/items/${item.id}/revisions`,
  );
  return (
    <div className="result-list">
      {query.data?.map((row) => (
        <article key={row.revision}>
          <strong>
            v{row.revision} · {dateTime(row.createdAt)}
          </strong>
          <pre className="output-text">{JSON.stringify(row.data.data, null, 2)}</pre>
        </article>
      ))}
    </div>
  );
}
function SeriesContents({ item }: { item: StudioItem }) {
  const query = useGet<{
    items: {
      date: string;
      idea: { id: string; title: string };
      documents: { id: string; title: string }[];
    }[];
  }>(`/series/${item.id}/contents`);
  return query.isPending ? (
    <Loading />
  ) : query.error ? (
    <QueryError error={query.error} />
  ) : (
    <div className="result-list">
      {query.data!.items.map((entry, index) => (
        <article key={`${entry.idea.id}-${index}`}>
          <strong>
            {index + 1}. {entry.idea.title}
          </strong>
          <p>{entry.date || '尚未安排创作日期'}</p>
          {entry.documents.map((doc) => (
            <Link className="text-link" to={`/contents/${doc.id}`} key={doc.id}>
              {doc.title}
            </Link>
          ))}
          {!entry.documents.length && <small>尚未转为稿件</small>}
        </article>
      ))}
    </div>
  );
}
export default function Studio() {
  const [params, setParams] = useSearchParams();
  const kind = (
    Object.hasOwn(studioNames, params.get('kind') ?? '') ? params.get('kind') : 'prompt'
  ) as StudioKind;
  const [offset, setOffset] = useState(0),
    [search, setSearch] = useState('');
  const query = useGet<{ items: StudioItem[]; total: number }>(
    `/studio/items?kind=${kind}&limit=12&offset=${offset}&q=${encodeURIComponent(search)}`,
  );
  const catalog = useGet<Record<StudioKind, { schema: SchemaNode }>>('/studio/catalog');
  const [editing, setEditing] = useState<StudioItem | 'new' | null>(null),
    [history, setHistory] = useState<StudioItem | null>(null),
    [usePrompt, setUsePrompt] = useState<StudioItem | null>(null),
    [series, setSeries] = useState<StudioItem | null>(null),
    [preference, setPreference] = useState<StudioItem | null>(null),
    [preferenceField, setPreferenceField] = useState('tone');
  const [task, setTask] = useState<{
      kind: AutomationKind;
      data?: Record<string, unknown>;
      accountId?: string | null;
    } | null>(null),
    [error, setError] = useState('');
  const toast = useToast();
  const copy = useCommand(
    (item: StudioItem) =>
      api('/studio/items', 'POST', { ...item, name: `${item.name.slice(0, 185)} · 副本` }),
    () => toast('已复制为独立资源'),
  );
  const archive = useCommand(
    (item: StudioItem) => api(`/studio/items/${item.id}`, 'DELETE'),
    () => toast('已归档，历史引用保留'),
  );
  const adopt = useCommand(
    () => api(`/studio/items/${preference!.id}/adopt-preference`, 'POST', { field: preferenceField }),
    () => {
      toast('已把建议追加到所选偏好，其他设置保留');
      setPreference(null);
    },
  );
  async function importResource(file?: File) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('资源文件最多 2 MB');
      await api('/studio/import', 'POST', JSON.parse(await file.text()));
      await query.refetch();
      toast('资源已导入');
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const actions: Partial<Record<StudioKind, { kind: AutomationKind; field: string }>> = {
    workflow: { kind: 'workflow', field: 'workflowId' },
    observer: { kind: 'observer_analysis', field: 'observerId' },
    comment: { kind: 'comment_reply', field: 'commentIds' },
    video_script: { kind: 'render_video', field: 'scriptId' },
    transcript: { kind: 'video_script', field: 'transcriptId' },
  };
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="YOUR REUSABLE CREATIVE LIBRARY"
        title="创作资源与运营"
        description="让预设、系列、经验和经营记录成为可重复使用的资产。"
      >
        <label className="file-button secondary">
          <Upload size={15} />
          导入资源
          <input
            type="file"
            accept=".json"
            onChange={(event) => void importResource(event.target.files?.[0])}
          />
        </label>
        <Button onClick={() => setEditing('new')}>
          <Plus size={16} />
          新建{studioNames[kind]}
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="filter-pills">
          {Object.entries(studioNames).map(([key, label]) => (
            <button
              key={key}
              className={kind === key ? 'active' : ''}
              onClick={() => {
                setParams({ kind: key });
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="compact-input"
          aria-label="搜索创作资源"
          placeholder="搜索名称或内容"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
      </div>
      <div className="studio-shortcuts">
        <Button variant="secondary" onClick={() => setTask({ kind: 'style' })}>
          <Sparkles size={15} />
          从样文提炼风格
        </Button>
        <Button variant="secondary" onClick={() => setTask({ kind: 'compare' })}>
          比较候选版本
        </Button>
        <Link className="button button-secondary" to="/discovery">
          订阅与选题
        </Link>
        <Link className="button button-secondary" to="/analytics">
          表现与复盘
        </Link>
        {kind === 'collaboration' && (
          <Button
            variant="secondary"
            onClick={() =>
              void download('/collaborations/export', 'collaborations.csv').catch((error) =>
                setError(error.message),
              )
            }
          >
            导出台账
          </Button>
        )}
      </div>
      <Alert>{error || copy.error?.message || archive.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : query.data!.items.length ? (
        <div className="resource-grid">
          {query.data!.items.map((item) => (
            <article className="panel resource-card" key={item.id}>
              {item.kind === 'visual' && (
                <div
                  className="visual-swatch"
                  style={{
                    backgroundColor: String(item.data.background),
                    color: String(item.data.foreground),
                    borderColor: String(item.data.accent),
                  }}
                >
                  <strong>创作有自己的节奏</strong>
                  <small>{String(item.data.footer || '预览你的视觉风格')}</small>
                </div>
              )}
              <div className="resource-card-heading">
                <h2>{item.name}</h2>
                <Badge>v{item.revision}</Badge>
              </div>
              <p>
                {String(
                  item.data.description ??
                    item.data.content ??
                    item.data.text ??
                    item.data.notes ??
                    item.data.template ??
                    item.data.partner ??
                    '可编辑、可复用的创作记录',
                ).slice(0, 180)}
              </p>
              {kind === 'collaboration' && (
                <p className="resource-money">
                  {String(item.data.currency)} {String(item.data.paid)} / {String(item.data.amount)} ·{' '}
                  {String(item.data.status)}
                </p>
              )}
              <small className="field-hint">
                {dateTime(item.updatedAt)} · {item.accountId ? '账号专属' : '工作空间共享'}
              </small>
              <div className="resource-actions">
                <Button variant="ghost" onClick={() => setEditing(item)}>
                  编辑
                </Button>
                {kind === 'prompt' && (
                  <Button variant="secondary" onClick={() => setUsePrompt(item)}>
                    <Play size={14} />
                    使用
                  </Button>
                )}
                {actions[kind] && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const action = actions[kind]!;
                      setTask({
                        kind: action.kind,
                        accountId: item.accountId,
                        data: { [action.field]: action.field === 'commentIds' ? [item.id] : item.id },
                      });
                    }}
                  >
                    {automationNames[actions[kind]!.kind]}
                  </Button>
                )}
                {kind === 'series' && (
                  <Button variant="secondary" onClick={() => setSeries(item)}>
                    查看创作进度
                  </Button>
                )}
                {kind === 'preference' && (
                  <Button
                    variant="secondary"
                    disabled={item.data.state === 'adopted'}
                    onClick={() => setPreference(item)}
                  >
                    写入偏好
                  </Button>
                )}
                <Button variant="ghost" aria-label={`复制 ${item.name}`} onClick={() => copy.mutate(item)}>
                  <Copy size={14} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`导出 ${item.name}`}
                  onClick={() =>
                    void download(`/studio/items/${item.id}/export`, `${item.kind}.json`).catch((error) =>
                      setError(error.message),
                    )
                  }
                >
                  <Download size={14} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`查看 ${item.name} 的版本`}
                  onClick={() => setHistory(item)}
                >
                  <History size={14} />
                </Button>
                <Button variant="ghost" aria-label={`归档 ${item.name}`} onClick={() => archive.mutate(item)}>
                  <Archive size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title={`建立你的${studioNames[kind]}`}
            description="创建后可以编辑、复制、导入导出，并保留资源版本。"
          />
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`${editing === 'new' ? '新建' : '编辑'}${studioNames[kind]}`}
        wide
      >
        {editing && catalog.data && (
          <ItemForm
            key={editing === 'new' ? kind : editing.id}
            kind={kind}
            item={editing === 'new' ? null : editing}
            schema={catalog.data[kind].schema}
            onClose={() => setEditing(null)}
          />
        )}
      </Modal>
      <Modal open={!!usePrompt} onClose={() => setUsePrompt(null)} title="使用写作预设">
        {usePrompt && <UsePrompt item={usePrompt} onClose={() => setUsePrompt(null)} />}
      </Modal>
      <Modal
        open={!!task}
        onClose={() => setTask(null)}
        title={task ? automationNames[task.kind] : '创建任务'}
        wide
      >
        {task && (
          <AutomationComposer
            kind={task.kind}
            initialData={task.data}
            accountId={task.accountId}
            onCreated={() => setTask(null)}
          />
        )}
      </Modal>
      <Modal open={!!history} onClose={() => setHistory(null)} title="资源历史版本" wide>
        {history && <ItemHistory item={history} />}
      </Modal>
      <Modal open={!!series} onClose={() => setSeries(null)} title={series?.name ?? '系列进度'} wide>
        {series && <SeriesContents item={series} />}
      </Modal>
      <Modal open={!!preference} onClose={() => setPreference(null)} title="把建议写入偏好">
        <div className="form-stack">
          <p>{String(preference?.data.content ?? '')}</p>
          <Field label="追加到哪个偏好">
            <select value={preferenceField} onChange={(event) => setPreferenceField(event.target.value)}>
              <option value="tone">表达语气</option>
              <option value="positioning">内容定位</option>
              <option value="audience">目标读者</option>
              <option value="avoid">避免表达</option>
            </select>
          </Field>
          <Alert>{adopt.error?.message}</Alert>
          <Button busy={adopt.isPending} onClick={() => adopt.mutate()}>
            确认追加建议
          </Button>
        </div>
      </Modal>
    </div>
  );
}
