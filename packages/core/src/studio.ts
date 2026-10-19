import { z } from 'zod';

const nullableId = z.uuid().nullable().default(null);
const ids = z.array(z.uuid()).max(200).default([]);
const text = (max = 8000) => z.string().max(max).default('');
const date = z.union([z.iso.date(), z.literal('')]).default('');
const url = z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).default('');
export const aiKinds = z.enum(['outline', 'draft', 'titles', 'opening', 'adapt', 'rewrite']);
export const studioSchemas = {
  prompt: z.object({
    description: text().describe('写给自己看的用途说明，例如“适合周更的实测类文章”。'),
    scenario: aiKinds.default('draft').describe('预设只在这一类写作步骤中可选，避免把标题模板用于正文。'),
    template: z
      .string()
      .min(1)
      .max(20000)
      .describe('发给模型的写作要求。用 {{变量名}} 插入变量，例如 {{topic}}；账号人设与素材仍会自动附加。'),
    variables: z
      .array(
        z.object({
          key: z
            .string()
            .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
            .describe('模板中的 {{名字}}，只用英文字母、数字和下划线。'),
          label: z.string().min(1).max(100).describe('使用预设时显示给你的填写提示。'),
          default: text(3000).describe('未填写时使用的值。'),
          required: z.boolean().default(false).describe('勾选后，留空不能开始生成。'),
        }),
      )
      .max(30)
      .default([]),
    creativity: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe(
        '对应模型温度：0 更稳妥、贴近素材，适合事实与说明；1 变化更多，适合标题和开头候选。实际温度会记录在任务中。',
      ),
  }),
  workflow: z.object({
    description: text(),
    steps: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          kind: aiKinds.describe('这一步做什么；后一步会收到前一步的输出。'),
          promptId: nullableId.describe('可选。选中的写作预设必须属于同一类步骤，保存时会核对。'),
          instruction: text().describe('只对这一步追加的要求。'),
          variables: z.record(z.string(), z.string()).default({}).describe('提供给所选预设的变量值。'),
        }),
      )
      .min(1)
      .max(12),
  }),
  series: z.object({
    description: text(),
    entries: z
      .array(z.object({ ideaId: z.uuid(), date }))
      .max(200)
      .default([]),
  }),
  observer: z.object({
    platform: text(50),
    homepage: url,
    notes: text(),
    feedId: nullableId,
    materialIds: ids,
  }),
  preference: z.object({
    personaId: nullableId,
    content: z.string().trim().min(1).max(8000),
    sourceType: z.enum(['manual', 'adoption', 'rejection', 'review']).default('manual'),
    sourceId: nullableId,
    state: z.enum(['proposed', 'adopted', 'rejected']).default('proposed'),
  }),
  visual: z.object({
    background: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default('#f4f2e9'),
    foreground: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default('#233c30'),
    accent: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default('#3f7258'),
    font: z.enum(['system', 'serif', 'mono', 'noto']).default('system'),
    footer: text(200),
    ratio: z.enum(['3:4', '1:1', '16:9', '2.35:1']).default('3:4'),
  }),
  dictionary: z.object({
    blocked: z.array(z.string().min(1).max(100)).max(200).default([]),
    exceptions: z.array(z.string().min(1).max(100)).max(200).default([]),
    typos: z
      .array(z.object({ from: z.string().min(1).max(80), to: z.string().max(80) }))
      .max(200)
      .default([]),
  }),
  comment: z.object({
    publishTaskId: z.uuid(),
    author: text(100),
    text: z.string().min(1).max(10000),
    publishedAt: z.iso.datetime({ offset: true }),
    externalId: text(200),
    replyDraft: text(10000),
    replyState: z.enum(['none', 'drafted', 'sent']).default('none'),
  }),
  collaboration: z.object({
    partner: z.string().min(1).max(200),
    contact: text(200),
    documentIds: ids,
    amount: z.number().min(0).max(1000000000),
    paid: z.number().min(0).max(1000000000).default(0),
    currency: z.enum(['CNY', 'USD']).default('CNY'),
    dueDate: date,
    status: z.enum(['prospect', 'contracted', 'delivered', 'settled']).default('prospect'),
    notes: text(),
  }),
  review: z.object({
    publishTaskId: z.uuid(),
    metricIds: ids,
    goal: text(1000),
    notes: text(20000),
    sourceJobId: nullableId,
  }),
  transcript: z.object({
    assetId: z.uuid(),
    language: text(40),
    model: text(150),
    segments: z
      .array(
        z.object({
          start: z.number().nonnegative(),
          end: z.number().positive(),
          text: z.string().max(10000),
        }),
      )
      .min(1)
      .max(20000),
  }),
  video_script: z.object({
    transcriptId: nullableId,
    ratio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
    style: text(1000),
    scenes: z
      .array(
        z.object({
          text: z.string().min(1).max(2000),
          caption: text(2000),
          duration: z.number().min(1).max(300).default(5),
          imageAssetId: nullableId,
        }),
      )
      .min(1)
      .max(60),
  }),
} as const;
export const studioKindSchema = z.enum([
  'prompt',
  'workflow',
  'series',
  'observer',
  'preference',
  'visual',
  'dictionary',
  'comment',
  'collaboration',
  'review',
  'transcript',
  'video_script',
]);
export type StudioKind = z.infer<typeof studioKindSchema>;
export interface StudioItem {
  id: string;
  workspaceId: string;
  accountId: string | null;
  kind: StudioKind;
  name: string;
  data: Record<string, unknown>;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export const studioNames: Record<StudioKind, string> = {
  prompt: '写作预设',
  workflow: '创作工作流',
  series: '栏目系列',
  observer: '对标观察',
  preference: '偏好建议',
  visual: '视觉模板',
  dictionary: '审校词典',
  comment: '评论与回复',
  collaboration: '合作收益',
  review: '内容复盘',
  transcript: '媒体转写',
  video_script: '视频脚本',
};
export const studioInputSchema = z.object({
  kind: studioKindSchema,
  name: z.string().trim().min(1).max(200),
  accountId: nullableId,
  data: z.record(z.string(), z.unknown()),
  archived: z.boolean().default(false),
});
export const capabilityNames = {
  image: '图片生成',
  embedding: '向量检索',
  transcription: '媒体转写',
  tts: '语音合成',
  video: '视频服务',
} as const;
export type ModelCapability = keyof typeof capabilityNames;
export const capabilitySchema = z.enum(['image', 'embedding', 'transcription', 'tts', 'video']);
export interface CapabilityProvider {
  id: string;
  capability: ModelCapability;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  options: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}
export const automationNames = {
  style: '样文风格提炼',
  topics: '推荐选题',
  observer_analysis: '对标内容分析',
  import: '网页与历史文章导入',
  embedding_rebuild: '重建语义索引',
  workflow: '运行创作工作流',
  images: '生成配图',
  language_review: '语言审校',
  fact_review: '事实辅助核对',
  compare: '候选版本比较',
  retrospective: '内容复盘建议',
  comment_reply: '回复草稿',
  transcribe: '媒体转写',
  video_script: '生成视频脚本',
  render_video: '合成短视频',
  clip_video: '视频切片',
  wechat_publish: '公众号正式发布',
  wechat_verify: '查询公众号发布',
  wechat_metrics: '同步公众号指标',
  feed_refresh: '刷新订阅',
  browser_login: '浏览器账号登录',
  browser_publish: '浏览器发布',
  browser_verify: '核对浏览器发布',
} as const;
export type AutomationKind = keyof typeof automationNames;
export interface AutomationJob {
  id: string;
  workspaceId: string;
  accountId: string | null;
  documentId: string | null;
  createdBy: string | null;
  kind: AutomationKind;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  progress: Record<string, unknown>;
  stage: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_verification';
  parentId: string | null;
  attempt: number;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface Feed {
  id: string;
  workspaceId: string;
  accountId: string | null;
  name: string;
  kind: 'rss' | 'json_feed';
  url: string;
  enabled: boolean;
  include: string[];
  exclude: string[];
  intervalMinutes: number;
  lastFetchedAt: string | null;
  nextAt: string;
  error: string;
  revision: number;
}
export interface FeedEntry {
  id: string;
  feedId: string;
  title: string;
  url: string;
  body: string;
  publishedAt: string | null;
  fetchedAt: string;
  feedName?: string;
}
export interface MetricSnapshot {
  id: string;
  workspaceId: string;
  accountId: string;
  publishTaskId: string;
  capturedAt: string;
  basis: 'cumulative' | 'period';
  periodStart: string | null;
  source: 'manual' | 'csv' | 'wechat';
  values: Record<string, number | null>;
  revision: number;
  createdAt: string;
}
export const automationSchemas = {
  style: z.object({
    personaId: nullableId,
    newName: text(80),
    materialIds: z.array(z.uuid()).min(1).max(30),
    instruction: text(3000),
  }),
  topics: z.object({
    feedEntryIds: ids,
    materialIds: ids,
    limit: z.number().int().min(1).max(10).default(5),
    goal: text(2000),
  }),
  observer_analysis: z.object({ observerId: z.uuid(), since: date }),
  import: z.object({
    urls: z.array(z.string().max(3000)).max(100).default([]),
    articles: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
  }),
  embedding_rebuild: z.object({ materialIds: z.array(z.uuid()).max(2000).default([]) }),
  workflow: z.object({ workflowId: z.uuid(), startStep: z.number().int().min(0).max(11).default(0) }),
  images: z.object({
    pages: z
      .array(
        z.object({
          title: z.string().min(1).max(200),
          prompt: z.string().min(1).max(6000),
          referenceAssetId: nullableId,
        }),
      )
      .min(1)
      .max(30),
    style: text(2000),
    regenerate: z.array(z.number().int().nonnegative().max(29)).max(30).default([]),
  }),
  language_review: z.object({ dictionaryId: nullableId, useModel: z.boolean().default(true) }),
  fact_review: z.object({ useModel: z.boolean().default(true) }),
  compare: z.object({ documentIds: z.array(z.uuid()).min(2).max(8), goal: text(2000) }),
  retrospective: z.object({ publishTaskId: z.uuid(), metricIds: ids, notes: text(10000) }),
  comment_reply: z.object({ commentIds: z.array(z.uuid()).min(1).max(50), instruction: text(2000) }),
  transcribe: z.object({ assetId: z.uuid(), language: text(40) }),
  video_script: z.object({ transcriptId: z.uuid(), goal: text(2000) }),
  render_video: z.object({ scriptId: z.uuid(), audioAssetId: nullableId }),
  clip_video: z.object({
    assetId: z.uuid(),
    segments: z
      .array(z.object({ start: z.number().nonnegative(), end: z.number().positive(), label: text(100) }))
      .min(1)
      .max(30),
    transcriptId: nullableId,
  }),
  wechat_publish: z.object({
    publishTaskId: z.uuid(),
    queryOnly: z.boolean().default(false),
    publishId: z.string().max(128).optional(),
  }),
  wechat_verify: z.object({
    publishTaskId: z.uuid(),
    queryOnly: z.literal(true).default(true),
    publishId: z.string().max(128).optional(),
  }),
  wechat_metrics: z.object({ publishTaskIds: ids, from: date, to: date }),
  feed_refresh: z.object({ feedId: z.uuid() }),
  browser_login: z.object({ nodeId: z.uuid(), resetSession: z.boolean().default(false) }),
  browser_publish: z.object({ publishTaskId: z.uuid(), nodeId: z.uuid() }),
  browser_verify: z.object({ publishTaskId: z.uuid(), nodeId: z.uuid() }),
} as const;
export const automationKindSchema = z.enum([
  'style',
  'topics',
  'observer_analysis',
  'import',
  'embedding_rebuild',
  'workflow',
  'images',
  'language_review',
  'fact_review',
  'compare',
  'retrospective',
  'comment_reply',
  'transcribe',
  'video_script',
  'render_video',
  'clip_video',
  'wechat_publish',
  'wechat_verify',
  'wechat_metrics',
  'feed_refresh',
  'browser_login',
  'browser_publish',
  'browser_verify',
]);
