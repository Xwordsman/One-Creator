import { z } from 'zod';
export * from './studio.js';
export * from './browser.js';

export const platforms = {
  wechat: {
    name: '微信公众号',
    short: '公众号',
    color: '#21744b',
    contentType: '图文文章',
    hint: '完整表达，沉淀有价值的长内容',
  },
  xiaohongshu: {
    name: '小红书',
    short: '小红书',
    color: '#c94661',
    contentType: '图文笔记',
    hint: '轻盈的文字，直观的图文表达',
  },
  toutiao: {
    name: '今日头条',
    short: '头条',
    color: '#b35832',
    contentType: '头条文章',
    hint: '清晰的观点，有依据的内容解读',
  },
  zhihu: {
    name: '知乎',
    short: '知乎',
    color: '#356dba',
    contentType: '专栏文章',
    hint: '专业解释与长文观点',
  },
  baijiahao: {
    name: '百家号',
    short: '百家号',
    color: '#456cba',
    contentType: '图文文章',
    hint: '资讯与知识表达',
  },
  bilibili: {
    name: '哔哩哔哩',
    short: 'B 站',
    color: '#ac5c87',
    contentType: '视频投稿',
    hint: '视频、封面与简介',
  },
} as const;

export type Platform = keyof typeof platforms;
export const platformSchema = z.enum(['wechat', 'xiaohongshu', 'toutiao', 'zhihu', 'baijiahao', 'bilibili']);
const optionalId = z.uuid().nullable().default(null);
const shortText = z.string().trim().max(300).default('');
export const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20).default([]);
export const preferencesSchema = z.object({
  positioning: z.string().max(2000).default(''),
  audience: z.string().max(1000).default(''),
  tone: z.string().max(1000).default(''),
  avoid: z.string().max(1000).default(''),
  sample: z.string().max(20000).default(''),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const emptyPreferences: Preferences = {
  positioning: '',
  audience: '',
  tone: '',
  avoid: '',
  sample: '',
};

export const personaSchema = z.object({ name: z.string().trim().min(1).max(80), ...preferencesSchema.shape });
export type PersonaInput = z.infer<typeof personaSchema>;
export interface Persona extends PersonaInput {
  id: string;
  workspaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  platform: platformSchema,
  handle: shortText,
  category: z.string().max(50).default(''),
  homepage: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).default(''),
  personaId: optionalId,
  preferences: preferencesSchema.default(emptyPreferences),
  active: z.boolean().default(true),
});
export type AccountInput = z.infer<typeof accountSchema>;
export interface Account extends AccountInput {
  id: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  personaName?: string;
  documentCount?: number;
}

export const connectionSchema = z.object({
  method: z.literal('wechat_api').default('wechat_api'),
  appId: z
    .string()
    .trim()
    .regex(/^wx[a-zA-Z0-9]{16}$/, 'AppID 应为 wx 开头的 18 位标识'),
  appSecret: z.string().trim().min(16).max(200).optional(),
  expectedRevision: z.number().int().nonnegative(),
});
export type ConnectionInput = z.infer<typeof connectionSchema>;
export const connectionStatusNames = {
  unconfigured: '未配置',
  unchecked: '待检查',
  connected: '已连接',
  credentials_invalid: '凭据失效',
  permission_denied: '权限不足',
  network_restricted: 'IP 白名单限制',
  unavailable: '连接不可用',
} as const;
export type ConnectionStatus = keyof typeof connectionStatusNames;
export interface AccountConnection {
  id: string | null;
  accountId: string;
  method: 'wechat_api';
  appId: string;
  hasSecret: boolean;
  revision: number;
  status: ConnectionStatus;
  checkedAt: string | null;
  error: string;
  updatedAt: string | null;
}
export interface Capability {
  status: 'supported' | 'unknown' | 'unsupported';
  reason: string;
}
export interface AccountCapabilities {
  accountId: string;
  platform: Platform;
  connection: ConnectionStatus;
  capabilities: Record<
    'export' | 'manual_record' | 'save_draft' | 'publish' | 'schedule' | 'fetch_metrics',
    Capability
  >;
}

export const ideaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10000).default(''),
  accountId: optionalId,
  tags: tagsSchema,
  materialIds: z.array(z.uuid()).max(30).default([]),
  status: z.enum(['inbox', 'selected', 'parked', 'archived']).default('inbox'),
});
export type IdeaInput = z.infer<typeof ideaSchema>;
export interface Idea extends IdeaInput {
  id: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  documentId?: string;
}

export const materialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100000).default(''),
  url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).default(''),
  author: shortText,
  sourceDate: z.union([z.iso.date(), z.literal('')]).default(''),
  tags: tagsSchema,
  accountId: optionalId,
  kind: z.enum(['text', 'link', 'image']).default('text'),
  assetId: optionalId,
  archived: z.boolean().default(false),
});
export type MaterialInput = z.infer<typeof materialSchema>;
export interface Material extends MaterialInput {
  id: string;
  workspaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** `duplicate` is set on upload responses that matched an existing file and reused it. */
export interface Asset {
  id: string;
  workspaceId: string;
  filename: string;
  storageKey: string;
  mime: string;
  size: number;
  hash: string;
  createdAt: string;
  duplicate?: boolean;
}

export const excerptSchema = z.object({
  materialId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
});
export type Excerpt = z.infer<typeof excerptSchema>;
export const documentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(120000).default(''),
  outline: z.string().max(30000).default(''),
  brief: z.string().max(10000).default(''),
  accountId: optionalId,
  ideaId: optionalId,
  materialIds: z.array(z.uuid()).max(30).default([]),
  excerpts: z.array(excerptSchema).max(60).default([]),
  visualTemplateId: optionalId,
  videoAssetId: optionalId,
  assetIds: z.array(z.uuid()).max(30).default([]),
  coverAssetId: optionalId,
  tags: tagsSchema,
  status: z.enum(['editing', 'ready', 'archived']).default('editing'),
});
export type DocumentInput = z.infer<typeof documentSchema>;
export interface ContentDocument extends DocumentInput {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  sourceRevision: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  context: WritingContext;
  accountName?: string;
  platform?: Platform;
  variantCount?: number;
  sourceOutdated?: boolean;
}
export interface Citation {
  id: string;
  title: string;
  body: string;
  url: string;
  author: string;
  revision: number;
  excerpts?: { text: string; found: boolean }[];
}
export interface WritingContext {
  visual?: {
    id: string;
    name: string;
    revision: number;
    background: string;
    foreground: string;
    accent: string;
    font: string;
    footer: string;
    ratio: string;
  } | null;
  account: { id: string; name: string; platform: Platform } | null;
  persona: { id: string; name: string; revision: number } | null;
  preferences: Preferences;
  preferenceSources: Record<keyof Preferences, string>;
  citations: Citation[];
}
export interface DocumentRevision {
  id: string;
  documentId: string;
  revision: number;
  data: ContentDocument;
  reason: string;
  createdAt: string;
}

export const jobSchema = z.object({
  documentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  kind: z.enum(['outline', 'draft', 'titles', 'opening', 'adapt', 'rewrite']),
  instruction: z.string().max(30000).default(''),
  templateId: z.uuid().optional(),
  variables: z
    .record(z.string(), z.string().max(4000))
    .refine((value) => Object.keys(value).length <= 30)
    .default({}),
  creativity: z.number().min(0).max(1).optional(),
  selection: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      text: z.string().max(120000),
    })
    .optional(),
});
export type JobInput = z.infer<typeof jobSchema>;
export type AIKind = JobInput['kind'];
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_verification';
export const jobStageNames = {
  queued: '等待执行',
  preparing: '准备上下文',
  generating: '模型生成',
  reviewing: '检查引用',
  rendering: '生成图片',
  importing: '读取素材',
  exporting: '打包导出',
  uploading_images: '上传正文图片',
  uploading_cover: '上传封面',
  creating_draft: '提交草稿',
  verifying_draft: '核对平台草稿',
  done: '已完成',
} as const;
export type JobStage = keyof typeof jobStageNames;
export function stageName(stage: string) {
  return (
    (jobStageNames as Record<string, string>)[stage] ??
    (
      {
        parsing: '解析结果',
        workflow: '执行工作流',
        replying: '生成回复',
        embedding: '建立语义索引',
        transcribing: '转写媒体',
        synthesizing: '合成语音',
        rendering_video: '合成视频',
        clipping: '导出片段',
        publishing: '提交发布',
        verifying: '核对平台结果',
        waiting_user: '等待人工交互',
      } as Record<string, string>
    )[stage] ??
    stage
  );
}
export interface DraftPayload {
  article_type: 'news';
  title: string;
  content: string;
  thumb_media_id: string;
}
export interface JobProgress {
  done?: number;
  total?: number;
  images?: Record<string, string>;
  coverAssetId?: string;
  coverMediaId?: string;
  payload?: DraftPayload;
  submittedAt?: string;
  appId?: string;
  connectionId?: string;
  connectionRevision?: number;
}
export interface AIJob {
  id: string;
  workspaceId: string;
  documentId: string;
  kind: JobInput['kind'];
  status: JobStatus;
  stage: JobStage;
  progress: JobProgress;
  warnings: string[];
  publishTaskId: string | null;
  input: {
    document: ContentDocument;
    instruction: string;
    selection?: JobInput['selection'];
    model: string;
    baseUrl: string;
    connectionId?: string;
    connectionRevision?: number;
    appId?: string;
    template?: {
      id: string;
      name: string;
      revision: number;
      params: Record<string, string>;
      data: Record<string, unknown>;
    };
    creativity?: number;
  };
  output: string;
  error: string;
  attempt: number;
  parentId: string | null;
  model: string;
  usage: Record<string, number> | null;
  appliedRevision: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export type WorkerJob = Omit<AIJob, 'kind'> & { kind: AIKind | 'wechat_draft' };

export const activityKindSchema = z.enum(['import_text', 'render_cards', 'crop_cover', 'export_document']);
export type ActivityKind = z.infer<typeof activityKindSchema>;
export const activityNames: Record<ActivityKind, string> = {
  import_text: '导入文字素材',
  render_cards: '生成图文卡片',
  crop_cover: '裁剪封面',
  export_document: '导出发布包',
};
export interface Activity {
  id: string;
  workspaceId: string;
  documentId: string | null;
  kind: ActivityKind;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  stage: JobStage;
  error: string;
  output: string;
  parentId: string | null;
  attempt: number;
  createdAt: string;
  finishedAt: string | null;
}
export interface WorkTask {
  id: string;
  title: string;
  kind: WorkerJob['kind'] | ActivityKind | import('./studio.js').AutomationKind;
  status: JobStatus;
  stage: string;
  createdAt: string;
  attempt: number;
  error: string;
  job: WorkerJob | null;
  activity: Activity | null;
  automation?: import('./studio.js').AutomationJob | null;
}

export const providerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().max(1000).optional(),
});
export type ProviderInput = z.infer<typeof providerSchema>;
export interface Provider {
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  updatedAt: string;
}

export const publishSchema = z.object({
  documentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
  timezone: z.string().max(80).default('Asia/Shanghai'),
  executionMode: z.enum(['manual', 'wechat_draft', 'wechat_publish', 'browser_publish']).default('manual'),
  overduePolicy: z.enum(['wait', 'execute']).default('wait'),
  nodeId: optionalId,
});
export const publishStatusSchema = z.enum([
  'planned',
  'waiting_user',
  'submitting',
  'submitted',
  'draft_saved',
  'verification_required',
  'published',
  'publish_failed',
  'platform_unavailable',
  'cancelled',
]);
export interface PublishTask {
  id: string;
  workspaceId: string;
  documentId: string;
  accountId: string;
  snapshot: ContentDocument;
  status: z.infer<typeof publishStatusSchema>;
  channel: 'manual' | 'wechat_api' | 'browser';
  operation: string;
  publishId: string | null;
  msgDataId: string | null;
  platformArticleId: string | null;
  platformResult: Record<string, unknown>;
  publicationCheckedAt: string | null;
  executionMode: 'manual' | 'wechat_draft' | 'wechat_publish' | 'browser_publish';
  executionRevision: number;
  overduePolicy: 'wait' | 'execute';
  nodeId: string | null;
  automationJob?: import('./studio.js').AutomationJob | null;
  publishCapability?: Capability;
  browserNodeId?: string | null;
  submittedAt: string | null;
  platformDraftId: string | null;
  channelAppId: string | null;
  channelJob?: WorkerJob | null;
  draftCapability?: Capability;
  scheduledAt: string | null;
  timezone: string;
  publishedAt: string | null;
  url: string;
  resultSource: 'user_recorded' | 'platform_api' | 'node_observed' | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: 'admin' | 'editor' | 'viewer';
  accountIds: string[] | null;
  tokenScopes?: string[];
}
export interface Bootstrap {
  needsSetup: boolean;
  user: SessionUser | null;
  version: string;
  database: 'postgres' | 'embedded';
}
export interface Dashboard {
  counts: {
    accounts: number;
    documents: number;
    materials: number;
    ideas: number;
    planned: number;
    published: number;
  };
  documents: ContentDocument[];
  tasks: PublishTask[];
}
export interface ValidationIssue {
  severity: 'error' | 'suggestion';
  field: string;
  message: string;
  source: string;
}
/** Date the platform field rules below were last checked against their sources. */
export const platformRulesVersion = '2026-10-16';
const wechatDraftRules = '微信公众号草稿接口 draft/add 字段说明（2026-07 更新）';
export function validateDocument(
  doc: Pick<ContentDocument, 'title' | 'body' | 'assetIds' | 'coverAssetId'> & {
    videoAssetId?: string | null;
  },
  platform?: Platform,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const titleLength = [...doc.title.trim()].length;
  const bodyLength = [...doc.body].length;
  if (!titleLength)
    issues.push({ severity: 'error', field: 'title', message: '请填写标题', source: '工作台必填字段' });
  if (!doc.body.trim())
    issues.push({
      severity: 'error',
      field: 'body',
      message: '正文还是空的，请先完成内容',
      source: '工作台必填字段',
    });
  if (platform === 'wechat') {
    if (titleLength > 32)
      issues.push({
        severity: 'suggestion',
        field: 'title',
        message: `标题 ${titleLength} 字，草稿接口要求不超过 32 字，发布前请在后台核对`,
        source: wechatDraftRules,
      });
    if (!doc.coverAssetId)
      issues.push({
        severity: 'suggestion',
        field: 'cover',
        message: '图文消息需要封面，可在图片附件中裁剪一张作为封面',
        source: wechatDraftRules,
      });
    if (bodyLength > 15000)
      issues.push({
        severity: 'suggestion',
        field: 'body',
        message: '正文较长，排版后的 HTML 需少于 2 万字符，保存草稿前请检查',
        source: wechatDraftRules,
      });
  }
  if (platform === 'toutiao' && titleLength > 30)
    issues.push({
      severity: 'suggestion',
      field: 'title',
      message: `标题 ${titleLength} 字，头条文章标题通常不超过 30 字`,
      source: '创作者经验参考；最终以发布页面为准',
    });
  if (platform === 'xiaohongshu') {
    if (titleLength > 20)
      issues.push({
        severity: 'suggestion',
        field: 'title',
        message: '标题超过 20 字，请在发布前核对当前平台限制',
        source: '社区经验参考；最终以发布页面为准',
      });
    if (bodyLength > 1000)
      issues.push({
        severity: 'suggestion',
        field: 'body',
        message: '正文较长，可以将部分内容转换成图文卡片',
        source: '图文笔记写作建议',
      });
    if (!doc.assetIds.length)
      issues.push({
        severity: 'suggestion',
        field: 'images',
        message: '可在「图文卡片」中把正文生成配图',
        source: '图文笔记准备建议',
      });
  }
  const experience = '创作者经验参考；最终以发布页面为准';
  if (platform === 'zhihu' && titleLength > 100)
    issues.push({
      severity: 'suggestion',
      field: 'title',
      message: `标题 ${titleLength} 字，专栏文章标题建议精简`,
      source: experience,
    });
  if (platform === 'baijiahao') {
    if (titleLength > 30)
      issues.push({
        severity: 'suggestion',
        field: 'title',
        message: `标题 ${titleLength} 字，百家号图文标题通常不超过 30 字`,
        source: experience,
      });
    if (!doc.coverAssetId)
      issues.push({
        severity: 'suggestion',
        field: 'cover',
        message: '百家号图文通常需要封面图',
        source: experience,
      });
  }
  if (platform === 'bilibili') {
    if (titleLength > 80)
      issues.push({
        severity: 'suggestion',
        field: 'title',
        message: `标题 ${titleLength} 字，B 站视频标题通常不超过 80 字`,
        source: experience,
      });
    if (!doc.videoAssetId)
      issues.push({
        severity: 'suggestion',
        field: 'video',
        message: '视频投稿需要选择一个视频文件，浏览器通道不能缺少视频',
        source: '视频投稿必需素材',
      });
  }
  return issues;
}

export const jobNames: Record<WorkerJob['kind'], string> = {
  outline: '生成大纲',
  draft: '撰写正文',
  titles: '标题灵感',
  opening: '开头备选',
  adapt: '平台改写',
  rewrite: '润色改写',
  wechat_draft: '公众号草稿',
};
export const documentStatusNames = { editing: '创作中', ready: '待发布', archived: '已归档' };
export const publishStatusNames = {
  planned: '已排期',
  waiting_user: '待手动发布',
  submitting: '提交草稿中',
  submitted: '已提交，待平台结果',
  draft_saved: '已存草稿',
  verification_required: '草稿待核对',
  published: '已发布',
  publish_failed: '发布未通过',
  platform_unavailable: '平台内容不可见',
  cancelled: '已取消',
};
