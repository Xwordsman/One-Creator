import { useState } from 'react';
import { useOutletContext, Link, useSearchParams } from 'react-router-dom';
import { Copy, KeyRound, Plus, UsersRound, Webhook, Download, Server } from 'lucide-react';
import type { SessionUser } from '@one-creator/core';
import { api, dateTime, useGet, useCommand, saveBlob, useReferenceOptions } from '../lib/api';
import {
  SchemaFields,
  schemaDefault,
  type SchemaNode,
  type ReferenceOptions,
} from '../components/SchemaForm';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  PageHeading,
  QueryError,
  useToast,
} from '../components/ui';

type Tab = 'members' | 'tokens' | 'webhooks' | 'nodes';
type Row = Record<string, unknown>;
const grants: SchemaNode = {
  anyOf: [{ type: 'array', items: { type: 'string', format: 'uuid' } }, { type: 'null' }],
  default: null,
};
const memberSchema: SchemaNode = {
  type: 'object',
  properties: {
    username: { type: 'string', maxLength: 40 },
    password: { type: 'string', maxLength: 200 },
    name: { type: 'string', maxLength: 80 },
    role: { type: 'string', enum: ['editor', 'viewer', 'admin'], default: 'editor' },
    active: { type: 'boolean', default: true },
    accountIds: grants,
  },
  required: ['username', 'password', 'name', 'role'],
};
const tokenSchema: SchemaNode = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    scopes: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['content:read', 'content:write', 'ai:run', 'publish:write', 'settings:admin'],
      },
      default: ['content:read'],
    },
    days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
    accountIds: grants,
  },
  required: ['name'],
};
const webhookSchema: SchemaNode = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 120 },
    url: { type: 'string', format: 'uri' },
    events: {
      type: 'array',
      items: { type: 'string', enum: ['content.*', 'task.*', 'publication.*', 'account.*'] },
      default: ['task.*'],
    },
    enabled: { type: 'boolean', default: true },
  },
  required: ['name', 'url'],
};
const nodeSchema: SchemaNode = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    accountIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, default: [] },
    platforms: {
      type: 'array',
      items: { type: 'string', enum: ['xiaohongshu', 'toutiao', 'zhihu', 'baijiahao', 'bilibili'] },
      default: ['xiaohongshu'],
    },
    active: { type: 'boolean', default: true },
  },
  required: ['name'],
};
const tabs: [Tab, string, typeof UsersRound][] = [
  ['members', '成员与权限', UsersRound],
  ['tokens', 'API 令牌', KeyRound],
  ['webhooks', 'Webhook', Webhook],
  ['nodes', '执行节点', Server],
];
const createLabels: Record<Tab, string> = {
  members: '添加成员',
  tokens: '创建令牌',
  webhooks: '添加 Webhook',
  nodes: '注册节点',
};
const online = (row: Row) =>
  !!row.active && typeof row.lastSeenAt === 'string' && Date.parse(row.lastSeenAt) > Date.now() - 60000;
function Form({
  schema,
  initial,
  onSave,
  pending,
  error,
  options,
}: {
  schema: SchemaNode;
  initial?: Row;
  onSave: (data: Row) => void;
  pending: boolean;
  error?: string;
  options: ReferenceOptions;
}) {
  const [value, setValue] = useState(initial ?? (schemaDefault(schema) as Row));
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <SchemaFields schema={schema} value={value} onChange={setValue} options={options} />
      <Alert>{error}</Alert>
      <div className="form-footer">
        <Button type="submit" busy={pending}>
          保存配置
        </Button>
      </div>
    </form>
  );
}
function Summary({ tab, row }: { tab: Tab; row: Row }) {
  if (tab === 'members')
    return (
      <>
        {({ admin: '管理员', editor: '编辑', viewer: '只读' } as Record<string, string>)[String(row.role)]}
        <small>
          {row.accountIds === null ? '全部账号' : `${(row.accountIds as string[]).length} 个指定账号`}
        </small>
      </>
    );
  if (tab === 'tokens')
    return (
      <>
        {(row.scopes as string[]).join(' · ')}
        <small>到期：{dateTime(String(row.expiresAt))}</small>
      </>
    );
  if (tab === 'webhooks')
    return (
      <>
        {String(row.url)}
        <small>{(row.events as string[]).join(' · ')}</small>
      </>
    );
  return (
    <>
      {(row.accountIds as string[]).length} 个账号 · {(row.platforms as string[]).join(' · ')}
      <small>
        {row.lastSeenAt ? `最近在线：${dateTime(String(row.lastSeenAt))}` : '尚未连接'}
        {row.agentVersion ? ` · 执行器 ${String(row.agentVersion)}` : ''}
      </small>
    </>
  );
}
function status(tab: Tab, row: Row): [string, 'green' | 'neutral' | 'amber'] {
  if (tab === 'members') return row.active ? ['启用', 'green'] : ['已停用', 'neutral'];
  if (tab === 'tokens') return row.revokedAt ? ['已撤销', 'neutral'] : ['有效', 'green'];
  if (tab === 'webhooks') return row.enabled ? ['启用', 'green'] : ['停用', 'neutral'];
  return !row.active ? ['已撤销', 'neutral'] : online(row) ? ['在线', 'green'] : ['离线', 'amber'];
}
export default function Workspace() {
  const { user } = useOutletContext<{ user: SessionUser }>();
  const [params, setParams] = useSearchParams();
  const tab = (tabs.some(([key]) => key === params.get('tab')) ? params.get('tab') : 'members') as Tab;
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const query = useGet<{ items: Row[] }>(`/${tab}`, user.role === 'admin');
  const options = useReferenceOptions<ReferenceOptions>();
  const deliveries = useGet<{ items: Row[] }>(`/webhooks/${deliveryId}/deliveries`, !!deliveryId);
  const toast = useToast();
  const save = useCommand(
    (data: Row) =>
      api<Row>(
        `/${tab}${editing && editing !== 'new' ? `/${editing.id}` : ''}`,
        editing === 'new' ? 'POST' : 'PUT',
        data,
      ),
    (result) => {
      setEditing(null);
      toast('配置已保存');
      if (result.token)
        setSecret({ label: tab === 'nodes' ? '执行节点令牌' : 'API 访问令牌', value: String(result.token) });
      if (result.secret) setSecret({ label: 'Webhook 签名密钥', value: String(result.secret) });
    },
  );
  const revoke = useCommand(
    (row: Row) => api(`/${tab}/${row.id}`, 'DELETE'),
    () => toast(tab === 'nodes' ? '节点已撤销，令牌立即失效' : '令牌已撤销'),
  );
  const rotate = useCommand(
    (row: Row) => api<{ token: string }>(`/nodes/${row.id}/rotate-token`, 'POST', {}),
    (result) => setSecret({ label: '新的执行节点令牌', value: result.token }),
  );
  const schema =
    tab === 'members'
      ? editing && editing !== 'new'
        ? {
            ...memberSchema,
            properties: Object.fromEntries(
              Object.entries(memberSchema.properties!).filter(
                ([key]) => !['username', 'password'].includes(key),
              ),
            ),
            required: ['name', 'role'],
          }
        : memberSchema
      : tab === 'tokens'
        ? tokenSchema
        : tab === 'webhooks'
          ? webhookSchema
          : nodeSchema;
  if (user.role !== 'admin') return <QueryError error={new Error('工作空间管理需要管理员权限')} />;
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="YOUR WORKSPACE, YOUR RULES"
        title="成员、接口与集成"
        description="为协作者分配范围，为外部工具和执行节点发放可撤销的凭据。"
      >
        <Button onClick={() => setEditing('new')}>
          <Plus size={16} />
          {createLabels[tab]}
        </Button>
      </PageHeading>
      <div className="toolbar">
        <div className="tabs">
          {tabs.map(([key, label, Icon]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setParams({ tab: key })}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <Link className="text-link" to="/usage">
          查看模型用量与费用
        </Link>
      </div>
      {tab === 'tokens' && (
        <div className="info-note inline-note">
          接口前缀 <code>/api/v1</code>，MCP 地址 <code>/api/mcp</code>。使用 Bearer 令牌；创建任务需传
          Idempotency-Key。
          <a href="/api/openapi.json" target="_blank" rel="noreferrer">
            打开 OpenAPI 文档
          </a>
        </div>
      )}
      {tab === 'nodes' && (
        <div className="info-note">
          <p>
            执行节点在你自己的电脑或服务器上运行浏览器，保存加密的平台登录会话。每个节点只能执行授权给它的账号与平台，令牌只在注册或轮换时显示一次。
          </p>
          <p>
            启动：设置 <code>EXECUTOR_SERVER</code>（本实例地址）和 <code>EXECUTOR_TOKEN</code>，运行{' '}
            <code>npm run executor</code>，或使用 Compose 的<code> executor</code>{' '}
            配置。节点离线时任务排队；提交中掉线会进入待核对。
          </p>
        </div>
      )}
      <Alert>{revoke.error?.message || rotate.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : query.data?.items.length ? (
        <div className="panel data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>
                  {
                    {
                      members: '角色与账号范围',
                      tokens: '权限与有效期',
                      webhooks: '地址与事件',
                      nodes: '授权范围与在线状态',
                    }[tab]
                  }
                </th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((row) => {
                const [label, tone] = status(tab, row);
                return (
                  <tr key={String(row.id)}>
                    <td>
                      <strong>{String(row.name)}</strong>
                      <small>{String(row.username ?? row.prefix ?? '')}</small>
                    </td>
                    <td>
                      <Summary tab={tab} row={row} />
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td>
                      <div className="table-actions">
                        {tab !== 'tokens' && (
                          <Button
                            variant="ghost"
                            disabled={tab === 'nodes' && !row.active}
                            onClick={() => setEditing(row)}
                          >
                            编辑
                          </Button>
                        )}
                        {tab === 'webhooks' && (
                          <Button variant="ghost" onClick={() => setDeliveryId(String(row.id))}>
                            投递记录
                          </Button>
                        )}
                        {tab === 'nodes' && (
                          <Button
                            variant="ghost"
                            disabled={!row.active || rotate.isPending}
                            onClick={() => rotate.mutate(row)}
                          >
                            轮换令牌
                          </Button>
                        )}
                        {(tab === 'tokens' || tab === 'nodes') && (
                          <Button
                            variant="ghost"
                            disabled={(tab === 'tokens' ? !!row.revokedAt : !row.active) || revoke.isPending}
                            onClick={() => revoke.mutate(row)}
                          >
                            撤销
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="还没有记录" description="从右上角创建配置，访问范围由服务端校验。" />
        </div>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={
          { members: '成员与权限', tokens: '创建访问令牌', webhooks: 'Webhook 订阅', nodes: '执行节点' }[tab]
        }
        wide
      >
        {editing && (
          <Form
            key={`${tab}-${editing === 'new' ? 'new' : editing.id}`}
            schema={schema}
            initial={editing === 'new' ? undefined : editing}
            onSave={(data) => save.mutate(data)}
            pending={save.isPending}
            error={save.error?.message}
            options={options.data ?? {}}
          />
        )}
      </Modal>
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title={secret?.label ?? '凭据'}
        description="此值只显示一次，请保存在自己的集成或节点配置中。"
      >
        <div className="form-stack">
          <textarea readOnly rows={3} aria-label="新生成的凭据" value={secret?.value ?? ''} />
          <div className="form-footer">
            <Button
              variant="secondary"
              onClick={() =>
                saveBlob(new Blob([secret?.value ?? ''], { type: 'text/plain' }), 'one-creator-secret.txt')
              }
            >
              <Download size={15} />
              保存到文件
            </Button>
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret?.value ?? '')
                  .then(() => toast('已复制'))
                  .catch(() => toast('请选中文字手动复制'))
              }
            >
              <Copy size={15} />
              复制
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={!!deliveryId} onClose={() => setDeliveryId(null)} title="Webhook 投递记录" wide>
        {deliveries.isPending ? (
          <Loading />
        ) : (
          <div className="result-list">
            {deliveries.data?.items.map((row) => (
              <article key={String(row.id)}>
                <strong>
                  {String(row.status)} · 第 {String(row.attempts)} 次
                </strong>
                <p>事件 ID：{String(row.eventId)}</p>
                <small>
                  {dateTime(String(row.createdAt))} · HTTP {String(row.responseCode ?? '未知')}
                </small>
                <Alert>{String(row.error ?? '')}</Alert>
              </article>
            ))}
            {!deliveries.data?.items.length && (
              <p className="field-hint">订阅创建后的新事件会在这里记录；每个事件使用稳定 ID 与 HMAC 签名。</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
