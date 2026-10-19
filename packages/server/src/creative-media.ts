import { readFile } from 'node:fs/promises';
import type { Asset } from '@one-creator/core';
import { studioSchemas } from '@one-creator/core';
import type { AutomationContext } from './automation-types.js';
import { capabilityProvider, capabilityRequest, boundedJson } from './capabilities.js';
import { assetPath, storeAsset, storeMedia } from './files.js';
import { owned } from './records.js';
import { recordUsage } from './usage.js';
import { fetchPublic } from './public-fetch.js';
import { createItem } from './studio.js';
import { importArticle } from './discovery.js';
import { AppError } from './errors.js';

export async function responseBytes(response: Response, maximum = 128 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError(502, 'MEDIA_EMPTY', '服务未返回媒体');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new AppError(502, 'MEDIA_TOO_LARGE', '返回媒体超过容量限制');
    }
    parts.push(part.value);
  }
  return Buffer.concat(parts);
}
export async function generateImages(context: AutomationContext) {
  const provider = await capabilityProvider(context.db, context.job.workspaceId, 'image');
  const pages = context.input.data.pages as {
    title: string;
    prompt: string;
    referenceAssetId: string | null;
  }[];
  const images = (context.job.progress.images ?? []) as {
    index: number;
    status: string;
    assetId?: string;
    error?: string;
    prompt?: string;
    model?: string;
    providerRevision?: number;
  }[];
  for (const [index, page] of pages.entries()) {
    if (images.some((image) => image.index === index && image.status === 'succeeded')) continue;
    await context.report('rendering', {
      ...context.job.progress,
      images,
      total: pages.length,
      done: images.filter((image) => image.status === 'succeeded').length,
    });
    try {
      const prompt = `${page.title}\n${page.prompt}\n视觉要求：${String(context.input.data.style ?? '')}`;
      let body: unknown = {
          model: provider.model,
          prompt,
          n: 1,
          size: provider.options.size ?? '1024x1024',
          response_format: 'b64_json',
        },
        pathname = '/images/generations';
      if (page.referenceAssetId) {
        const reference = await owned<Asset>(
          context.db,
          'assets',
          context.job.workspaceId,
          page.referenceAssetId,
        );
        if (!reference.mime.startsWith('image/'))
          throw new AppError(400, 'REFERENCE_IMAGE', '参考图必须是图片');
        const form = new FormData();
        form.set('model', provider.model);
        form.set('prompt', prompt);
        form.set('n', '1');
        form.set(
          'image',
          new Blob(
            [new Uint8Array(await readFile(assetPath(context.config.dataDir, reference.storageKey)))],
            { type: reference.mime },
          ),
          reference.filename,
        );
        body = form;
        pathname = '/images/edits';
      }
      const response = await boundedJson(
        await capabilityRequest(context.config, provider, pathname, body, context.signal),
      );
      const items = response.data as { b64_json?: string; url?: string }[];
      if (!Array.isArray(items) || !items.length) throw new AppError(502, 'IMAGE_RESULT', '服务没有返回图片');
      let bytes: Buffer;
      if (items[0].b64_json) bytes = Buffer.from(items[0].b64_json, 'base64');
      else if (items[0].url) {
        const download = await fetchPublic(items[0].url, {
          allowedOrigins: context.config.integrationOrigins,
          maxBytes: 12 * 1024 * 1024,
          signal: context.signal,
        });
        if (download.status !== 200) throw new AppError(502, 'IMAGE_DOWNLOAD', '生成图片下载失败');
        bytes = download.bytes;
      } else throw new AppError(502, 'IMAGE_RESULT', '图片响应格式不兼容');
      await recordUsage(context.db, {
        workspaceId: context.job.workspaceId,
        accountId: context.job.accountId,
        jobId: context.job.id,
        callKey: `${context.job.id}:image:${index}`,
        title: page.title,
        capability: 'image',
        baseUrl: provider.baseUrl,
        model: provider.model,
        units: items.length,
      });
      await context.report('rendering', {
        ...context.job.progress,
        images,
        total: pages.length,
        done: index,
      });
      const asset = await storeAsset(
        context.db,
        context.job.workspaceId,
        context.config.dataDir,
        `${page.title.slice(0, 100)}.png`,
        bytes,
        {
          accountId: context.job.accountId,
          createdBy: context.job.createdBy ?? undefined,
          metadata: {
            kind: 'ai_image',
            jobId: context.job.id,
            prompt,
            model: provider.model,
            providerRevision: provider.revision,
            referenceAssetId: page.referenceAssetId,
          },
        },
      );
      const old = images.findIndex((image) => image.index === index);
      if (old >= 0) images.splice(old, 1);
      images.push({
        index,
        status: 'succeeded',
        assetId: asset.id,
        prompt,
        model: provider.model,
        providerRevision: provider.revision,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const old = images.findIndex((image) => image.index === index);
      if (old >= 0) images.splice(old, 1);
      images.push({
        index,
        status: 'failed',
        error: error instanceof AppError ? error.message : '图片生成失败',
      });
      await recordUsage(context.db, {
        workspaceId: context.job.workspaceId,
        accountId: context.job.accountId,
        jobId: context.job.id,
        callKey: `${context.job.id}:image:${index}`,
        title: page.title,
        capability: 'image',
        baseUrl: provider.baseUrl,
        model: provider.model,
        status: 'unknown',
      });
    }
    images.sort((a, b) => a.index - b.index);
    await context.report('rendering', {
      ...context.job.progress,
      images,
      total: pages.length,
      done: index + 1,
    });
  }
  if (images.some((image) => image.status === 'failed'))
    throw new AppError(502, 'PARTIAL_IMAGES', '部分配图失败，已成功的图片保留；重试会跳过已成功图片');
  return { images, model: provider.model };
}
export async function transcribeMedia(context: AutomationContext) {
  const provider = await capabilityProvider(context.db, context.job.workspaceId, 'transcription');
  const asset = await owned<Asset>(
    context.db,
    'assets',
    context.job.workspaceId,
    String(context.input.data.assetId),
  );
  if (!/^(audio|video)\//.test(asset.mime)) throw new AppError(400, 'MEDIA_TYPE', '请选择音频或视频文件');
  await context.report('transcribing', { ...context.job.progress, assetId: asset.id, model: provider.model });
  const form = new FormData();
  form.set('model', provider.model);
  form.set('response_format', 'verbose_json');
  if (context.input.data.language) form.set('language', String(context.input.data.language));
  form.set(
    'file',
    new Blob([new Uint8Array(await readFile(assetPath(context.config.dataDir, asset.storageKey)))], {
      type: asset.mime,
    }),
    asset.filename,
  );
  const response = await boundedJson(
    await capabilityRequest(context.config, provider, '/audio/transcriptions', form, context.signal),
  );
  const parsed = studioSchemas.transcript.safeParse({
    assetId: asset.id,
    language: String(response.language ?? context.input.data.language ?? ''),
    model: provider.model,
    segments: response.segments,
  });
  if (!parsed.success || parsed.data.segments.some((segment) => segment.end <= segment.start))
    throw new AppError(
      502,
      'TRANSCRIPT_TIMESTAMPS',
      '转写服务未返回有效时间片段，请选择支持 verbose_json 时间戳的模型',
    );
  await recordUsage(context.db, {
    workspaceId: context.job.workspaceId,
    accountId: context.job.accountId,
    jobId: context.job.id,
    callKey: `${context.job.id}:transcribe`,
    title: asset.filename,
    capability: 'transcription',
    baseUrl: provider.baseUrl,
    model: provider.model,
    units: typeof response.duration === 'number' ? response.duration / 60 : undefined,
  });
  await context.report('transcribing', { ...context.job.progress, segments: parsed.data.segments.length });
  const result = await context.db.transaction(async (sql) => {
    const transcript = await createItem(sql, context.job.workspaceId, {
      kind: 'transcript',
      name: asset.filename,
      accountId: context.job.accountId,
      data: parsed.data,
    });
    const body = parsed.data.segments
      .map((segment) => `[${segment.start.toFixed(2)}–${segment.end.toFixed(2)} 秒] ${segment.text}`)
      .join('\n\n');
    const material = await importArticle(sql, context.job.workspaceId, context.job.accountId, {
      title: `转写 · ${asset.filename}`.slice(0, 200),
      body,
      author: `${provider.model} 转写`,
    });
    return { transcriptId: transcript.id, materialId: material.materialId };
  });
  return { ...result, assetId: asset.id, segments: parsed.data.segments, model: provider.model };
}
