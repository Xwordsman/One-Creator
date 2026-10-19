import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CalendarPlus,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  History,
  ImagePlus,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  Save,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react';
import {
  documentSchema,
  documentStatusNames,
  jobNames,
  platforms,
  validateDocument,
  type Account,
  type AIJob,
  type Asset,
  type ContentDocument,
  type DocumentRevision,
  type JobInput,
  type Material,
  type Provider,
} from '@one-creator/core';
import { platformRulesVersion } from '@one-creator/core';
import { renderArticle } from '@one-creator/rendering';
import {
  api,
  ApiError,
  dateTime,
  download,
  saveBlob,
  text,
  useCommand,
  useGet,
  useList,
  useReferenceOptions,
} from '../lib/api';
import { useDraft } from '../lib/useDraft';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Loading,
  Modal,
  PlatformBadge,
  QueryError,
  useToast,
} from '../components/ui';
import { CardStudio } from '../components/CardStudio';
import { ImageCropper } from '../components/ImageCropper';
import { CitationExcerpts } from '../components/CitationExcerpts';
import { ScheduleForm } from './Publishing';
import type { ReferenceOptions } from '../components/SchemaForm';
import { fontWarning } from '../lib/fonts';
import { jobStatusNames, JobWarnings } from './Jobs';

function VariantForm({ document, onClose }: { document: ContentDocument; onClose: () => void }) {
  const accounts = useList<Account>('accounts', { limit: 500 });
  const navigate = useNavigate();
  const create = useCommand(
    (data: FormData) =>
      api<ContentDocument>(`/documents/${document.id}/variants`, 'POST', {
        accountId: text(data, 'accountId'),
        expectedRevision: document.revision,
      }),
    (variant) => {
      onClose();
      navigate(`/contents/${variant.id}`);
    },
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="info-note">
        从「{document.title}」第 {document.revision} 版派生。新版本可以独立编辑，母稿会完整保留。
      </div>
      <Field label="目标账号" required>
        <select name="accountId" required autoFocus defaultValue="">
          <option value="" disabled>
            选择目标账号
          </option>
          {accounts.data?.items
            .filter((account) => account.active)
            .map((account) => (
              <option key={account.id} value={account.id}>
                {platforms[account.platform].name} · {account.name}
              </option>
            ))}
        </select>
      </Field>
      <p className="field-hint">创建后可手工调整，或点击「平台改写」使用目标账号的风格生成新稿。</p>
      <Alert>{create.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={create.isPending}>
          创建平台版本
        </Button>
      </div>
    </form>
  );
}
function MaterialsPicker({
  document,
  onChoose,
}: {
  document: ContentDocument;
  onChoose: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(document.materialIds);
  const query = useList<Material>('materials', {
    q,
    accountId: document.accountId ?? undefined,
    shared: document.accountId ? undefined : 'true',
    limit: 100,
  });
  return (
    <div className="form-stack">
      <Field label="搜索素材">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="标题、正文或标签"
          autoFocus
        />
      </Field>
      <div className="material-picker">
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <QueryError error={query.error} />
        ) : !query.data?.items.length ? (
          <Empty
            title="还没有可引用的素材"
            description="到素材库添加共享资料，或当前账号的专属资料。"
            icon={BookOpen}
          />
        ) : (
          query.data.items.map((material) => (
            <label className="picker-item" key={material.id}>
              <input
                type="checkbox"
                checked={selected.includes(material.id)}
                disabled={!selected.includes(material.id) && selected.length >= 30}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, material.id]
                      : selected.filter((id) => id !== material.id),
                  )
                }
              />
              <div>
                <strong>{material.title}</strong>
                <p>{material.body.slice(0, 110) || material.url}</p>
                <small>
                  {material.accountId ? '账号专属' : '共享素材'} · v{material.revision}
                </small>
              </div>
            </label>
          ))
        )}
      </div>
      <div className="form-footer">
        <span className="muted">已选 {selected.length} / 30 份</span>
        <Button onClick={() => onChoose(selected)}>引用所选素材</Button>
      </div>
    </div>
  );
}
function RevisionHistory({
  document,
  onRestore,
}: {
  document: ContentDocument;
  onRestore: (revision: number) => Promise<void>;
}) {
  const query = useGet<DocumentRevision[]>(`/documents/${document.id}/revisions`);
  const [selected, setSelected] = useState<DocumentRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="revision-browser">
      <div className="revision-list">
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <QueryError error={query.error} />
        ) : (
          query.data?.map((revision) => (
            <button
              className={selected?.id === revision.id ? 'selected' : ''}
              key={revision.id}
              onClick={() => setSelected(revision)}
            >
              <strong>
                第 {revision.revision} 版 <small>{revision.reason}</small>
              </strong>
              <span>{dateTime(revision.createdAt)}</span>
            </button>
          ))
        )}
      </div>
      {selected ? (
        <>
          <div className="revision-diff">
            <section>
              <h3>历史版本 v{selected.revision}</h3>
              <strong>{selected.data.title}</strong>
              <pre>{selected.data.body || '空正文'}</pre>
            </section>
            <section>
              <h3>当前编辑版本 v{document.revision}</h3>
              <strong>{document.title}</strong>
              <pre>{document.body || '空正文'}</pre>
            </section>
          </div>
          <Alert>{error}</Alert>
          <div className="form-footer">
            <span className="field-hint">恢复会新增修订，已有版本不会被删除。</span>
            <Button
              busy={busy}
              disabled={selected.revision === document.revision}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await onRestore(selected.revision);
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              恢复为新版本
            </Button>
          </div>
        </>
      ) : (
        <p className="field-hint">选择一个历史修订，与当前正文并排比较。</p>
      )}
    </div>
  );
}

function EditorBody({ initial }: { initial: ContentDocument }) {
  const {
    draft,
    change,
    accept,
    flush,
    dirty,
    saving,
    error: saveError,
    savedAt,
    blocker,
  } = useDraft(initial);
  const [tab, setTab] = useState<'body' | 'outline' | 'preview'>('body');
  const [modal, setModal] = useState<
    'materials' | 'history' | 'variant' | 'schedule' | 'cards' | 'conflict' | null
  >(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [selection, setSelection] = useState<JobInput['selection']>();
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [latest, setLatest] = useState<ContentDocument | null>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const accounts = useList<Account>('accounts', { limit: 500 });
  const provider = useGet<Provider | null>('/settings/model');
  const jobs = useList<AIJob>('jobs', { documentId: draft.id, type: 'ai', limit: 30 }, 3000);
  const variants = useList<ContentDocument>('documents', { sourceId: draft.sourceId ?? draft.id, limit: 50 });
  const references = useReferenceOptions<ReferenceOptions>();
  const account = accounts.data?.items.find((item) => item.id === draft.accountId);
  const currentJob = jobs.data?.items.find((job) => job.id === selectedJob) ?? jobs.data?.items[0];
  const hasActiveJob = jobs.data?.items.some((job) => ['queued', 'running'].includes(job.status));
  const targetPlatform = account?.platform ?? draft.context.account?.platform;
  const issues = validateDocument(draft, targetPlatform);

  async function action(fn: () => Promise<void>) {
    setActing(true);
    setError('');
    try {
      await fn();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setActing(false);
    }
  }
  async function openSaved(kind: typeof modal) {
    await action(async () => {
      await flush();
      setModal(kind);
    });
  }
  async function generate(kind: AIJob['kind'], preset = '') {
    await action(async () => {
      const document = await flush();
      const job = await api<AIJob>(
        '/jobs',
        'POST',
        {
          documentId: document.id,
          expectedRevision: document.revision,
          kind,
          instruction: [preset, instruction].filter(Boolean).join('\n').slice(0, 3000),
          ...(kind === 'rewrite' && selection ? { selection } : {}),
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      setSelectedJob(job.id);
      await client.invalidateQueries({ queryKey: ['list', 'jobs'] });
      toast('AI 任务已创建，可继续编辑，结果会保留为候选稿');
    });
  }
  async function apply(job: AIJob) {
    await action(async () => {
      const current = await flush();
      const document = await api<ContentDocument>(`/jobs/${job.id}/apply`, 'POST', {
        expectedRevision: current.revision,
      });
      accept(document);
      setTab(job.kind === 'outline' ? 'outline' : 'body');
      await client.invalidateQueries({ queryKey: ['list', 'jobs'] });
      toast('生成结果已采用并保存为新版本');
    });
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      setError('浏览器未允许复制，请选中文字后手动复制');
    }
  }
  async function copyRichText() {
    await action(async () => {
      const document = await flush();
      let body = document.body;
      for (const assetId of document.assetIds)
        if (!body.includes(`/api/assets/${assetId}`)) body += `\n\n![配图](/api/assets/${assetId})`;
      const section = window.document.createElement('div');
      section.innerHTML = renderArticle(body);
      for (const image of section.querySelectorAll('img')) {
        if (image.getAttribute('src')?.startsWith('/api/assets/')) {
          const response = await fetch(image.src);
          if (!response.ok) throw new Error('图片加载失败，请重试');
          image.src = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            void response.blob().then((blob) => reader.readAsDataURL(blob));
          });
        }
      }
      if (!window.ClipboardItem) throw new Error('此浏览器不支持富文本复制，请使用导出 HTML');
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([section.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([document.body], { type: 'text/plain' }),
        }),
      ]);
      toast('排版已复制，请在平台编辑器粘贴后检查图片与样式');
    });
  }
  async function attach(assets: Asset[]) {
    const ids = [...new Set([...draft.assetIds, ...assets.map((asset) => asset.id)])];
    if (ids.length > 30) throw new Error('稿件图片最多 30 张，请先移除不需要的附件');
    change({ assetIds: ids });
    await flush();
  }
  function captureSelection() {
    const input = bodyInput.current;
    if (!input) return;
    setSelection(
      input.selectionEnd > input.selectionStart
        ? {
            start: input.selectionStart,
            end: input.selectionEnd,
            text: input.value.slice(input.selectionStart, input.selectionEnd),
          }
        : undefined,
    );
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void flush().catch(() => {});
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [flush]);
  async function showConflict() {
    await action(async () => {
      setLatest(await api<ContentDocument>(`/documents/${draft.id}`));
      setModal('conflict');
    });
  }
  return (
    <div className="editor-page page-enter">
      <div className="editor-topline">
        <Link to="/contents" className="back-link">
          <ArrowLeft size={17} />
          内容库
        </Link>
        <span>/</span>
        <PlatformBadge platform={account?.platform} />
        <Badge>
          {draft.sourceId ? '平台版本' : '母稿'} · v{draft.revision}
        </Badge>
        <div className="save-status" role="status">
          {saving ? (
            <>
              <Loader2 className="spin" size={14} />
              保存中
            </>
          ) : saveError ? (
            <span className="text-error">保存未完成</span>
          ) : dirty ? (
            '有修改待保存'
          ) : (
            <>
              <Check size={14} />
              已保存 {new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </>
          )}
        </div>
      </div>
      <div className="editor-heading">
        <input
          className="document-title-input"
          aria-label="文章标题"
          ref={titleInput}
          value={draft.title}
          onChange={(event) => change({ title: event.target.value })}
          maxLength={200}
          readOnly={acting}
          placeholder="给这篇内容一个标题"
        />
        <div className="editor-heading-actions">
          <IconButton
            label="手动保存内容"
            disabled={saving || acting}
            onClick={() =>
              void action(async () => {
                await flush();
                toast('内容已保存');
              })
            }
          >
            <Save size={18} />
          </IconButton>
          <IconButton
            label="查看历史版本"
            onClick={() => {
              setModal('history');
              void client.invalidateQueries({ queryKey: ['get', `/documents/${draft.id}/revisions`] });
            }}
          >
            <History size={18} />
          </IconButton>
          <Button
            variant="secondary"
            busy={acting}
            onClick={() =>
              void action(async () => {
                const document = await flush();
                await download(
                  `/documents/${document.id}/export?revision=${document.revision}`,
                  `one-creator-v${document.revision}.zip`,
                );
                toast('正文、图片与清单已导出');
              })
            }
          >
            <Download size={16} />
            导出
          </Button>
          <Button
            busy={acting}
            disabled={!draft.accountId || !account?.active}
            onClick={() => void openSaved('schedule')}
          >
            <CalendarPlus size={16} />
            安排发布
          </Button>
        </div>
      </div>
      {draft.sourceId && (
        <div className="source-note">
          <GitBranch size={16} />
          <span>
            源自母稿第 {draft.sourceRevision} 版。{initial.sourceOutdated && '母稿已更新，此版本保持独立。'}
          </span>
          <Link to={`/contents/${draft.sourceId}`}>
            查看母稿
            <ExternalLink size={13} />
          </Link>
        </div>
      )}
      <Alert>{saveError?.message || error}</Alert>
      {saveError instanceof ApiError && saveError.status === 409 && (
        <Button variant="secondary" onClick={() => void showConflict()}>
          比对最新稿件并保留本地修改
        </Button>
      )}
      <div className="editor-layout">
        <section className="editor-canvas">
          <div className="editor-toolbar">
            <div className="tabs">
              <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
                <Pencil size={15} />
                正文
              </button>
              <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>
                <Layers3 size={15} />
                大纲
              </button>
              <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
                <FileText size={15} />
                排版预览
              </button>
            </div>
            <div className="editor-tools">
              <IconButton label="复制当前正文" onClick={() => void copy(draft.body)}>
                <Copy size={16} />
              </IconButton>
              <Button variant="ghost" onClick={() => void openSaved('cards')}>
                <ImagePlus size={15} />
                图文卡片
              </Button>
            </div>
          </div>
          {tab === 'body' ? (
            <textarea
              ref={bodyInput}
              className="body-editor"
              aria-label="文章正文"
              placeholder={
                '从这里写下你的第一句话。\n\n支持 Markdown，也可以从右侧让 AI 帮你搭大纲、写初稿。'
              }
              value={draft.body}
              maxLength={120000}
              readOnly={acting}
              onChange={(event) => {
                change({ body: event.target.value });
                setSelection(undefined);
              }}
              onSelect={captureSelection}
              spellCheck={false}
            />
          ) : tab === 'outline' ? (
            <textarea
              className="body-editor outline-editor"
              aria-label="文章大纲"
              value={draft.outline}
              maxLength={30000}
              readOnly={acting}
              onChange={(event) => change({ outline: event.target.value })}
              placeholder={'先搭起结构，再慢慢充实内容。\n可以自己写，也可以点击「生成大纲」。'}
            />
          ) : (
            <div className="article-preview">
              <div className="preview-toolbar">
                <span>
                  {draft.context.visual
                    ? `${draft.context.visual.name} · v${draft.context.visual.revision}`
                    : '纸上森林'}{' '}
                  · 内联样式
                  {fontWarning(draft.context.visual?.font) && (
                    <small className="text-warning"> · {fontWarning(draft.context.visual?.font)}</small>
                  )}
                </span>
                <Button variant="secondary" onClick={() => void copyRichText()} busy={acting}>
                  <Copy size={15} />
                  复制排版
                </Button>
              </div>
              <article>
                <h1>{draft.title}</h1>
                <div dangerouslySetInnerHTML={{ __html: renderArticle(draft.body, draft.context.visual) }} />
                {draft.assetIds
                  .filter((assetId) => !draft.body.includes(`/api/assets/${assetId}`))
                  .map((assetId, index) => (
                    <img key={assetId} src={`/api/assets/${assetId}`} alt={`正文配图 ${index + 1}`} />
                  ))}
              </article>
            </div>
          )}
          <div className="editor-bottom">
            <span>{[...draft.body].length.toLocaleString('zh-CN')} 字符 · Markdown</span>
            <span>{selection ? `已选中 ${[...selection.text].length} 字符` : 'Ctrl / ⌘ + S 保存'}</span>
          </div>
          {draft.assetIds.length > 0 && (
            <div className="editor-attachments">
              <div className="section-heading">
                <h3>
                  图片附件 <span>{draft.assetIds.length}</span>
                </h3>
                <small>按此顺序写入发布包</small>
              </div>
              <div className="attachment-grid">
                {draft.assetIds.map((assetId, index) => (
                  <div className="attachment-item" key={assetId}>
                    <img src={`/api/assets/${assetId}`} alt={`附件 ${index + 1}`} loading="lazy" />
                    {draft.coverAssetId === assetId && <span className="cover-label">封面</span>}
                    <div>
                      <IconButton label={`裁剪附件 ${index + 1} 为封面`} onClick={() => setCropId(assetId)}>
                        <Scissors size={14} />
                      </IconButton>
                      <IconButton
                        label={`将图片 ${index + 1} 上移`}
                        disabled={index === 0}
                        onClick={() => {
                          const ids = [...draft.assetIds];
                          [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                          change({ assetIds: ids });
                        }}
                      >
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        label={`将图片 ${index + 1} 下移`}
                        disabled={index === draft.assetIds.length - 1}
                        onClick={() => {
                          const ids = [...draft.assetIds];
                          [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
                          change({ assetIds: ids });
                        }}
                      >
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton
                        label={`移除图片 ${index + 1}`}
                        onClick={() =>
                          change({
                            assetIds: draft.assetIds.filter((item) => item !== assetId),
                            coverAssetId: draft.coverAssetId === assetId ? null : draft.coverAssetId,
                          })
                        }
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
        <aside className="editor-sidebar">
          <section className="editor-side-section">
            <h2>
              <SettingsIcon />
              创作设定
            </h2>
            <Field label="目标账号">
              <select
                value={draft.accountId ?? ''}
                disabled={acting}
                onChange={(event) => change({ accountId: event.target.value || null })}
              >
                <option value="" disabled={!!draft.sourceId}>
                  通用母稿
                </option>
                {accounts.data?.items.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                    {!item.active ? '（停用）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="视觉模板" hint="用于公众号排版预览、复制与发布；可在创作资源中维护。">
              <select
                value={draft.visualTemplateId ?? ''}
                disabled={acting}
                onChange={(event) => change({ visualTemplateId: event.target.value || null })}
              >
                <option value="">默认 · 纸上森林</option>
                {references.data?.items
                  ?.filter(
                    (item) =>
                      item.kind === 'visual' && (!item.accountId || item.accountId === draft.accountId),
                  )
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.label} · v{item.revision}
                    </option>
                  ))}
              </select>
            </Field>
            {(targetPlatform === 'bilibili' || draft.videoAssetId) && (
              <Field label="视频文件" hint="视频投稿必需；可在「媒体与视频」上传或生成。">
                <select
                  value={draft.videoAssetId ?? ''}
                  disabled={acting}
                  onChange={(event) => change({ videoAssetId: event.target.value || null })}
                >
                  <option value="">未选择</option>
                  {references.data?.assets
                    ?.filter((item) => item.mime?.startsWith('video/'))
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.label}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="创作要求">
              <textarea
                value={draft.brief}
                onChange={(event) => change({ brief: event.target.value })}
                maxLength={10000}
                rows={3}
                placeholder="写给谁？想表达什么？"
                readOnly={acting}
              />
            </Field>
            <Field label="内容状态">
              <select
                value={draft.status}
                onChange={(event) => change({ status: event.target.value as ContentDocument['status'] })}
              >
                {Object.entries(documentStatusNames).map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <details className="editor-details">
              <summary>实际使用的账号上下文</summary>
              <p>
                {draft.context.persona
                  ? `${draft.context.persona.name} · v${draft.context.persona.revision}`
                  : '未绑定人设'}
              </p>
              <dl>
                <dt>定位</dt>
                <dd>{draft.context.preferences.positioning || '未设置'}</dd>
                <dt>读者</dt>
                <dd>{draft.context.preferences.audience || '未设置'}</dd>
                <dt>语气</dt>
                <dd>{draft.context.preferences.tone || '未设置'}</dd>
              </dl>
              <small>保存稿件时更新，历史修订保留当时的上下文。</small>
            </details>
          </section>
          <section className="editor-side-section">
            <h2>
              <BookOpen size={17} />
              参考素材 <span>{draft.materialIds.length}</span>
            </h2>
            {draft.context.citations.map((citation) => (
              <details className="citation-item" key={citation.id}>
                <summary>
                  {citation.title}
                  <small>v{citation.revision}</small>
                </summary>
                <CitationExcerpts
                  citation={citation}
                  excerpts={draft.excerpts ?? []}
                  onChange={(excerpts) => change({ excerpts })}
                />
                {citation.url && (
                  <a href={citation.url} target="_blank" rel="noreferrer">
                    查看原始来源
                    <ExternalLink size={12} />
                  </a>
                )}
              </details>
            ))}
            <Button variant="secondary" className="button-full" onClick={() => setModal('materials')}>
              <Plus size={15} />
              选择引用资料
            </Button>
            <label className="file-button secondary button-full">
              <ImagePlus size={15} />
              添加图片附件
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={acting || draft.assetIds.length >= 30}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void action(async () => {
                    const form = new FormData();
                    form.set('file', file);
                    const asset = await api<Asset>(`/assets?documentId=${draft.id}`, 'POST', form);
                    await attach([asset]);
                    toast(asset.duplicate ? '这张图片之前上传过，已复用原文件' : '图片已添加');
                  });
                  event.target.value = '';
                }}
              />
            </label>
          </section>
          <section className="editor-side-section ai-section">
            <h2>
              <Sparkles size={17} />
              AI 创作助手
            </h2>
            {!provider.data ? (
              <div className="ai-config-note">
                <p>连接自己的文本模型，让 AI 帮你一起写。</p>
                <Link to="/settings">
                  配置模型
                  <ExternalLink size={13} />
                </Link>
              </div>
            ) : (
              <>
                <small className="model-label">
                  <span className="tiny-dot" />
                  {provider.data.model}
                </small>
                <Field label="补充要求">
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    rows={2}
                    maxLength={3000}
                    placeholder="例如：更简洁一些，保留具体例子"
                  />
                </Field>
                <div className="ai-actions">
                  {(
                    [
                      'outline',
                      'draft',
                      'titles',
                      'opening',
                      ...(draft.sourceId ? ['adapt'] : []),
                      'rewrite',
                    ] as AIJob['kind'][]
                  ).map((kind) => (
                    <Button
                      key={kind}
                      variant="secondary"
                      busy={acting}
                      disabled={hasActiveJob}
                      onClick={() => void generate(kind)}
                    >
                      <Sparkles size={14} />
                      {kind === 'rewrite' && selection ? '改写选中段落' : jobNames[kind]}
                    </Button>
                  ))}
                  {selection && (
                    <>
                      <Button
                        variant="secondary"
                        busy={acting}
                        disabled={hasActiveJob}
                        onClick={() =>
                          void generate('rewrite', '扩写选中段落：补充细节与例子，保持原意和事实。')
                        }
                      >
                        <Sparkles size={14} />
                        扩写选中段落
                      </Button>
                      <Button
                        variant="secondary"
                        busy={acting}
                        disabled={hasActiveJob}
                        onClick={() =>
                          void generate('rewrite', '缩写选中段落：保留关键信息，压缩到约一半篇幅。')
                        }
                      >
                        <Sparkles size={14} />
                        缩写选中段落
                      </Button>
                    </>
                  )}
                </div>
                {hasActiveJob && (
                  <p className="working-note">
                    <Loader2 className="spin" size={14} />
                    后台生成中，可以继续编辑…
                  </p>
                )}
              </>
            )}
            <Alert>{provider.error?.message || jobs.error?.message}</Alert>
            {currentJob && (
              <div className="ai-result">
                <div>
                  <strong>{jobNames[currentJob.kind]}</strong>
                  <Badge
                    tone={
                      currentJob.status === 'succeeded'
                        ? 'green'
                        : currentJob.status === 'failed'
                          ? 'red'
                          : 'neutral'
                    }
                  >
                    {currentJob.appliedRevision ? '已采用' : jobStatusNames[currentJob.status]}
                  </Badge>
                </div>
                {jobs.data!.items.length > 1 && (
                  <select
                    aria-label="选择生成记录"
                    value={currentJob.id}
                    onChange={(event) => setSelectedJob(event.target.value)}
                  >
                    {jobs.data!.items.map((job) => (
                      <option key={job.id} value={job.id}>
                        {jobNames[job.kind]} · {dateTime(job.createdAt)}
                      </option>
                    ))}
                  </select>
                )}
                {currentJob.error && <Alert>{currentJob.error}</Alert>}
                {currentJob.output && (
                  <>
                    <JobWarnings warnings={currentJob.warnings} />
                    <pre>{currentJob.output}</pre>
                    <div className="ai-result-actions">
                      <Button variant="ghost" onClick={() => void copy(currentJob.output)}>
                        <Copy size={14} />
                        复制
                      </Button>
                      {['titles', 'opening'].includes(currentJob.kind) ? (
                        <span className="candidate-hint">候选结果，复制合适的一项到稿件</span>
                      ) : (
                        !currentJob.appliedRevision && (
                          <Button
                            busy={acting}
                            disabled={currentJob.input.document.revision !== draft.revision || dirty}
                            onClick={() => void apply(currentJob)}
                          >
                            采用结果
                          </Button>
                        )
                      )}
                    </div>
                    {!['titles', 'opening'].includes(currentJob.kind) &&
                      currentJob.input.document.revision !== draft.revision &&
                      !currentJob.appliedRevision && (
                        <small>正文已有新修订。结果保留为参考，可复制所需部分。</small>
                      )}
                  </>
                )}
              </div>
            )}
          </section>
          <section className="editor-side-section">
            <h2>
              <GitBranch size={17} />
              平台版本
            </h2>
            {draft.sourceId ? (
              <Link className="text-link" to={`/contents/${draft.sourceId}`}>
                返回母稿，创建其他版本
              </Link>
            ) : (
              <Button
                variant="secondary"
                className="button-full"
                onClick={() => void openSaved('variant')}
                disabled={acting}
              >
                <Plus size={15} />
                创建平台版本
              </Button>
            )}
            {variants.data?.items.map((variant) => (
              <Link className="variant-link" to={`/contents/${variant.id}`} key={variant.id}>
                <PlatformBadge compact platform={variant.platform} />
                <span>{variant.accountName}</span>
                {variant.id === draft.id && <Check size={14} />}
              </Link>
            ))}
          </section>
          <section className="editor-side-section">
            <h2>
              <Check size={17} />
              发布准备
            </h2>
            {issues.length ? (
              <ul className="validation-list">
                {issues.map((issue) => (
                  <li key={`${issue.field}-${issue.message}`}>
                    <strong>{issue.message}</strong>
                    <small>{issue.source}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">标题与正文已填写，可安排手动发布。</p>
            )}
            <small className="rules-version">
              {!targetPlatform
                ? '选择目标账号后，会按平台规则检查'
                : targetPlatform === 'toutiao'
                  ? `头条规则来自创作者经验，核对于 ${platformRulesVersion}`
                  : `平台规则核对于 ${platformRulesVersion}`}
            </small>
          </section>
        </aside>
      </div>
      <Modal
        open={modal === 'materials'}
        onClose={() => setModal(null)}
        title="选择参考素材"
        description="仅显示共享资料和当前账号资料，保存后记录引用快照。"
        wide
      >
        {modal === 'materials' && (
          <MaterialsPicker
            document={draft}
            onChoose={(ids) => {
              change({
                materialIds: ids,
                excerpts: (draft.excerpts ?? []).filter((excerpt) => ids.includes(excerpt.materialId)),
              });
              setModal(null);
            }}
          />
        )}
      </Modal>
      <Modal open={modal === 'history'} onClose={() => setModal(null)} title="内容版本与恢复" wide>
        {modal === 'history' && (
          <RevisionHistory
            document={draft}
            onRestore={async (revision) => {
              const current = await flush();
              const restored = await api<ContentDocument>(`/documents/${draft.id}/restore`, 'POST', {
                revision,
                expectedRevision: current.revision,
              });
              accept(restored);
              setModal(null);
              toast('历史内容已恢复为新版本');
            }}
          />
        )}
      </Modal>
      <Modal open={modal === 'variant'} onClose={() => setModal(null)} title="一份母稿，多种表达">
        {modal === 'variant' && <VariantForm document={draft} onClose={() => setModal(null)} />}
      </Modal>
      <Modal open={modal === 'schedule'} onClose={() => setModal(null)} title="安排发布">
        {modal === 'schedule' && <ScheduleForm document={draft} onClose={() => setModal(null)} />}
      </Modal>
      <Modal
        open={modal === 'cards'}
        onClose={() => setModal(null)}
        title="图文卡片工作室"
        description="按实际文字宽度分页，预览与导出使用相同尺寸。"
        wide
      >
        {modal === 'cards' && (
          <CardStudio
            documentId={draft.id}
            title={draft.title}
            body={draft.body}
            onAttach={attach}
            visual={draft.context.visual}
          />
        )}
      </Modal>
      <Modal open={!!cropId} onClose={() => setCropId(null)} title="裁剪封面" wide>
        {cropId && (
          <ImageCropper
            documentId={draft.id}
            assetId={cropId}
            defaultRatio={draft.context.visual?.ratio}
            onSave={async (asset) => {
              if (!draft.assetIds.includes(asset.id) && draft.assetIds.length >= 30)
                throw new Error('附件已达到 30 张，请先移除一张图片');
              change({ coverAssetId: asset.id, assetIds: [...new Set([...draft.assetIds, asset.id])] });
              await flush();
              setCropId(null);
              toast('封面已保存，原图保持不变');
            }}
          />
        )}
      </Modal>
      <Modal open={modal === 'conflict'} onClose={() => setModal(null)} title="比较本地修改与最新版本" wide>
        <div className="revision-diff">
          <section>
            <h3>本地修改</h3>
            <pre>{draft.body}</pre>
          </section>
          <section>
            <h3>服务端最新 v{latest?.revision}</h3>
            <pre>{latest?.body}</pre>
          </section>
        </div>
        <div className="form-footer">
          <Button
            variant="secondary"
            onClick={() => saveBlob(new Blob([draft.body], { type: 'text/markdown' }), 'local-draft.md')}
          >
            下载本地稿
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (latest) {
                accept(latest);
                setModal(null);
              }
            }}
          >
            使用最新版本
          </Button>
          <Button
            busy={acting}
            onClick={() =>
              void action(async () => {
                const copy = await api<ContentDocument>('/documents', 'POST', {
                  ...documentSchema.parse(draft),
                  title: `${draft.title.slice(0, 180)} · 本地副本`,
                });
                accept(latest ?? initial);
                setModal(null);
                navigate(`/contents/${copy.id}`);
              })
            }
          >
            保留为新母稿
          </Button>
        </div>
      </Modal>
      <Modal
        open={blocker.state === 'blocked'}
        onClose={() => blocker.state === 'blocked' && blocker.reset()}
        title="还有修改没有保存"
      >
        <p className="section-description">当前页面保留着未保存的修改。</p>
        <Alert>{saveError?.message}</Alert>
        <div className="form-footer">
          <Button variant="secondary" onClick={() => blocker.state === 'blocked' && blocker.reset()}>
            继续编辑
          </Button>
          <Button variant="ghost" onClick={() => blocker.state === 'blocked' && blocker.proceed()}>
            放弃修改并离开
          </Button>
          <Button
            busy={saving}
            onClick={() =>
              void action(async () => {
                await flush();
                if (blocker.state === 'blocked') blocker.proceed();
              })
            }
          >
            保存后离开
          </Button>
        </div>
      </Modal>
    </div>
  );
}
function SettingsIcon() {
  return <Pencil size={17} />;
}
export default function Editor() {
  const { id } = useParams();
  const query = useGet<ContentDocument>(`/documents/${id}`, !!id);
  if (query.isPending) return <Loading label="正在打开稿件…" />;
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  return <EditorBody key={query.data!.id} initial={query.data!} />;
}
