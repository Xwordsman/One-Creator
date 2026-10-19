import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, FileText, GitBranch, Plus, Search } from 'lucide-react';
import { documentStatusNames, type Account, type ContentDocument } from '@one-creator/core';
import { api, dateTime, optional, text, useCommand, useList } from '../lib/api';
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
  PlatformBadge,
  QueryError,
} from '../components/ui';

function NewDocumentForm({ onClose }: { onClose: () => void }) {
  const accounts = useList<Account>('accounts', { limit: 500 });
  const navigate = useNavigate();
  const save = useCommand(
    (data: FormData) =>
      api<ContentDocument>('/documents', 'POST', {
        title: text(data, 'title'),
        accountId: optional(data, 'accountId'),
        brief: text(data, 'brief'),
      }),
    (document) => {
      onClose();
      navigate(`/contents/${document.id}`);
    },
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <Field label="内容标题" required hint="可以先用一个工作标题，写作时再打磨。">
        <input name="title" required maxLength={200} autoFocus placeholder="今天想写点什么？" />
      </Field>
      <Field label="目标账号">
        <select name="accountId">
          <option value="">先写通用母稿，稍后选择账号</option>
          {accounts.data?.items
            .filter((account) => account.active)
            .map((account) => (
              <option value={account.id} key={account.id}>
                {account.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="创作要求" hint="写给谁、想表达什么、希望是什么样的内容？">
        <textarea
          name="brief"
          rows={5}
          maxLength={10000}
          placeholder="例如：为刚接触 AI 的创作者介绍三个实用方法，以自己的经验为主，避免空泛的建议。"
        />
      </Field>
      <Alert>{save.error?.message || accounts.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          创建并开始写作
          <ArrowUpRight size={16} />
        </Button>
      </div>
    </form>
  );
}
export function NewDocument({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="开始一篇新创作"
      description="从母稿开始，再按不同账号和平台改写。"
    >
      {open && <NewDocumentForm onClose={onClose} />}
    </Modal>
  );
}
export default function Contents() {
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const accountId = params.get('accountId') ?? '';
  const query = useList<ContentDocument>('documents', { q, status, accountId, offset, limit: 12 });
  const accounts = useList<Account>('accounts', { limit: 500 });
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setOffset(0);
  }
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="FROM THOUGHTS TO STORIES"
        title="你的内容，在这里生长"
        description="母稿、平台版本与修订记录，都有自己的位置。"
      >
        <Button onClick={() => setCreating(true)}>
          <Plus size={17} />
          新建内容
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="filter-pills">
          {[['', '全部内容'], ...Object.entries(documentStatusNames)].map(([key, label]) => (
            <button
              key={key}
              className={status === key ? 'active' : ''}
              onClick={() => filter('status', key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select
            value={accountId}
            aria-label="筛选账号"
            onChange={(event) => filter('accountId', event.target.value)}
          >
            <option value="">全部账号</option>
            {accounts.data?.items.map((account) => (
              <option value={account.id} key={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          <label className="search-input">
            <Search size={16} />
            <input
              value={q}
              aria-label="搜索内容库"
              onChange={(event) => filter('q', event.target.value)}
              placeholder="搜索标题、正文…"
            />
          </label>
        </div>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : query.data?.items.length ? (
        <div className="content-grid">
          {query.data.items.map((document) => (
            <Link to={`/contents/${document.id}`} className="content-card" key={document.id}>
              <div className="content-card-header">
                <span className="content-type-icon">
                  {document.sourceId ? <GitBranch size={21} /> : <FileText size={21} />}
                </span>
                <Badge tone={document.status === 'ready' ? 'green' : 'neutral'}>
                  {documentStatusNames[document.status]}
                </Badge>
              </div>
              <h2>{document.title}</h2>
              <p>
                {document.body.replace(/[#*`>]/g, '').slice(0, 140) ||
                  document.brief ||
                  '这篇内容还在等你的第一句话。'}
              </p>
              <div className="content-card-account">
                <PlatformBadge platform={document.platform} compact />
                <span>{document.accountName ?? '通用母稿'}</span>
              </div>
              {document.sourceOutdated && (
                <small className="outdated-note">母稿已更新，此版本仍保留原有内容</small>
              )}
              <div className="content-card-footer">
                <span>
                  {dateTime(document.updatedAt)}
                  <i />v{document.revision}
                </span>
                <ArrowUpRight size={18} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={FileText}
            title={q || status || accountId ? '没有找到匹配的内容' : '给你的第一篇作品留个位置'}
            description="可以自己写，也可以让 AI 帮你搭大纲、写初稿，再按账号风格打磨。"
          >
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} />
              开始第一篇创作
            </Button>
          </Empty>
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <NewDocument open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
