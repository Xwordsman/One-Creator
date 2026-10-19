import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Lightbulb, Pencil, Plus, Search } from 'lucide-react';
import type { Account, ContentDocument, Idea, Material } from '@one-creator/core';
import { api, dateTime, tags, text, useCommand, useList } from '../lib/api';
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

const statusNames = { inbox: '待整理', selected: '已采用', parked: '暂时搁置', archived: '已归档' };
function IdeaForm({ idea, onClose }: { idea: Idea | null; onClose: () => void }) {
  const accounts = useList<Account>('accounts', { limit: 500 });
  const materials = useList<Material>('materials', { limit: 100 });
  const toast = useToast();
  const [accountId, setAccountId] = useState(idea?.accountId ?? '');
  const [materialIds, setMaterialIds] = useState(idea?.materialIds ?? []);
  const available =
    materials.data?.items.filter((material) => !material.accountId || material.accountId === accountId) ?? [];
  const save = useCommand(
    (data: FormData) =>
      api(idea ? `/ideas/${idea.id}` : '/ideas', idea ? 'PUT' : 'POST', {
        title: text(data, 'title'),
        body: text(data, 'body'),
        accountId: accountId || null,
        materialIds,
        tags: tags(data),
        status: text(data, 'status'),
      }),
    () => {
      toast('灵感已留在这里');
      onClose();
    },
  );
  function chooseAccount(value: string) {
    setAccountId(value);
    // Drop materials owned by another account; ids not in the loaded list (archived or beyond the page) are left for the server to check.
    setMaterialIds((current) =>
      current.filter((materialId) => {
        const material = materials.data?.items.find((item) => item.id === materialId);
        return !material?.accountId || material.accountId === value;
      }),
    );
  }
  function toggle(materialId: string, checked: boolean) {
    setMaterialIds((current) =>
      checked ? [...current, materialId] : current.filter((item) => item !== materialId),
    );
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <Field label="这个想法是什么" required>
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={idea?.title}
          autoFocus
          placeholder="一个问题、一个观察，或一个想讲的故事"
        />
      </Field>
      <Field label="展开说说">
        <textarea
          name="body"
          rows={5}
          maxLength={10000}
          defaultValue={idea?.body}
          placeholder="为什么想写？有什么特别的角度？先随手记下来。"
        />
      </Field>
      <div className="form-grid">
        <Field label="想发在哪个账号">
          <select value={accountId} onChange={(event) => chooseAccount(event.target.value)}>
            <option value="">暂不确定</option>
            {accounts.data?.items.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="状态">
          <select name="status" defaultValue={idea?.status ?? 'inbox'}>
            {Object.entries(statusNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="choice-group">
        <legend>
          相关素材<span>已选 {materialIds.length} / 30</span>
        </legend>
        {materials.isPending ? (
          <p className="field-hint">正在读取素材…</p>
        ) : materials.error ? (
          <p className="field-hint text-error">{materials.error.message}</p>
        ) : available.length ? (
          <div className="choice-list">
            {available.map((material) => (
              <label className="choice-item" key={material.id}>
                <input
                  type="checkbox"
                  checked={materialIds.includes(material.id)}
                  disabled={!materialIds.includes(material.id) && materialIds.length >= 30}
                  onChange={(event) => toggle(material.id, event.target.checked)}
                />
                <span>{material.title}</span>
                <small>{material.accountId ? '账号专属' : '共享'}</small>
              </label>
            ))}
          </div>
        ) : (
          <p className="field-hint">素材库里还没有可关联的资料。开始写作后，也可以在编辑器中选择引用。</p>
        )}
        <p className="field-hint">开始写作时，所选素材会成为文稿的引用资料。</p>
      </fieldset>
      <Field label="标签" hint="用逗号分隔，方便以后找到。">
        <input
          name="tags"
          maxLength={500}
          defaultValue={idea?.tags.join(', ')}
          placeholder="AI 工具, 方法分享"
        />
      </Field>
      <Alert>{save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存灵感
        </Button>
      </div>
    </form>
  );
}
export default function Ideas() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Idea | 'new' | null>(null);
  const query = useList<Idea>('ideas', { q, status, offset, limit: 12 });
  const navigate = useNavigate();
  const start = useCommand(
    (idea: Idea) =>
      api<ContentDocument>('/documents', 'POST', {
        title: idea.title,
        brief: idea.body,
        accountId: idea.accountId,
        ideaId: idea.id,
        tags: idea.tags,
        materialIds: idea.materialIds,
      }),
    (document) => navigate(`/contents/${document.id}`),
  );
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="IDEAS, BEFORE THEY FADE"
        title="留住一闪而过的灵感"
        description="先记录，再慢慢打磨。下一个好选题，可能就藏在这里。"
      >
        <Button onClick={() => setEditing('new')}>
          <Plus size={17} />
          记录灵感
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="filter-pills">
          {[['', '全部灵感'], ...Object.entries(statusNames)].map(([key, label]) => (
            <button
              key={key}
              className={status === key ? 'active' : ''}
              onClick={() => {
                setStatus(key);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search-input">
          <Search size={16} />
          <input
            value={q}
            aria-label="搜索灵感"
            onChange={(event) => {
              setQ(event.target.value);
              setOffset(0);
            }}
            placeholder="搜索想法、标签…"
          />
        </label>
      </div>
      <Alert>{start.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : query.data?.items.length ? (
        <div className="idea-grid">
          {query.data.items.map((idea, index) => (
            <article className={`idea-card idea-tint-${index % 3}`} key={idea.id}>
              <div className="idea-card-top">
                <Badge tone={idea.status === 'selected' ? 'green' : 'neutral'}>
                  {statusNames[idea.status]}
                </Badge>
                <IconButton label={`编辑灵感 ${idea.title}`} onClick={() => setEditing(idea)}>
                  <Pencil size={16} />
                </IconButton>
              </div>
              <h2>{idea.title}</h2>
              <p>{idea.body || '这个想法还有更多可以展开的地方。'}</p>
              <div className="tag-list">
                {idea.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
              <div className="idea-card-bottom">
                <small>
                  {dateTime(idea.updatedAt)}
                  {idea.materialIds.length > 0 && ` · ${idea.materialIds.length} 份素材`}
                </small>
                <Button
                  variant="ghost"
                  disabled={start.isPending}
                  onClick={() =>
                    idea.documentId ? navigate(`/contents/${idea.documentId}`) : start.mutate(idea)
                  }
                >
                  {idea.documentId ? '继续创作' : '开始写作'}
                  <ArrowUpRight size={16} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={Lightbulb}
            title={q || status ? '没有匹配的灵感' : '先记下那个想法'}
            description="一句话也好，一段观察也好。灵感不必完整，记录下来就有了开始。"
          >
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} />
              记录第一个灵感
            </Button>
          </Empty>
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '记录一个灵感' : '编辑灵感'}
      >
        {editing && <IdeaForm idea={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}
