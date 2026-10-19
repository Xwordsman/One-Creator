import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive,
  BookOpen,
  ExternalLink,
  FileText,
  Image,
  Link2,
  Pencil,
  Plus,
  Quote,
  Search,
  Upload,
} from 'lucide-react';
import type { Account, Asset, Material } from '@one-creator/core';
import { api, dateTime, optional, tags, text, useCommand, useGet, useList } from '../lib/api';
import { runActivity } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Loading,
  Modal,
  PageHeading,
  Pagination,
  QueryError,
  useToast,
} from '../components/ui';

const kindNames = { text: '文字素材', link: '链接摘录', image: '图片素材' };
const ideaStatusNames = { inbox: '待整理', selected: '已采用', parked: '暂时搁置', archived: '已归档' };
interface References {
  documents: {
    id: string;
    title: string;
    revision: number;
    sourceId: string | null;
    accountName: string | null;
  }[];
  ideas: { id: string; title: string; status: keyof typeof ideaStatusNames }[];
}
function MaterialForm({ material, onClose }: { material: Material | null; onClose: () => void }) {
  const accounts = useList<Account>('accounts', { limit: 500 });
  const toast = useToast();
  const [kind, setKind] = useState(material?.kind ?? 'text');
  const [materialAccountId, setMaterialAccountId] = useState(material?.accountId ?? '');
  const [body, setBody] = useState(material?.body ?? '');
  const [title, setTitle] = useState(material?.title ?? '');
  const [assetId, setAssetId] = useState(material?.assetId ?? null);
  const [fileError, setFileError] = useState('');
  const [reused, setReused] = useState(false);
  const upload = useCommand(
    (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return api<Asset>(
        materialAccountId ? `/assets?accountId=${materialAccountId}` : '/assets',
        'POST',
        form,
      );
    },
    (asset) => {
      setAssetId(asset.id);
      setReused(!!asset.duplicate);
      if (!title) setTitle(asset.filename);
    },
  );
  const save = useCommand(
    (data: FormData) =>
      api(material ? `/materials/${material.id}` : '/materials', material ? 'PUT' : 'POST', {
        title,
        body,
        kind,
        assetId,
        url: text(data, 'url'),
        author: text(data, 'author'),
        sourceDate: text(data, 'sourceDate'),
        accountId: optional(data, 'accountId'),
        tags: tags(data),
        archived: material?.archived ?? false,
        ...(material ? { expectedRevision: material.revision } : {}),
      }),
    () => {
      toast('素材已保存，下次写作可以直接引用');
      onClose();
    },
  );
  async function importText(file?: File) {
    if (!file) return;
    try {
      await runActivity({ kind: 'import_text', title: file.name }, async () => {
        if (file.size > 1024 * 1024) throw new Error('文本文件最多 1 MB，请分段导入');
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          throw new Error('文件不是有效的 UTF-8 文本，请转换编码或粘贴正文');
        }
        if (content.length > 100000) throw new Error('文字素材最多 100,000 字符，请分段导入');
        setBody(content);
        if (!title) setTitle(file.name.replace(/\.(md|txt)$/i, ''));
        setFileError('');
      });
    } catch (error) {
      setFileError((error as Error).message);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="素材类型">
          <select value={kind} onChange={(event) => setKind(event.target.value as Material['kind'])}>
            {Object.entries(kindNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="素材可用范围">
          <select
            name="accountId"
            value={materialAccountId}
            onChange={(event) => setMaterialAccountId(event.target.value)}
          >
            <option value="">工作空间共享</option>
            {accounts.data?.items.map((account) => (
              <option key={account.id} value={account.id}>
                仅 {account.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="素材标题" required>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
          autoFocus
          placeholder="给这份素材起个容易找到的名字"
        />
      </Field>
      {kind === 'image' ? (
        <div className="upload-zone">
          {assetId ? <img src={`/api/assets/${assetId}`} alt="已上传素材预览" /> : <Image size={30} />}
          <label className="file-button">
            <Upload size={16} />
            {upload.isPending ? '上传中…' : '选择图片'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
              }}
            />
          </label>
          <small role="status">
            {reused
              ? '这张图片之前上传过，已复用原文件，不会重复占用空间'
              : 'PNG、JPEG、WebP · 每张最多 12 MB'}
          </small>
        </div>
      ) : (
        <div className="import-row">
          <label className="file-button secondary">
            <Upload size={15} />
            导入 Markdown / TXT
            <input
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              onChange={(event) => void importText(event.target.files?.[0])}
            />
          </label>
          <small>也可以直接粘贴正文</small>
        </div>
      )}
      <Field label={kind === 'image' ? '图片说明' : '正文或摘录'}>
        <textarea
          rows={kind === 'image' ? 3 : 8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={100000}
          placeholder="保存有用的内容、自己的理解，以及值得引用的片段。"
        />
      </Field>
      <div className="form-grid">
        <Field label="原始链接">
          <input type="url" name="url" defaultValue={material?.url} placeholder="https://…" />
        </Field>
        <Field label="作者 / 来源">
          <input
            name="author"
            maxLength={300}
            defaultValue={material?.author}
            placeholder="自己 / 来源作者"
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="来源时间" hint="原文发表或获取的日期，可不填">
          <input type="date" name="sourceDate" defaultValue={material?.sourceDate} />
        </Field>
        <Field label="标签" hint="用逗号分隔">
          <input
            name="tags"
            defaultValue={material?.tags.join(', ')}
            maxLength={500}
            placeholder="选题参考, 数据, 写作方法"
          />
        </Field>
      </div>
      <Alert>{fileError || upload.error?.message || save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button
          type="submit"
          busy={save.isPending}
          disabled={upload.isPending || (kind === 'image' && !assetId)}
        >
          保存素材
        </Button>
      </div>
    </form>
  );
}
function MaterialReferences({ material }: { material: Material }) {
  const query = useGet<References>(`/materials/${material.id}/references`);
  if (query.isPending) return <Loading />;
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const { documents, ideas } = query.data!;
  if (!documents.length && !ideas.length)
    return (
      <Empty
        icon={Quote}
        title="还没有被引用"
        description="在编辑器的「选择引用资料」中选用，或在灵感里关联这份素材。"
      />
    );
  return (
    <div className="reference-list">
      {documents.length > 0 && (
        <section>
          <h3>文稿 · {documents.length}</h3>
          <ul>
            {documents.map((document) => (
              <li key={document.id}>
                <Link to={`/contents/${document.id}`}>
                  <strong>{document.title}</strong>
                  <small>
                    {document.sourceId ? '平台版本' : '母稿'}
                    {document.accountName ? ` · ${document.accountName}` : ''} · v{document.revision}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {ideas.length > 0 && (
        <section>
          <h3>灵感 · {ideas.length}</h3>
          <ul>
            {ideas.map((idea) => (
              <li key={idea.id}>
                <div>
                  <strong>{idea.title}</strong>
                  <small>{ideaStatusNames[idea.status]}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="field-hint">文稿保存的是引用当时的素材版本，之后修改素材不会改变已有稿件。</p>
    </div>
  );
}
export default function Materials() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [scope, setScope] = useState('');
  const [offset, setOffset] = useState(0);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Material | 'new' | null>(null);
  const [references, setReferences] = useState<{ material: Material; archive: boolean } | null>(null);
  const accounts = useList<Account>('accounts', { limit: 500 });
  const query = useList<Material>('materials', {
    q,
    kind,
    offset,
    limit: 12,
    archived: String(archived),
    ...(scope === 'shared' ? { shared: 'true' } : scope ? { accountId: scope } : {}),
  });
  const toast = useToast();
  const archive = useCommand(
    (material: Material) =>
      api(`/materials/${material.id}`, 'PUT', {
        ...material,
        archived: !material.archived,
        expectedRevision: material.revision,
      }),
    () => toast(archived ? '素材已恢复' : '素材已归档，已有引用保持可追溯'),
  );
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="YOUR SOURCE OF INSPIRATION"
        title="让积累，成为创作的底气"
        description="收好文章、片段和图片。每一次引用，都能找到来处。"
      >
        <Button onClick={() => setEditing('new')}>
          <Plus size={17} />
          添加素材
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="filter-pills">
          {[['', '全部素材'], ...Object.entries(kindNames)].map(([key, label]) => (
            <button
              key={key}
              className={kind === key ? 'active' : ''}
              onClick={() => {
                setKind(key);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select
            aria-label="素材范围"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部范围</option>
            <option value="shared">仅共享素材</option>
            {accounts.data?.items.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} 可用
              </option>
            ))}
          </select>
          <IconButton
            label={archived ? '查看使用中的素材' : '查看归档素材'}
            className={archived ? 'is-active' : ''}
            onClick={() => {
              setArchived(!archived);
              setOffset(0);
            }}
          >
            <Archive size={17} />
          </IconButton>
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索素材"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setOffset(0);
              }}
              placeholder="搜索标题、内容、标签…"
            />
          </label>
        </div>
      </div>
      <Alert>{archive.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : query.data?.items.length ? (
        <div className="material-grid">
          {query.data.items.map((material) => (
            <article className="material-card" key={material.id}>
              {material.kind === 'image' && material.assetId ? (
                <div className="material-image">
                  <img src={`/api/assets/${material.assetId}`} alt={material.title} loading="lazy" />
                </div>
              ) : (
                <div className={`material-banner banner-${material.kind}`}>
                  {material.kind === 'link' ? <Link2 size={26} /> : <FileText size={26} />}
                  <span>{kindNames[material.kind]}</span>
                </div>
              )}
              <div className="material-card-body">
                <div className="material-card-meta">
                  <Badge>{material.accountId ? '账号专属' : '共享素材'}</Badge>
                  {material.archived && <Badge>已归档</Badge>}
                  <small>v{material.revision}</small>
                </div>
                <h2>{material.title}</h2>
                <p>{material.body || material.url || '一张等待用在好内容里的图片。'}</p>
                <div className="tag-list">
                  {material.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
                <div className="material-card-bottom">
                  <small>
                    {[material.author, material.sourceDate].filter(Boolean).join(' · ') ||
                      dateTime(material.updatedAt)}
                  </small>
                  <div>
                    {material.url && (
                      <a
                        className="icon-button"
                        href={material.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`查看 ${material.title} 的原始来源`}
                      >
                        <ExternalLink size={16} />
                      </a>
                    )}
                    <IconButton
                      label={`查看 ${material.title} 的引用位置`}
                      onClick={() => setReferences({ material, archive: false })}
                    >
                      <Quote size={16} />
                    </IconButton>
                    <IconButton label={`编辑素材 ${material.title}`} onClick={() => setEditing(material)}>
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      label={`${material.archived ? '恢复' : '归档'}素材 ${material.title}`}
                      disabled={archive.isPending}
                      onClick={() =>
                        material.archived
                          ? archive.mutate(material)
                          : setReferences({ material, archive: true })
                      }
                    >
                      <Archive size={16} />
                    </IconButton>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={BookOpen}
            title={q || kind || scope || archived ? '这里还没有匹配的素材' : '搭建自己的灵感资料库'}
            description="保存一篇文章、一段摘录，或一张图片。以后写作时，可以直接选用并保留来源。"
          >
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} />
              添加第一份素材
            </Button>
          </Empty>
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '添加一份素材' : '编辑素材'}
        description="素材引用会保留当时的版本，后续编辑不会改变历史稿件。"
        wide
      >
        {editing && (
          <MaterialForm material={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
        )}
      </Modal>
      <Modal
        open={!!references}
        onClose={() => setReferences(null)}
        title={references?.archive ? '归档这份素材？' : '引用位置'}
        description={references ? `「${references.material.title}」` : undefined}
      >
        {references && (
          <>
            <MaterialReferences material={references.material} />
            {references.archive && (
              <div className="form-footer">
                <span className="field-hint">
                  归档后不再出现在引用选择中，已有引用仍可追溯，随时可以恢复。
                </span>
                <Button variant="secondary" onClick={() => setReferences(null)}>
                  取消
                </Button>
                <Button
                  busy={archive.isPending}
                  onClick={() =>
                    archive.mutate(references.material, { onSuccess: () => setReferences(null) })
                  }
                >
                  确认归档
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
