import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Field, Button, IconButton } from './ui';
import { localInput } from '../lib/api';

export interface SchemaNode {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  anyOf?: SchemaNode[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: SchemaNode | boolean;
}
export interface ReferenceOption {
  id: string;
  label: string;
  kind?: string;
  mime?: string;
  revision?: number;
  accountId?: string | null;
  status?: string;
  publishTaskId?: string;
}
export type ReferenceOptions = Record<string, ReferenceOption[]>;
export const fieldLabels: Record<string, string> = {
  name: '名称',
  platforms: '允许的平台',
  description: '说明',
  accountId: '所属账号（留空共享）',
  accountIds: '授权账号',
  username: '登录账号',
  password: '初始密码',
  role: '成员角色',
  active: '启用',
  scopes: '权限范围',
  days: '有效天数',
  baseUrl: '服务基础地址',
  model: '模型 ID',
  currency: '币种',
  inputPerMillion: '每百万输入 token 价格',
  outputPerMillion: '每百万输出 token 价格',
  unitPrice: '每单位价格',
  enabled: '启用',
  events: '订阅事件',
  url: '来源 / 接收地址',
  include: '包含关键词',
  exclude: '排除关键词',
  intervalMinutes: '刷新间隔（分钟）',
  template: '提示词模板',
  variables: '变量',
  key: '变量名（英文字母）',
  label: '显示名称',
  default: '默认值',
  required: '必填',
  scenario: '适用步骤',
  creativity: '变化程度（0 稳妥，1 更多变化）',
  steps: '步骤',
  kind: '步骤类型',
  promptId: '写作预设',
  instruction: '补充要求',
  entries: '系列选题',
  ideaId: '灵感 / 选题',
  date: '创作计划日期',
  platform: '平台',
  homepage: '主页',
  notes: '作者笔记',
  feedId: '关联订阅',
  materialIds: '参考素材',
  personaId: '目标人设',
  content: '建议内容',
  sourceType: '建议来源',
  sourceId: '来源记录 ID',
  state: '处理状态',
  background: '背景颜色',
  foreground: '正文颜色',
  accent: '强调色',
  font: '字体',
  footer: '页脚',
  ratio: '画面比例',
  blocked: '禁用词',
  exceptions: '术语例外',
  typos: '替换词典',
  from: '原词 / 开始日期',
  to: '替换为 / 结束日期',
  publishTaskId: '关联发布记录',
  publishTaskIds: '发布记录范围',
  author: '作者 / 评论人',
  text: '内容',
  publishedAt: '实际时间（设备时区）',
  externalId: '外部记录 ID',
  replyDraft: '回复草稿',
  replyState: '回复状态',
  partner: '合作方',
  contact: '联系方式',
  documentIds: '关联文稿',
  amount: '约定费用',
  paid: '已收款',
  dueDate: '约定日期',
  status: '状态',
  metricIds: '统计快照',
  goal: '创作 / 分析目标',
  sourceJobId: '来源任务 ID',
  assetId: '原始媒体',
  language: '语言（可选，如 zh）',
  segments: '时间片段',
  start: '开始时间（秒）',
  end: '结束时间（秒）',
  transcriptId: '参考转写',
  style: '视觉 / 表达风格',
  scenes: '场景',
  caption: '可编辑字幕',
  duration: '建议时长（秒）',
  imageAssetId: '场景图片',
  newName: '新建人设名称（未选人设时）',
  feedEntryIds: '订阅来源',
  limit: '推荐数量',
  observerId: '观察对象',
  since: '资料起始日期',
  urls: '网页地址',
  articles: '历史文章记录',
  body: '正文',
  workflowId: '工作流',
  startStep: '从第几个步骤继续（0 开始）',
  pages: '配图大纲',
  title: '标题',
  prompt: '画面描述',
  referenceAssetId: '参考图片',
  dictionaryId: '使用词典',
  useModel: '同时使用模型辅助',
  commentIds: '待回复评论',
  scriptId: '视频脚本',
  audioAssetId: '配音文件（留空使用语音模型）',
  nodeId: '执行节点',
  capturedAt: '统计时间（设备时区）',
  basis: '指标口径',
  periodStart: '区间开始时间',
  values: '指标（留空表示未知）',
  views: '阅读 / 播放',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  favorites: '收藏',
  followers: '粉丝',
  completionRate: '完读 / 完播率（%）',
  size: '图片尺寸',
  voice: '声音',
  apiKey: 'API Key',
  options: '服务参数',
};
export const enumLabels: Record<string, string> = {
  wechat: '公众号',
  xiaohongshu: '小红书',
  toutiao: '头条号',
  zhihu: '知乎',
  baijiahao: '百家号',
  bilibili: 'B 站',
  admin: '管理员',
  editor: '编辑',
  viewer: '只读',
  outline: '大纲',
  draft: '正文',
  titles: '标题候选',
  opening: '开头候选',
  adapt: '平台改写',
  rewrite: '润色',
  manual: '手工',
  adoption: '采用记录',
  rejection: '拒绝记录',
  review: '复盘',
  proposed: '待采用',
  adopted: '已采用',
  rejected: '已拒绝',
  system: '系统字体',
  serif: '衬线字体',
  mono: '等宽字体',
  noto: 'Noto 中文字体',
  none: '未回复',
  drafted: '已写草稿',
  sent: '已手工发送',
  prospect: '洽谈中',
  contracted: '已签约',
  delivered: '已交付',
  settled: '已结清',
  cumulative: '累计快照',
  period: '区间增量',
  rss: 'RSS / Atom',
  json_feed: 'JSON Feed',
  supported: '有来源',
  conflict: '来源冲突',
  unverified: '待核实',
  'content:read': '读取内容',
  'content:write': '编辑内容',
  'ai:run': '执行 AI',
  'publish:write': '发布操作',
  'settings:admin': '管理设置',
};
const unwrapped = (schema: SchemaNode) => schema.anyOf?.find((item) => item.type !== 'null') ?? schema;
export function schemaDefault(schema: SchemaNode): unknown {
  if (Object.prototype.hasOwnProperty.call(schema, 'default')) return structuredClone(schema.default);
  const node = unwrapped(schema);
  if (node.type === 'object')
    return Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([key, value]) => [key, schemaDefault(value)]),
    );
  if (node.type === 'array') return [];
  if (node.type === 'boolean') return false;
  if (node.type === 'number' || node.type === 'integer') return node.minimum ?? 0;
  return '';
}
function choices(name: string, options: ReferenceOptions) {
  const direct: Record<string, string> = {
    accountId: 'accounts',
    accountIds: 'accounts',
    documentId: 'documents',
    documentIds: 'documents',
    materialIds: 'materials',
    ideaId: 'ideas',
    personaId: 'personas',
    feedId: 'feeds',
    feedEntryIds: 'feedEntries',
    assetId: 'assets',
    audioAssetId: 'assets',
    imageAssetId: 'assets',
    referenceAssetId: 'assets',
    publishTaskId: 'publications',
    publishTaskIds: 'publications',
    metricIds: 'metrics',
    nodeId: 'nodes',
  };
  const kinds: Record<string, string> = {
    promptId: 'prompt',
    workflowId: 'workflow',
    observerId: 'observer',
    dictionaryId: 'dictionary',
    transcriptId: 'transcript',
    scriptId: 'video_script',
    commentIds: 'comment',
  };
  let result = kinds[name]
    ? (options.items ?? []).filter((item) => item.kind === kinds[name])
    : (options[direct[name]] ?? []);
  if (['imageAssetId', 'referenceAssetId'].includes(name))
    result = result.filter((item) => item.mime?.startsWith('image/'));
  if (name === 'audioAssetId') result = result.filter((item) => item.mime?.startsWith('audio/'));
  return result;
}
function DictionaryInput({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState('');
  return (
    <div className="form-stack">
      {Object.entries(value).map(([key, item]) => (
        <div className="record-row" key={key}>
          <span>{key}</span>
          <input
            value={item}
            aria-label={`变量 ${key}`}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
          />
          <IconButton
            label={`移除变量 ${key}`}
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))
            }
          >
            <X size={15} />
          </IconButton>
        </div>
      ))}
      <div className="record-row">
        <input
          aria-label="新增变量名"
          placeholder="变量名"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
        />
        <Button
          variant="secondary"
          disabled={!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(newKey) || Object.hasOwn(value, newKey)}
          onClick={() => {
            onChange({ ...value, [newKey]: '' });
            setNewKey('');
          }}
        >
          添加变量
        </Button>
      </div>
    </div>
  );
}
export function SchemaField({
  name,
  schema,
  value,
  onChange,
  options = {},
  required = false,
}: {
  name: string;
  schema: SchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
  options?: ReferenceOptions;
  required?: boolean;
}) {
  const [page, setPage] = useState(0);
  const node = unwrapped(schema),
    label = fieldLabels[name] ?? schema.title ?? name,
    hint = schema.description ?? node.description,
    nullable = schema.anyOf?.some((item) => item.type === 'null');
  if (node.type === 'object')
    return node.properties ? (
      <fieldset className="schema-group">
        <legend>{label}</legend>
        <SchemaFields
          schema={node}
          value={(value ?? {}) as Record<string, unknown>}
          onChange={onChange}
          options={options}
        />
      </fieldset>
    ) : (
      <Field label={label} hint={hint}>
        <DictionaryInput value={(value ?? {}) as Record<string, string>} onChange={onChange} />
      </Field>
    );
  if (node.type === 'array') {
    const values = Array.isArray(value) ? value : [];
    const element = node.items ?? { type: 'string' };
    const currentPage = Math.min(page, Math.max(0, Math.ceil(values.length / 25) - 1));
    return (
      <fieldset className="schema-group">
        <legend>
          {label} · {values.length}
        </legend>
        {hint && <p className="field-hint">{hint}</p>}
        {nullable && name === 'accountIds' && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(event) => onChange(event.target.checked ? null : [])}
            />
            <span>全部账号；取消后选择具体授权账号</span>
          </label>
        )}
        {value !== null && (
          <>
            {values.slice(currentPage * 25, (currentPage + 1) * 25).map((entry, position) => {
              const index = currentPage * 25 + position;
              return (
                <div className="schema-array-item" key={index}>
                  <SchemaField
                    name={name}
                    schema={element}
                    value={entry}
                    onChange={(next) => onChange(values.map((item, i) => (i === index ? next : item)))}
                    options={options}
                  />
                  <div className="array-actions">
                    <IconButton
                      label={`第 ${index + 1} 项上移`}
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...values];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        onChange(next);
                      }}
                    >
                      <ArrowUp size={14} />
                    </IconButton>
                    <IconButton
                      label={`第 ${index + 1} 项下移`}
                      disabled={index === values.length - 1}
                      onClick={() => {
                        const next = [...values];
                        [next[index + 1], next[index]] = [next[index], next[index + 1]];
                        onChange(next);
                      }}
                    >
                      <ArrowDown size={14} />
                    </IconButton>
                    <IconButton
                      label={`移除第 ${index + 1} 项`}
                      onClick={() => onChange(values.filter((_, i) => i !== index))}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
            {values.length > 25 && (
              <div className="form-footer">
                <Button variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  上一页
                </Button>
                <span>
                  {currentPage + 1} / {Math.ceil(values.length / 25)}
                </span>
                <Button
                  variant="ghost"
                  disabled={(currentPage + 1) * 25 >= values.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
            <Button
              variant="secondary"
              disabled={values.length >= (node.maxItems ?? 500)}
              onClick={() => {
                setPage(Math.floor(values.length / 25));
                onChange([...values, schemaDefault(element)]);
              }}
            >
              <Plus size={15} />
              添加{label}
            </Button>
          </>
        )}
      </fieldset>
    );
  }
  if (node.type === 'boolean')
    return (
      <label className="checkbox-field">
        <input type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} />
        <span>
          {label}
          {hint && <small className="field-hint"> · {hint}</small>}
        </span>
      </label>
    );
  if (node.enum)
    return (
      <Field label={label} hint={hint} required={required}>
        <select
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          required={required}
        >
          <option value="">请选择</option>
          {node.enum.map((entry) => (
            <option key={String(entry)} value={String(entry)}>
              {enumLabels[String(entry)] ?? String(entry)}
            </option>
          ))}
        </select>
      </Field>
    );
  if (node.format === 'uuid')
    return (
      <Field label={label} hint={hint} required={required && !nullable}>
        <select
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value || (nullable ? null : ''))}
          required={required && !nullable}
        >
          <option value="">{nullable ? '未指定 / 共享' : '请选择'}</option>
          {choices(name, options).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.revision ? ` · v${option.revision}` : ''}
              {option.status ? ` · ${option.status}` : ''}
            </option>
          ))}
        </select>
      </Field>
    );
  if (node.type === 'number' || node.type === 'integer')
    return (
      <Field label={label} hint={hint} required={required && !nullable}>
        <input
          type="number"
          min={node.minimum}
          max={node.maximum}
          step={node.type === 'integer' ? 1 : 'any'}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          required={required && !nullable}
        />
      </Field>
    );
  if (node.format === 'date-time')
    return (
      <Field label={label} hint={hint} required={required && !nullable}>
        <input
          type="datetime-local"
          value={value ? localInput(String(value)) : ''}
          onChange={(event) =>
            onChange(event.target.value ? new Date(event.target.value).toISOString() : nullable ? null : '')
          }
          required={required && !nullable}
        />
      </Field>
    );
  const long =
    (node.maxLength ?? 0) > 500 ||
    ['template', 'body', 'text', 'content', 'notes', 'replyDraft'].includes(name);
  return (
    <Field label={label} hint={hint} required={required && !nullable}>
      {long ? (
        <textarea
          value={String(value ?? '')}
          rows={name === 'template' ? 6 : 3}
          maxLength={node.maxLength}
          required={required && !nullable}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={
            node.format === 'date'
              ? 'date'
              : node.format === 'uri'
                ? 'url'
                : ['password', 'apiKey', 'appSecret'].includes(name)
                  ? 'password'
                  : ['background', 'foreground', 'accent'].includes(name)
                    ? 'color'
                    : 'text'
          }
          value={String(value ?? '')}
          maxLength={node.maxLength}
          required={required && !nullable}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
export function SchemaFields({
  schema,
  value,
  onChange,
  options = {},
}: {
  schema: SchemaNode;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  options?: ReferenceOptions;
}) {
  return (
    <div className="form-stack">
      {Object.entries(schema.properties ?? {}).map(([key, field]) => (
        <SchemaField
          key={key}
          name={key}
          schema={field}
          value={value[key]}
          required={schema.required?.includes(key)}
          onChange={(next) => onChange({ ...value, [key]: next })}
          options={options}
        />
      ))}
    </div>
  );
}
