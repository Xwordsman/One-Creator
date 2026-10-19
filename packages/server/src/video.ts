import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { zipSync, strToU8 } from 'fflate';
import { studioSchemas, type Asset, type StudioItem, type AutomationJob } from '@one-creator/core';
import type { AutomationContext } from './automation-types.js';
import type { Database } from './database.js';
import type { AppConfig } from './config.js';
import { capabilityProvider, capabilityRequest, boundedJson } from './capabilities.js';
import { responseBytes } from './creative-media.js';
import { owned } from './records.js';
import { recordUsage } from './usage.js';
import { storeMedia, storeSubtitle, assetPath } from './files.js';
import { AppError } from './errors.js';

interface MediaOutput {
  name: string;
  role: string;
  mime: string;
  size: number;
  start?: number;
  end?: number;
}
interface RemoteJob {
  id: string;
  status: string;
  stage: string;
  percent: number;
  outputs: MediaOutput[];
  timeline?: unknown;
  error?: string;
  attempt: number;
}
async function narration(context: AutomationContext, text: string, index: number) {
  const provider = await capabilityProvider(context.db, context.job.workspaceId, 'tts');
  try {
    const response = await capabilityRequest(
      context.config,
      provider,
      '/audio/speech',
      {
        model: provider.model,
        input: text,
        voice: provider.options.voice ?? 'alloy',
        response_format: 'mp3',
      },
      context.signal,
    );
    const bytes = await responseBytes(response);
    await recordUsage(context.db, {
      workspaceId: context.job.workspaceId,
      accountId: context.job.accountId,
      jobId: context.job.id,
      callKey: `${context.job.id}:tts:${index}`,
      title: `配音 ${index + 1}`,
      capability: 'tts',
      baseUrl: provider.baseUrl,
      model: provider.model,
      units: [...text].length,
      usageSource: 'estimated',
    });
    return storeMedia(
      context.db,
      context.job.workspaceId,
      context.config.dataDir,
      `narration-${index}.mp3`,
      bytes,
      {
        accountId: context.job.accountId,
        createdBy: context.job.createdBy ?? undefined,
        metadata: {
          jobId: context.job.id,
          kind: 'tts',
          text,
          model: provider.model,
          voice: provider.options.voice ?? 'alloy',
          providerRevision: provider.revision,
        },
      },
    );
  } catch (error) {
    await recordUsage(context.db, {
      workspaceId: context.job.workspaceId,
      accountId: context.job.accountId,
      jobId: context.job.id,
      callKey: `${context.job.id}:tts:${index}`,
      title: `配音 ${index + 1}`,
      capability: 'tts',
      baseUrl: provider.baseUrl,
      model: provider.model,
      status: 'unknown',
    });
    throw error;
  }
}
async function mediaJob(
  context: AutomationContext,
  spec: Record<string, unknown>,
  files: Record<string, string>,
) {
  const provider = await capabilityProvider(context.db, context.job.workspaceId, 'video');
  let serviceJobId = String(context.job.progress.serviceJobId ?? '');
  if (serviceJobId && context.job.progress.serviceBaseUrl !== provider.baseUrl)
    throw new AppError(409, 'VIDEO_PROVIDER_CHANGED', '媒体服务地址已更改，请恢复原服务核对结果或新建任务');
  if (!serviceJobId) {
    const form = new FormData();
    form.set('spec', JSON.stringify(spec));
    for (const [field, assetId] of Object.entries(files)) {
      const asset = await owned<Asset>(context.db, 'assets', context.job.workspaceId, assetId);
      form.set(
        field,
        new Blob([new Uint8Array(await readFile(assetPath(context.config.dataDir, asset.storageKey)))], {
          type: asset.mime,
        }),
        asset.filename,
      );
    }
    const created = await boundedJson(
      await capabilityRequest(context.config, provider, '/jobs', form, context.signal, {
        'Idempotency-Key': context.input.operationId ?? context.job.id,
      }),
    );
    if (typeof created.id !== 'string' || created.id.length > 150)
      throw new AppError(502, 'MEDIA_PROTOCOL', '媒体服务未返回任务 ID');
    serviceJobId = created.id;
    await context.report('rendering_video', {
      ...context.job.progress,
      serviceJobId,
      serviceBaseUrl: provider.baseUrl,
      spec,
    });
  }
  const started = Date.now();
  let state: RemoteJob;
  for (;;) {
    state = (await boundedJson(
      await capabilityRequest(
        context.config,
        provider,
        `/jobs/${encodeURIComponent(serviceJobId)}`,
        undefined,
        context.signal,
      ),
    )) as unknown as RemoteJob;
    if (
      state.status === 'failed' &&
      context.job.parentId &&
      context.job.progress.retriedBy !== context.job.id
    ) {
      await capabilityRequest(
        context.config,
        provider,
        `/jobs/${encodeURIComponent(serviceJobId)}/retry`,
        {},
        context.signal,
      );
      await context.report('rendering_video', { ...context.job.progress, retriedBy: context.job.id });
      continue;
    }
    await context.report(context.job.kind === 'clip_video' ? 'clipping' : 'rendering_video', {
      ...context.job.progress,
      serviceJobId,
      serviceBaseUrl: provider.baseUrl,
      serviceStage: state.stage,
      percent: state.percent,
      serviceStatus: state.status,
    });
    if (state.status === 'succeeded') break;
    if (state.status === 'failed')
      throw new AppError(502, 'VIDEO_FAILED', String(state.error ?? '媒体处理失败').slice(0, 1800));
    if (Date.now() - started > 1800000)
      throw new AppError(504, 'VIDEO_TIMEOUT', '媒体任务仍未结束，任务 ID 已保存，可稍后继续查询');
    await delay(1500, undefined, { signal: context.signal });
  }
  if (!Array.isArray(state.outputs) || !state.outputs.length)
    throw new AppError(502, 'VIDEO_OUTPUT', '媒体服务没有返回产物');
  const outputs = (context.job.progress.outputs ?? []) as (MediaOutput & { assetId: string })[];
  for (const file of state.outputs) {
    if (outputs.some((output) => output.name === file.name)) continue;
    if (!/^[a-zA-Z0-9_-]+\.(mp4|jpg|png|srt)$/.test(file.name))
      throw new AppError(502, 'VIDEO_FILENAME', '媒体服务返回了不支持的文件名');
    const response = await capabilityRequest(
      context.config,
      provider,
      `/jobs/${encodeURIComponent(serviceJobId)}/files/${encodeURIComponent(file.name)}`,
      undefined,
      context.signal,
    );
    const bytes = await responseBytes(response);
    const options = {
      accountId: context.job.accountId,
      createdBy: context.job.createdBy ?? undefined,
      metadata: {
        jobId: context.job.id,
        serviceJobId,
        role: file.role,
        sourceAssetId: context.input.data.assetId ?? null,
        start: file.start ?? null,
        end: file.end ?? null,
        spec,
      },
    };
    const asset = file.name.endsWith('.srt')
      ? await storeSubtitle(
          context.db,
          context.job.workspaceId,
          context.config.dataDir,
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          options,
        )
      : await storeMedia(
          context.db,
          context.job.workspaceId,
          context.config.dataDir,
          file.name,
          bytes,
          options,
        );
    outputs.push({ ...file, assetId: asset.id });
    await context.report('exporting', {
      ...context.job.progress,
      outputs,
      serviceJobId,
      serviceBaseUrl: provider.baseUrl,
    });
  }
  await recordUsage(context.db, {
    workspaceId: context.job.workspaceId,
    accountId: context.job.accountId,
    jobId: context.job.id,
    callKey: `${context.job.id}:video`,
    title: context.job.title,
    capability: 'video',
    baseUrl: provider.baseUrl,
    model: provider.model,
    units: outputs.filter((file) => file.role === 'video').length,
  });
  return {
    outputs,
    serviceJobId,
    timeline: state.timeline ?? null,
    sourceAssetId: context.input.data.assetId ?? null,
    notice: '生成文件与平台上传分别处理；字幕可在脚本或转写中编辑后重新生成。',
  };
}
export async function renderVideo(context: AutomationContext) {
  // Check the video service first so a missing service never leaves paid narration behind.
  await capabilityProvider(context.db, context.job.workspaceId, 'video');
  const script = context.input.references[String(context.input.data.scriptId)] as unknown as StudioItem;
  const data = studioSchemas.video_script.parse(script.data);
  const files: Record<string, string> = {};
  const audioAssetId = context.input.data.audioAssetId as string | null;
  if (audioAssetId) files.audio = audioAssetId;
  const voices = (context.job.progress.voices ?? []) as { index: number; assetId: string }[];
  const scenes = [];
  for (const [index, scene] of data.scenes.entries()) {
    if (scene.imageAssetId) files[`image${index}`] = scene.imageAssetId;
    if (!audioAssetId) {
      let voice = voices.find((voice) => voice.index === index);
      if (!voice) {
        await context.report('synthesizing', {
          ...context.job.progress,
          voices,
          done: index,
          total: data.scenes.length,
        });
        const asset = await narration(context, scene.text, index);
        voice = { index, assetId: asset.id };
        voices.push(voice);
        await context.report('synthesizing', {
          ...context.job.progress,
          voices,
          done: index + 1,
          total: data.scenes.length,
        });
      }
      files[`audio${index}`] = voice.assetId;
    }
    scenes.push({
      image: scene.imageAssetId ? `image${index}` : undefined,
      audio: audioAssetId ? undefined : `audio${index}`,
      caption: scene.caption || scene.text,
      duration: scene.duration,
    });
  }
  return mediaJob(
    context,
    {
      kind: 'render',
      ratio: data.ratio,
      scenes,
      audio: audioAssetId ? 'audio' : undefined,
      scriptRevision: script.revision,
    },
    files,
  );
}
export async function clipVideo(context: AutomationContext) {
  const asset = await owned<Asset>(
    context.db,
    'assets',
    context.job.workspaceId,
    String(context.input.data.assetId),
  );
  if (!asset.mime.startsWith('video/')) throw new AppError(400, 'VIDEO_REQUIRED', '请选择视频文件');
  let subtitles: unknown[] = [];
  if (context.input.data.transcriptId) {
    const transcript = context.input.references[
      String(context.input.data.transcriptId)
    ] as unknown as StudioItem;
    const data = studioSchemas.transcript.parse(transcript.data);
    if (data.assetId !== asset.id) throw new AppError(400, 'TRANSCRIPT_SOURCE', '所选转写不属于这个原视频');
    subtitles = data.segments;
  }
  return mediaJob(
    context,
    { kind: 'clip', media: 'media', segments: context.input.data.segments, subtitles },
    { media: asset.id },
  );
}
export async function exportVideo(
  db: Database,
  config: AppConfig,
  ws: string,
  jobId: string,
  index?: number,
) {
  const job = await owned<AutomationJob>(db, 'automation_jobs', ws, jobId);
  const outputs = (job.result.outputs ?? []) as (MediaOutput & { assetId: string })[];
  const chosen =
    index === undefined
      ? outputs
      : outputs.filter(
          (file) =>
            file.name === `clip-${index}.mp4` ||
            file.name === `cover-${index}.jpg` ||
            file.name === `subtitles-${index}.srt`,
        );
  if (!chosen.length) throw new AppError(400, 'VIDEO_OUTPUT', '没有可导出的媒体产物');
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const file of chosen) {
    const asset = await owned<Asset>(db, 'assets', ws, file.assetId);
    total += asset.size;
    if (total > 150 * 1024 * 1024)
      throw new AppError(400, 'PACKAGE_TOO_LARGE', '发布包超过 150 MB，请选择更少片段');
    files[file.name] = await readFile(assetPath(config.dataDir, asset.storageKey));
  }
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        format: 'one-creator-video-package',
        jobId: job.id,
        sourceAssetId: job.result.sourceAssetId,
        files: chosen,
        createdAt: new Date().toISOString(),
        publication: '生成发布包不表示已在平台发布',
      },
      null,
      2,
    ),
  );
  const input = job.input as unknown as {
    data: Record<string, unknown>;
    references: Record<string, Record<string, unknown>>;
  };
  const segments = (input.data.segments ?? []) as { start: number; end: number; label: string }[];
  const subtitleText = (name: string) =>
    files[name]
      ? new TextDecoder()
          .decode(files[name])
          .split(/\r?\n/)
          .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->'))
          .join(' ')
          .slice(0, 2000)
      : '';
  const seconds = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
  const sections =
    job.kind === 'clip_video'
      ? chosen
          .filter((file) => file.role === 'video')
          .map((file) => {
            const clip = Number(file.name.match(/clip-(\d+)/)?.[1] ?? 0),
              segment = segments[clip];
            return [
              `## 片段 ${clip + 1}${segment?.label ? ` · ${segment.label}` : ''}`,
              `- 原视频区间：${seconds(file.start ?? segment?.start ?? 0)} – ${seconds(file.end ?? segment?.end ?? 0)}`,
              `- 文件：${file.name}、cover-${clip}.jpg、subtitles-${clip}.srt`,
              '',
              subtitleText(`subtitles-${clip}.srt`) || '（本片段没有字幕，可在此补写简介）',
            ].join('\n');
          })
      : [
          (
            studioSchemas.video_script.safeParse(input.references[String(input.data.scriptId)]?.data).data
              ?.scenes ?? []
          )
            .map((scene, index) => `### 场景 ${index + 1}\n\n${scene.text}`)
            .join('\n\n') || subtitleText('subtitles.srt'),
        ];
  // Editable starter copy for the platform upload form; the author still writes the final title and description.
  files['copy.md'] = strToU8(
    [
      `# ${job.title}`,
      '',
      `> 生成于 ${new Date().toISOString()}；发布包不表示已在平台发布，请在平台填写最终标题、简介和标签。`,
      job.result.sourceAssetId ? `\n原视频素材 ID：${String(job.result.sourceAssetId)}` : '',
      '',
      ...sections,
    ].join('\n'),
  );
  return Buffer.from(zipSync(files, { level: 0 }));
}
