import {
  documentSchema,
  emptyPreferences,
  type Account,
  type Citation,
  type ContentDocument,
  type DocumentInput,
  type Excerpt,
  type Material,
  type Persona,
  type Preferences,
  type WritingContext,
  studioSchemas,
} from '@one-creator/core';
import { item } from './studio.js';
import type { Sql } from './database.js';
import { AppError, conflict } from './errors.js';
import { checkReference, id, insert, owned, update } from './records.js';

export async function writingContext(
  sql: Sql,
  workspaceId: string,
  accountId: string | null,
  materialIds: string[] = [],
  excerpts: Excerpt[] = [],
  visualTemplateId: string | null = null,
): Promise<WritingContext> {
  const account = accountId ? await owned<Account>(sql, 'accounts', workspaceId, accountId) : null;
  const persona = account?.personaId
    ? await owned<Persona>(sql, 'personas', workspaceId, account.personaId)
    : null;
  const preferences = { ...emptyPreferences };
  const preferenceSources = {} as Record<keyof Preferences, string>;
  for (const key of Object.keys(emptyPreferences) as (keyof Preferences)[]) {
    preferences[key] = account?.preferences[key]?.trim() || persona?.[key] || '';
    preferenceSources[key] = account?.preferences[key]?.trim()
      ? '账号专属设置'
      : persona?.[key]
        ? `人设 · ${persona.name}`
        : '尚未设置';
  }
  const citations: Citation[] = [];
  for (const materialId of new Set(materialIds)) {
    const material = await owned<Material>(sql, 'materials', workspaceId, materialId);
    if (material.accountId && material.accountId !== accountId)
      throw new AppError(
        400,
        'MATERIAL_SCOPE',
        `「${material.title}」属于另一个账号，请选择共享素材或当前账号的素材`,
      );
    citations.push({
      id: material.id,
      title: material.title,
      body: material.body,
      url: material.url,
      author: material.author,
      revision: material.revision,
      excerpts: excerpts
        .filter((excerpt) => excerpt.materialId === material.id)
        .map(({ text }) => ({ text, found: material.body.includes(text) })),
    });
  }
  const visual = visualTemplateId ? await item(sql, workspaceId, visualTemplateId, 'visual') : null;
  if (visual?.accountId && visual.accountId !== accountId)
    throw new AppError(400, 'VISUAL_SCOPE', '视觉模板属于另一个账号');
  return {
    account: account ? { id: account.id, name: account.name, platform: account.platform } : null,
    persona: persona ? { id: persona.id, name: persona.name, revision: persona.revision } : null,
    preferences,
    preferenceSources,
    citations,
    visual: visual
      ? {
          id: visual.id,
          name: visual.name,
          revision: visual.revision,
          ...studioSchemas.visual.parse(visual.data),
        }
      : null,
  };
}

async function documentReferences(sql: Sql, workspaceId: string, data: DocumentInput) {
  if (data.excerpts.some((excerpt) => !data.materialIds.includes(excerpt.materialId)))
    throw new AppError(400, 'EXCERPT_SOURCE', '请先关联摘录所属的素材，再引用具体片段');
  await checkReference(sql, 'ideas', workspaceId, data.ideaId);
  const inlineAssets = [...data.body.matchAll(/\/api\/assets\/([a-f\d-]{36})/g)].map((match) => match[1]);
  for (const assetId of new Set([
    ...data.assetIds,
    ...inlineAssets,
    ...(data.coverAssetId ? [data.coverAssetId] : []),
  ]))
    await checkReference(sql, 'assets', workspaceId, assetId);
  if (data.videoAssetId) {
    const video = await owned<{ mime: string }>(sql, 'assets', workspaceId, data.videoAssetId);
    if (!video.mime.startsWith('video/'))
      throw new AppError(400, 'VIDEO_ASSET', '视频文件必须是 MP4 等视频格式');
  }
}
export async function createDocument(
  sql: Sql,
  workspaceId: string,
  input: DocumentInput,
  source?: ContentDocument,
): Promise<ContentDocument> {
  const data = documentSchema.parse(input);
  await documentReferences(sql, workspaceId, data);
  const context = await writingContext(
    sql,
    workspaceId,
    data.accountId,
    data.materialIds,
    data.excerpts,
    data.visualTemplateId,
  );
  if (source && !data.accountId) throw new AppError(400, 'ACCOUNT_REQUIRED', '平台版本需要选择目标账号');
  const document = await insert<ContentDocument>(sql, 'documents', {
    id: id(),
    workspaceId,
    ...data,
    sourceId: source?.id ?? null,
    sourceRevision: source?.revision ?? null,
    context,
  });
  await insert(sql, 'document_revisions', {
    id: id(),
    workspaceId,
    documentId: document.id,
    revision: 1,
    data: document,
    reason: source ? '从母稿创建平台版本' : '创建母稿',
  });
  if (data.ideaId)
    await update(sql, 'ideas', workspaceId, data.ideaId, {
      status: 'selected',
      updatedAt: new Date().toISOString(),
    });
  return document;
}
export async function saveDocument(
  sql: Sql,
  workspaceId: string,
  documentId: string,
  expectedRevision: number,
  input: DocumentInput,
  reason = '编辑保存',
): Promise<ContentDocument> {
  const previous = await owned<ContentDocument>(sql, 'documents', workspaceId, documentId, true);
  if (previous.revision !== expectedRevision) throw conflict();
  const data = documentSchema.parse(input);
  if (previous.sourceId && !data.accountId)
    throw new AppError(400, 'ACCOUNT_REQUIRED', '平台版本需要保留目标账号');
  await documentReferences(sql, workspaceId, data);
  const context = await writingContext(
    sql,
    workspaceId,
    data.accountId,
    data.materialIds,
    data.excerpts,
    data.visualTemplateId,
  );
  const document = await update<ContentDocument>(sql, 'documents', workspaceId, documentId, {
    ...data,
    context,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  await insert(sql, 'document_revisions', {
    id: id(),
    workspaceId,
    documentId,
    revision: document.revision,
    data: document,
    reason,
  });
  return document;
}
export async function getDocument(
  sql: Sql,
  workspaceId: string,
  documentId: string,
): Promise<ContentDocument> {
  const document = await owned<ContentDocument>(sql, 'documents', workspaceId, documentId);
  const account = document.accountId
    ? await owned<Account>(sql, 'accounts', workspaceId, document.accountId)
    : null;
  let sourceOutdated = false;
  if (document.sourceId) {
    const source = await owned<ContentDocument>(sql, 'documents', workspaceId, document.sourceId);
    sourceOutdated = source.revision !== document.sourceRevision;
  }
  return { ...document, accountName: account?.name, platform: account?.platform, sourceOutdated };
}
