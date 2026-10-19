import { useState, type FormEvent } from 'react';
import {
  Copy,
  FileText,
  Fingerprint,
  History,
  Pencil,
  Plus,
  Search,
  Settings2,
  UsersRound,
} from 'lucide-react';
import {
  emptyPreferences,
  platforms,
  type Account,
  type Persona,
  type Platform,
  type WritingContext,
} from '@one-creator/core';
import { api, dateTime, optional, text, useCommand, useGet, useList } from '../lib/api';
import { connectionStatusNames, type AccountCapabilities } from '@one-creator/core';
import { ConnectionPanel } from '../components/ConnectionPanel';
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
  PlatformBadge,
  QueryError,
  useToast,
} from '../components/ui';

function PersonaForm({ persona, onClose }: { persona: Persona | null; onClose: () => void }) {
  const toast = useToast();
  const save = useCommand(
    (data: FormData) =>
      api(persona ? `/personas/${persona.id}` : '/personas', persona ? 'PUT' : 'POST', {
        name: text(data, 'name'),
        positioning: text(data, 'positioning'),
        audience: text(data, 'audience'),
        tone: text(data, 'tone'),
        avoid: text(data, 'avoid'),
        sample: text(data, 'sample'),
        ...(persona ? { expectedRevision: persona.revision } : {}),
      }),
    () => {
      toast(persona ? '人设已保存，新修订已记录' : '人设已创建');
      onClose();
    },
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <Field label="人设名称" required>
        <input
          name="name"
          defaultValue={persona?.name}
          required
          maxLength={80}
          placeholder="例如：认真分享的技术实践者"
          autoFocus
        />
      </Field>
      <Field label="内容定位" hint="你关注什么领域，希望为读者提供什么？">
        <textarea
          name="positioning"
          defaultValue={persona?.positioning}
          maxLength={2000}
          rows={3}
          placeholder="专注 AI 工具与开发实践，分享自己验证过的方法。"
        />
      </Field>
      <div className="form-grid">
        <Field label="目标读者">
          <textarea
            name="audience"
            defaultValue={persona?.audience}
            maxLength={1000}
            rows={3}
            placeholder="独立开发者、希望提高效率的创作者"
          />
        </Field>
        <Field label="表达风格">
          <textarea
            name="tone"
            defaultValue={persona?.tone}
            maxLength={1000}
            rows={3}
            placeholder="平实、具体、少用夸张修饰"
          />
        </Field>
      </div>
      <Field label="避免的表达">
        <textarea
          name="avoid"
          defaultValue={persona?.avoid}
          maxLength={1000}
          rows={2}
          placeholder="不使用「震惊」「必看」等词语，不编造亲身经历。"
        />
      </Field>
      <details className="form-details">
        <summary>
          添加自己的样文 <span>可选</span>
        </summary>
        <Field label="参考样文" hint="可粘贴自己的文章片段，作为写作参考。">
          <textarea name="sample" defaultValue={persona?.sample} maxLength={20000} rows={6} />
        </Field>
      </details>
      <Alert>{save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存人设
        </Button>
      </div>
    </form>
  );
}
function AccountForm({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const personas = useList<Persona>('personas', { limit: 500 });
  const toast = useToast();
  const save = useCommand(
    (data: FormData) =>
      api(account ? `/accounts/${account.id}` : '/accounts', account ? 'PUT' : 'POST', {
        name: text(data, 'name'),
        platform: text(data, 'platform'),
        handle: text(data, 'handle'),
        category: text(data, 'category'),
        homepage: text(data, 'homepage'),
        personaId: optional(data, 'personaId'),
        active: data.get('active') === 'on',
        preferences: {
          positioning: text(data, 'positioning'),
          audience: text(data, 'audience'),
          tone: text(data, 'tone'),
          avoid: text(data, 'avoid'),
          sample: text(data, 'sample'),
        },
      }),
    () => {
      toast('账号档案已保存');
      onClose();
    },
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <div className="form-grid">
        <Field label="平台" required>
          <select name="platform" defaultValue={account?.platform ?? 'wechat'}>
            {Object.entries(platforms).map(([key, value]) => (
              <option key={key} value={key}>
                {value.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="账号名称" required>
          <input
            name="name"
            defaultValue={account?.name}
            required
            maxLength={80}
            autoFocus
            placeholder="例如：我的科技观察"
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="平台账号 ID" hint="可稍后填写，用来识别实际账号。">
          <input
            name="handle"
            defaultValue={account?.handle}
            maxLength={300}
            placeholder="平台中的唯一账号 ID"
          />
        </Field>
        <Field label="账号分类">
          <input
            name="category"
            defaultValue={account?.category}
            maxLength={50}
            placeholder="科技 / 生活 / 学习"
          />
        </Field>
      </div>
      <Field label="账号主页">
        <input name="homepage" type="url" defaultValue={account?.homepage} placeholder="https://…" />
      </Field>
      <Field label="绑定创作人设" hint="多账号可以共享同一人设，也可以添加专属偏好。">
        <select name="personaId" defaultValue={account?.personaId ?? ''}>
          <option value="">暂不绑定</option>
          {personas.data?.items.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>
      </Field>
      <details className="form-details">
        <summary>
          账号专属偏好 <span>留空时沿用人设</span>
        </summary>
        <div className="form-grid">
          {(['positioning', 'audience', 'tone', 'avoid'] as const).map((key) => (
            <Field
              key={key}
              label={{ positioning: '定位', audience: '读者', tone: '语气', avoid: '避免表达' }[key]}
            >
              <textarea name={key} rows={2} defaultValue={account?.preferences[key] ?? ''} maxLength={1000} />
            </Field>
          ))}
        </div>
        <Field label="账号专属样文">
          <textarea name="sample" rows={3} defaultValue={account?.preferences.sample} maxLength={20000} />
        </Field>
      </details>
      <label className="checkbox-field">
        <input type="checkbox" name="active" defaultChecked={account?.active ?? true} />
        <span>启用此账号，允许安排新的发布计划</span>
      </label>
      <Alert>{personas.error?.message || save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存账号
        </Button>
      </div>
    </form>
  );
}
const capabilityNames: Record<string, string> = {
  export: '导出发布包',
  manual_record: '回填发布结果',
  save_draft: '保存平台草稿',
  publish: '自动发布',
  schedule: '平台定时',
  fetch_metrics: '同步数据',
};
const capabilityStatus = {
  supported: { label: '可用', tone: 'green' },
  unknown: { label: '待验证', tone: 'amber' },
  unsupported: { label: '暂不支持', tone: 'neutral' },
} as const;
function CapabilityList({ accountId }: { accountId: string }) {
  const query = useGet<AccountCapabilities>(`/accounts/${accountId}/capabilities`);
  if (query.error) return <Alert>{query.error.message}</Alert>;
  return (
    <section>
      <div>
        <strong>平台能力</strong>
        <small>{query.data ? `平台连接：${connectionStatusNames[query.data.connection]}` : '读取中…'}</small>
      </div>
      {query.data && (
        <ul className="capability-list">
          {Object.entries(query.data.capabilities).map(([key, item]) => (
            <li key={key}>
              <strong>{capabilityNames[key] ?? key}</strong>
              <Badge tone={capabilityStatus[item.status].tone}>{capabilityStatus[item.status].label}</Badge>
              <small>{item.reason}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function ContextView({ account }: { account: Account }) {
  const query = useGet<WritingContext>(`/accounts/${account.id}/context`);
  if (query.isPending) return <Loading />;
  if (query.error) return <QueryError error={query.error} />;
  const context = query.data!;
  return (
    <div className="context-view">
      <div className="context-title">
        <PlatformBadge platform={account.platform} />
        <Badge>
          {context.persona ? `${context.persona.name} · v${context.persona.revision}` : '未绑定人设'}
        </Badge>
      </div>
      {(Object.keys(emptyPreferences) as (keyof typeof emptyPreferences)[]).map((key) => (
        <section key={key}>
          <div>
            <strong>
              {
                {
                  positioning: '内容定位',
                  audience: '目标读者',
                  tone: '表达风格',
                  avoid: '避免的表达',
                  sample: '参考样文',
                }[key]
              }
            </strong>
            <small>{context.preferenceSources[key]}</small>
          </div>
          <p>{context.preferences[key] || '尚未设置，创作时可以补充具体要求。'}</p>
        </section>
      ))}
      <ConnectionPanel account={account} />
      <CapabilityList accountId={account.id} />
      <div className="info-note">
        保存官方草稿、正式发布和浏览器投稿是不同操作，结果分别记录。具体入口在发布日历中。
      </div>
    </div>
  );
}
function PersonaHistory({ persona }: { persona: Persona }) {
  const query = useGet<{ id: string; revision: number; data: Persona; createdAt: string }[]>(
    `/personas/${persona.id}/revisions`,
  );
  return (
    <div className="history-list">
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : (
        query.data?.map((revision) => (
          <details key={revision.id}>
            <summary>
              <strong>第 {revision.revision} 版</strong>
              <span>{dateTime(revision.createdAt)}</span>
            </summary>
            <p>{revision.data.positioning || '未填写定位'}</p>
            <p>受众：{revision.data.audience || '未设置'}</p>
            <p>风格：{revision.data.tone || '未设置'}</p>
            <p>避免：{revision.data.avoid || '未设置'}</p>
          </details>
        ))
      )}
    </div>
  );
}
export default function Accounts() {
  const [tab, setTab] = useState<'accounts' | 'personas'>('accounts');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [platform, setPlatform] = useState('');
  const [category, setCategory] = useState('');
  const accounts = useList<Account>('accounts', { q, platform, category, offset, limit: 12 });
  const categories = useGet<string[]>('/accounts/categories');
  const personas = useList<Persona>('personas', { q, offset, limit: 12 });
  const [editingAccount, setEditingAccount] = useState<Account | 'new' | null>(null);
  const [editingPersona, setEditingPersona] = useState<Persona | 'new' | null>(null);
  const [contextAccount, setContextAccount] = useState<Account | null>(null);
  const [history, setHistory] = useState<Persona | null>(null);
  const toast = useToast();
  const copy = useCommand(
    (persona: Persona) =>
      api('/personas', 'POST', { ...persona, name: `${persona.name.slice(0, 70)} · 副本` }),
    () => toast('人设已复制，可以独立编辑'),
  );
  const query = tab === 'accounts' ? accounts : personas;
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="ACCOUNTS & VOICES"
        title="每个账号，都有自己的表达"
        description="管理你的账号矩阵，把定位与风格留在创作上下文里。"
      >
        <Button onClick={() => (tab === 'accounts' ? setEditingAccount('new') : setEditingPersona('new'))}>
          <Plus size={17} />
          {tab === 'accounts' ? '添加账号' : '创建人设'}
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="tabs" aria-label="账号与人设">
          <button
            className={tab === 'accounts' ? 'active' : ''}
            onClick={() => {
              setTab('accounts');
              setOffset(0);
            }}
          >
            <UsersRound size={16} />
            账号档案
          </button>
          <button
            className={tab === 'personas' ? 'active' : ''}
            onClick={() => {
              setTab('personas');
              setOffset(0);
            }}
          >
            <Fingerprint size={16} />
            创作人设
          </button>
        </div>
        <div className="toolbar-right">
          {tab === 'accounts' && (
            <select
              aria-label="筛选平台"
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">全部平台</option>
              {Object.entries(platforms).map(([key, item]) => (
                <option key={key} value={key}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          {tab === 'accounts' && !!categories.data?.length && (
            <select
              aria-label="筛选分类"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">全部分类</option>
              {categories.data.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索账号或人设"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setOffset(0);
              }}
              placeholder="搜索名称、分类…"
            />
          </label>
        </div>
      </div>
      <Alert>{copy.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : tab === 'accounts' ? (
        accounts.data?.items.length ? (
          <div className="account-grid">
            {accounts.data.items.map((account) => (
              <article className="account-card" key={account.id}>
                <div className="account-card-top">
                  <span className={`account-avatar avatar-${account.platform}`}>
                    {account.name.slice(0, 1)}
                  </span>
                  <Badge tone={account.active ? 'green' : 'neutral'}>
                    {account.active ? '已启用' : '已停用'}
                  </Badge>
                </div>
                <h2>{account.name}</h2>
                <div className="account-platform">
                  <PlatformBadge platform={account.platform} />
                  {account.category && <span>{account.category}</span>}
                </div>
                <div className="account-persona">
                  <Fingerprint size={15} />
                  <span>{account.personaName ?? '尚未绑定人设'}</span>
                </div>
                <div className="account-card-bottom">
                  <span>
                    <FileText size={14} />
                    {account.documentCount ?? 0} 份内容
                  </span>
                  <div>
                    <IconButton
                      label={`查看 ${account.name} 的创作上下文`}
                      onClick={() => setContextAccount(account)}
                    >
                      <Settings2 size={17} />
                    </IconButton>
                    <IconButton label={`编辑账号 ${account.name}`} onClick={() => setEditingAccount(account)}>
                      <Pencil size={17} />
                    </IconButton>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="panel">
            <Empty
              icon={UsersRound}
              title={q || platform || category ? '没有匹配的账号' : '先给你的创作一个身份'}
              description="添加公众号、小红书或头条账号。即使还没连接平台，也能开始管理内容。"
            >
              <Button onClick={() => setEditingAccount('new')}>
                <Plus size={16} />
                添加第一个账号
              </Button>
            </Empty>
          </div>
        )
      ) : personas.data?.items.length ? (
        <div className="persona-grid">
          {personas.data.items.map((persona) => (
            <article className="persona-card" key={persona.id}>
              <div className="persona-card-header">
                <span className="persona-icon">
                  <Fingerprint size={25} />
                </span>
                <Badge>v{persona.revision}</Badge>
              </div>
              <h2>{persona.name}</h2>
              <p>{persona.positioning || '补充定位，让创作更有方向。'}</p>
              <div className="persona-trait">
                <span>面向</span>
                <strong>{persona.audience || '尚未设置'}</strong>
              </div>
              <div className="persona-trait">
                <span>文风</span>
                <strong>{persona.tone || '尚未设置'}</strong>
              </div>
              <div className="card-actions">
                <Button variant="ghost" onClick={() => setEditingPersona(persona)}>
                  <Pencil size={15} />
                  编辑
                </Button>
                <IconButton
                  label={`复制人设 ${persona.name}`}
                  onClick={() => copy.mutate(persona)}
                  disabled={copy.isPending}
                >
                  <Copy size={16} />
                </IconButton>
                <IconButton label={`查看 ${persona.name} 的修订历史`} onClick={() => setHistory(persona)}>
                  <History size={17} />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={Fingerprint}
            title="让 AI 记住你的表达习惯"
            description="定义定位、读者和文风。一个人设可以绑定多个账号，也可以为账号单独覆盖。"
          >
            <Button onClick={() => setEditingPersona('new')}>
              <Plus size={16} />
              创建第一个人设
            </Button>
          </Empty>
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <Modal
        open={editingAccount !== null}
        onClose={() => setEditingAccount(null)}
        title={editingAccount === 'new' ? '添加账号' : '编辑账号'}
        description="建立创作档案，平台登录信息后续单独配置。"
      >
        {editingAccount && (
          <AccountForm
            account={editingAccount === 'new' ? null : editingAccount}
            onClose={() => setEditingAccount(null)}
          />
        )}
      </Modal>
      <Modal
        open={editingPersona !== null}
        onClose={() => setEditingPersona(null)}
        title={editingPersona === 'new' ? '创建创作人设' : '编辑创作人设'}
        description="你的定位与表达习惯，会成为 AI 写作的上下文。"
        wide
      >
        {editingPersona && (
          <PersonaForm
            persona={editingPersona === 'new' ? null : editingPersona}
            onClose={() => setEditingPersona(null)}
          />
        )}
      </Modal>
      <Modal
        open={!!contextAccount}
        onClose={() => setContextAccount(null)}
        title={contextAccount?.name ?? '创作上下文'}
        wide
      >
        {contextAccount && <ContextView account={contextAccount} />}
      </Modal>
      <Modal open={!!history} onClose={() => setHistory(null)} title="人设修订记录">
        {history && <PersonaHistory persona={history} />}
      </Modal>
    </div>
  );
}
