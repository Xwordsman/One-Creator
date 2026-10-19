import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import type { Asset, AutomationJob, ContentDocument, Material, StudioItem } from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { startAutomationWorker } from '@one-creator/server/automation';
import { buildApp } from '../apps/api/src/app.js';
import { buildMediaService } from '../apps/media-service/src/service.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('ffprobe-static') as { path: string }).path;

type StoredAsset = Asset & { metadata: Record<string, unknown> };
type Detail = AutomationJob & {
  decisions: { itemKey: string; decision: string; data: Record<string, unknown> }[];
};
interface UsageEntry {
  callKey: string;
  capability: string;
  model: string;
  status: string;
  units: string | number | null;
  usageSource: string;
  jobId: string;
}
interface Output {
  name: string;
  role: string;
  mime: string;
  size: number;
  start?: number;
  end?: number;
  assetId: string;
}

let app: FastifyInstance;
let db: Database;
let config: AppConfig;
let folder: string;
let cookie = '';
let mockServer: Server;
let mockUrl: string;
let media: FastifyInstance;
let mediaUrl: string;
const mediaToken = 'Media-Automation-Test-Token-2026';

// ---------- binary fixtures ----------
let pngSeed = 0;
/** A real, distinct PNG every call, so content-hash de-duplication never merges two generated images. */
function png() {
  const seed = ++pngSeed;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(4 * (1 + 4 * 3));
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      rows.set(
        [(seed * 37) % 256, (seed * 71 + x * 40) % 256, (seed * 13 + y * 50) % 256],
        y * 13 + 1 + x * 3,
      );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function wave() {
  const rate = 8000,
    samples = 16000,
    data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 2000), 44 + i * 2);
  return data;
}
const tool = (args: string[]) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: folder,
    windowsHide: true,
  });
function probe(file: string) {
  const value = JSON.parse(
    execFileSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
      { windowsHide: true },
    ).toString(),
  ) as { format: { duration: string }; streams: { codec_type: string }[] };
  return {
    duration: Number(value.format.duration),
    streams: value.streams.map((stream) => stream.codec_type),
  };
}
const hasBytes = (haystack: Buffer, needle: Buffer) => haystack.indexOf(needle) >= 0;

// ---------- mock OpenAI-compatible providers ----------
const keys = {
  image: 'image-provider-key',
  transcription: 'transcription-provider-key',
  text: 'text-provider-key',
  tts: 'tts-provider-key',
};
const audioSegments = [
  { id: 0, start: 0, end: 1.2, text: '大家好，今天聊聊自媒体选题。', avg_logprob: -0.2 },
  { id: 1, start: 1.2, end: 2, text: '先从读者真正关心的问题开始。', avg_logprob: -0.1 },
];
const videoSegments = [
  { start: 0, end: 1, text: '第一句画面说明' },
  { start: 1, end: 2.2, text: '第二句承接' },
  { start: 2.2, end: 3, text: '第三句收尾' },
];
const mock = {
  generations: [] as string[],
  edits: [] as { prompt: string; hasReference: boolean }[],
  downloads: 0,
  unstableFailures: 0,
  files: new Map<string, Buffer>(),
  issued: new Map<string, Buffer>(),
  transcriptionMode: 'valid' as 'valid' | 'missing' | 'reversed',
  transcriptions: [] as { verbose: boolean; kind: 'audio' | 'video' | 'other' }[],
  chats: [] as { model: string; messages: { role: string; content: string }[] }[],
  speeches: [] as { model: string; input: string; voice: string; response_format: string }[],
  voices: new Map<string, Buffer>(),
  referencePng: Buffer.alloc(0),
};
function body(request: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
const pageKey = (prompt: string) => prompt.split(/\r?\n/)[0];
async function handleMock(
  request: IncomingMessage,
  raw: Buffer,
): Promise<{ status: number; json?: unknown; bytes?: Buffer; type?: string }> {
  const url = request.url ?? '';
  const auth = request.headers.authorization ?? '';
  if (url.startsWith('/files/')) {
    const file = mock.files.get(url.slice('/files/'.length));
    if (!file) return { status: 404 };
    mock.downloads++;
    return { status: 200, bytes: file, type: 'image/png' };
  }
  if (url === '/v1/images/generations') {
    if (auth !== `Bearer ${keys.image}`) return { status: 401 };
    const input = JSON.parse(raw.toString('utf8')) as {
      prompt: string;
      response_format: string;
      model: string;
    };
    mock.generations.push(input.prompt);
    if (input.prompt.includes('[unstable]') && mock.unstableFailures-- > 0)
      return { status: 500, json: { error: 'temporary overload' } };
    const bytes = png();
    mock.issued.set(pageKey(input.prompt), bytes);
    if (input.prompt.includes('[download]')) {
      const name = `${id()}.png`;
      mock.files.set(name, bytes);
      return {
        status: 200,
        json: { created: 1, data: [{ url: `${mockUrl.replace(/\/v1$/, '')}/files/${name}` }] },
      };
    }
    return { status: 200, json: { created: 1, data: [{ b64_json: bytes.toString('base64') }] } };
  }
  if (url === '/v1/images/edits') {
    if (auth !== `Bearer ${keys.image}`) return { status: 401 };
    const text = raw.toString('utf8');
    const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] ?? '';
    mock.edits.push({
      prompt,
      hasReference: hasBytes(raw, mock.referencePng) && /name="image"; filename=/.test(text),
    });
    const bytes = png();
    mock.issued.set(pageKey(prompt), bytes);
    return { status: 200, json: { created: 1, data: [{ b64_json: bytes.toString('base64') }] } };
  }
  if (url === '/v1/audio/transcriptions') {
    if (auth !== `Bearer ${keys.transcription}`) return { status: 401 };
    const text = raw.toString('latin1');
    const verbose =
      /name="response_format"\r\n\r\nverbose_json\r\n/.test(text) && /name="file"; filename=/.test(text);
    const kind = text.includes('WAVEfmt ') ? 'audio' : text.includes('ftyp') ? 'video' : 'other';
    mock.transcriptions.push({ verbose, kind });
    if (mock.transcriptionMode === 'missing')
      return { status: 200, json: { text: '只有文本，没有时间戳', language: 'zh' } };
    if (mock.transcriptionMode === 'reversed')
      return {
        status: 200,
        json: { text: '时间错误', language: 'zh', segments: [{ start: 2, end: 1, text: '时间颠倒' }] },
      };
    return {
      status: 200,
      json: {
        task: 'transcribe',
        language: 'zh',
        duration: kind === 'video' ? 3 : 2,
        text: '转写全文',
        segments: kind === 'video' ? videoSegments : audioSegments,
      },
    };
  }
  if (url === '/v1/chat/completions') {
    if (auth !== `Bearer ${keys.text}`) return { status: 401 };
    const input = JSON.parse(raw.toString('utf8')) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    mock.chats.push(input);
    const script = {
      ratio: '1:1',
      style: '口播 + 文字卡片',
      scenes: [
        { text: audioSegments[0].text, caption: '自媒体选题从哪里开始', duration: 1, imageAssetId: null },
        { text: audioSegments[1].text, caption: '先回答读者的问题', duration: 1, imageAssetId: null },
      ],
    };
    return {
      status: 200,
      json: {
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(script)}\n\`\`\`` } }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      },
    };
  }
  if (url === '/v1/audio/speech') {
    if (auth !== `Bearer ${keys.tts}`) return { status: 401 };
    const input = JSON.parse(raw.toString('utf8')) as {
      model: string;
      input: string;
      voice: string;
      response_format: string;
    };
    mock.speeches.push(input);
    const voice = mock.voices.get(input.input);
    if (!voice) return { status: 400, json: { error: 'unexpected narration text' } };
    return { status: 200, bytes: voice, type: 'audio/mpeg' };
  }
  return { status: 404 };
}

// ---------- API helpers ----------
const request = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { cookie, 'x-creator-client': 'web', ...headers },
  });
const automation = async (jobId: string) => (await request('GET', `/api/automation/${jobId}`)).json<Detail>();
async function create(
  kind: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  key = id(),
) {
  const response = await request(
    'POST',
    '/api/automation',
    { kind, data, ...extra },
    { 'idempotency-key': key },
  );
  expect(response.statusCode, response.body).toBe(202);
  return response.json<AutomationJob>();
}
async function retry(jobId: string, key = id()) {
  const response = await request('POST', `/api/automation/${jobId}/retry`, {}, { 'idempotency-key': key });
  expect(response.statusCode, response.body).toBe(202);
  return response.json<AutomationJob>();
}
/** Drive the automation worker deterministically until the job reaches a terminal state. */
async function settle(jobId: string, status: AutomationJob['status'], timeout = 90000) {
  const worker = startAutomationWorker(db, config, 1000000);
  const deadline = Date.now() + timeout;
  let job = await automation(jobId);
  try {
    while (!['succeeded', 'failed', 'cancelled', 'needs_verification'].includes(job.status)) {
      if (Date.now() > deadline)
        throw new Error(`任务 ${jobId} 未在 ${timeout} ms 内结束，当前 ${job.status}/${job.stage}`);
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await automation(jobId);
    }
  } finally {
    await worker.stop();
  }
  expect(job.status, job.error).toBe(status);
  return job;
}
async function provider(capability: string, input: Record<string, unknown>) {
  const current = (await request('GET', '/api/settings/providers'))
    .json<{ items: { capability: string; revision: number }[] }>()
    .items.find((item) => item.capability === capability);
  const response = await request('PUT', `/api/settings/providers/${capability}`, {
    options: {},
    ...input,
    expectedRevision: current?.revision ?? 0,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ revision: number; hasKey: boolean }>();
}
async function upload(url: string, filename: string, mime: string, bytes: Buffer) {
  const boundary = `media-automation-${id()}`;
  return app.inject({
    method: 'POST',
    url,
    headers: {
      cookie,
      'x-creator-client': 'web',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const assets = async () =>
  new Map(
    (await request('GET', '/api/assets?limit=500'))
      .json<{ items: StoredAsset[] }>()
      .items.map((asset) => [asset.id, asset]),
  );
const usage = async (jobId: string) =>
  (await request('GET', `/api/usage?jobId=${jobId}&limit=200`)).json<{ items: UsageEntry[] }>().items;
const assetBytes = async (assetId: string) => {
  const response = await request('GET', `/api/assets/${assetId}`);
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
};

beforeAll(async () => {
  await mkdir('.data/test-temp', { recursive: true });
  folder = await mkdtemp(path.resolve('.data/test-temp/media-automation-'));
  mockServer = createServer((incoming, response) => {
    body(incoming)
      .then((raw) => handleMock(incoming, raw))
      .then((result) => {
        if (result.bytes) {
          response.writeHead(result.status, {
            'Content-Type': result.type ?? 'application/octet-stream',
            'Content-Length': result.bytes.length,
          });
          response.end(result.bytes);
        } else {
          response.writeHead(result.status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(result.json ?? {}));
        }
      })
      .catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockOrigin = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;
  mockUrl = `${mockOrigin}/v1`;
  // The real FFmpeg media service, exactly as deployed beside the API.
  media = await buildMediaService({
    dataDir: path.join(folder, 'media-service'),
    token: mediaToken,
    ffmpeg,
    ffprobe,
  });
  const mediaAddress = await media.listen({ port: 0, host: '127.0.0.1' });
  mediaUrl = `${mediaAddress}/v1`;
  // Narration with distinct lengths per scene, and a short source video for slicing.
  tool([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1.2',
    '-ac',
    '1',
    '-ar',
    '22050',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '48k',
    'voice-0.mp3',
  ]);
  tool([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=1.5',
    '-ac',
    '1',
    '-ar',
    '22050',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '48k',
    'voice-1.mp3',
  ]);
  tool([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=15:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    'source.mp4',
  ]);
  mock.voices.set(audioSegments[0].text, await readFile(path.join(folder, 'voice-0.mp3')));
  mock.voices.set(audioSegments[1].text, await readFile(path.join(folder, 'voice-1.mp3')));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'ef'.repeat(32),
    production: false,
    workerMode: 'inline',
    integrationOrigins: [mockOrigin],
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'media', name: '媒体验证', password: 'Media-Automation-Password' },
  });
  expect(setup.statusCode, setup.body).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  await media?.close();
  if (mockServer) await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('AI 封面与配图（FMT-04，模拟图片服务）', () => {
  let doc: ContentDocument;
  let reference: Asset;
  let first: Detail;
  let second: Detail;
  const pages = [
    { title: '封面 [b64]', prompt: '一张温暖的书桌封面' },
    { title: '配图 [download]', prompt: '城市夜景插画' },
    { title: '配图 [unstable]', prompt: '咖啡与笔记本' },
    { title: '参考图重绘 [edit]', prompt: '保留构图，改成水彩风格' },
  ];

  it('逐张生成并保存参数版本；部分失败保留已成功图片，任务明确失败', async () => {
    const created = await request('POST', '/api/documents', { title: '配图验证稿', body: '正文第一段。' });
    expect(created.statusCode, created.body).toBe(201);
    doc = created.json<ContentDocument>();
    mock.referencePng = png();
    const uploaded = await upload('/api/assets', 'reference.png', 'image/png', mock.referencePng);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    reference = uploaded.json<Asset>();
    const saved = await provider('image', {
      name: '模拟图片',
      baseUrl: mockUrl,
      model: 'mock-image-1',
      apiKey: keys.image,
      options: { size: '512x512' },
    });
    expect(saved.revision).toBe(1);
    expect(saved.hasKey).toBe(true);

    mock.unstableFailures = 1;
    const job = await create(
      'images',
      {
        pages: pages.map((page, index) => ({ ...page, referenceAssetId: index === 3 ? reference.id : null })),
        style: '低饱和、留白',
      },
      { documentId: doc.id },
    );
    first = await settle(job.id, 'failed');
    expect(first.error).toBe('部分配图失败，已成功的图片保留；重试会跳过已成功图片');
    const images = first.progress.images as {
      index: number;
      status: string;
      assetId?: string;
      error?: string;
      prompt?: string;
      model?: string;
      providerRevision?: number;
    }[];
    expect(images.map((image) => [image.index, image.status])).toEqual([
      [0, 'succeeded'],
      [1, 'succeeded'],
      [2, 'failed'],
      [3, 'succeeded'],
    ]);
    expect(images[2].error).toBe('服务返回 HTTP 500：temporary overload');
    expect(mock.generations).toHaveLength(3);
    expect(mock.edits).toHaveLength(1);
    expect(mock.edits[0].hasReference).toBe(true);
    expect(mock.downloads).toBe(1);

    const stored = await assets();
    for (const image of images.filter((row) => row.status === 'succeeded')) {
      const page = pages[image.index];
      const asset = stored.get(image.assetId!)!;
      expect(asset.mime).toBe('image/png');
      expect(asset.metadata).toMatchObject({
        kind: 'ai_image',
        jobId: job.id,
        model: 'mock-image-1',
        providerRevision: 1,
        referenceAssetId: image.index === 3 ? reference.id : null,
      });
      expect(asset.metadata.prompt).toBe(`${page.title}\n${page.prompt}\n视觉要求：低饱和、留白`);
      expect(image).toMatchObject({
        model: 'mock-image-1',
        providerRevision: 1,
        prompt: asset.metadata.prompt,
      });
      // The stored file is exactly what the provider returned, whether inline base64 or a downloaded URL.
      expect((await assetBytes(asset.id)).equals(mock.issued.get(page.title)!)).toBe(true);
    }

    const entries = await usage(job.id);
    expect(entries.filter((entry) => entry.capability === 'image')).toHaveLength(4);
    expect(entries.find((entry) => entry.callKey === `${job.id}:image:2`)?.status).toBe('unknown');
    expect(
      entries
        .filter((entry) => entry.status === 'succeeded')
        .map((entry) => entry.callKey)
        .sort(),
    ).toEqual([0, 1, 3].map((index) => `${job.id}:image:${index}`));
    expect(entries.every((entry) => entry.model === 'mock-image-1')).toBe(true);
  });

  it('重试只补生成失败的那张，已成功图片不重复生成', async () => {
    const key = id();
    const job = await retry(first.id, key);
    expect(job.parentId).toBe(first.id);
    expect(job.attempt).toBe(2);
    expect((await retry(first.id, key)).id).toBe(job.id);
    second = await settle(job.id, 'succeeded');
    expect(mock.generations).toHaveLength(4);
    expect(mock.generations[3]).toContain('配图 [unstable]');
    expect(mock.edits).toHaveLength(1);
    expect(mock.downloads).toBe(1);
    const images = second.result.images as { index: number; status: string; assetId: string }[];
    expect(images.every((image) => image.status === 'succeeded')).toBe(true);
    // Results stay in page order after a retry, so "第 N 张" and the adoption order match the outline.
    expect(images.map((image) => image.index)).toEqual([0, 1, 2, 3]);
    const before = first.progress.images as { index: number; assetId?: string }[];
    for (const index of [0, 1, 3]) expect(images[index].assetId).toBe(before[index].assetId);
    const entries = await usage(job.id);
    expect(entries.map((entry) => [entry.callKey, entry.status])).toEqual([
      [`${job.id}:image:2`, 'succeeded'],
    ]);
  });

  it('只把所选图片加入文稿，并核对文稿版本', async () => {
    const images = second.result.images as { index: number; assetId: string }[];
    const selection = { action: 'images', data: { indices: [0, 2] } };
    const current = (await request('GET', `/api/documents/${doc.id}`)).json<ContentDocument>();
    const stale = await request('POST', `/api/automation/${second.id}/apply`, {
      ...selection,
      expectedRevision: current.revision + 1,
    });
    expect(stale.statusCode).toBe(409);
    const applied = await request('POST', `/api/automation/${second.id}/apply`, {
      ...selection,
      expectedRevision: current.revision,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const updated = applied.json<ContentDocument>();
    expect(updated.revision).toBe(current.revision + 1);
    expect(updated.assetIds).toEqual([images[0].assetId, images[2].assetId]);
    expect(updated.assetIds).not.toContain(images[1].assetId);
    expect(updated.assetIds).not.toContain(images[3].assetId);
    // The same choice repeated is idempotent; it never adds images twice or bumps the revision again.
    const repeated = await request('POST', `/api/automation/${second.id}/apply`, {
      ...selection,
      expectedRevision: current.revision,
    });
    expect(repeated.json<ContentDocument>().revision).toBe(updated.revision);
    expect((await request('GET', `/api/documents/${doc.id}`)).json<ContentDocument>().assetIds).toEqual(
      updated.assetIds,
    );
    expect((await automation(second.id)).decisions.map((decision) => decision.itemKey)).toEqual(['images:0']);
  });

  it('可单张重新生成：只重画选中的页，其他图片与已采用的图片保持不变', async () => {
    const data = second.input.data as Record<string, unknown>;
    const before = second.result.images as { index: number; assetId: string }[];
    const calls = mock.generations.length + mock.edits.length;
    expect(
      (
        await request(
          'POST',
          '/api/automation',
          { kind: 'images', documentId: doc.id, data: { ...data, regenerate: [1] } },
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(400);
    const changed = await request(
      'POST',
      '/api/automation',
      {
        kind: 'images',
        documentId: doc.id,
        parentId: second.id,
        data: { ...data, style: '换一种风格', regenerate: [1] },
      },
      { 'idempotency-key': id() },
    );
    expect(changed.statusCode).toBe(409);
    const job = await create(
      'images',
      { ...data, regenerate: [1] },
      { documentId: doc.id, parentId: second.id },
    );
    const third = await settle(job.id, 'succeeded');
    expect(mock.generations.length + mock.edits.length).toBe(calls + 1);
    const images = third.result.images as { index: number; assetId: string }[];
    expect(images.map((image) => image.index)).toEqual([0, 1, 2, 3]);
    for (const index of [0, 2, 3]) expect(images[index].assetId).toBe(before[index].assetId);
    expect(images[1].assetId).not.toBe(before[1].assetId);
    expect((await request('GET', `/api/documents/${doc.id}`)).json<ContentDocument>().assetIds).toEqual([
      before[0].assetId,
      before[2].assetId,
    ]);
  });
});

// Resources produced by VID-01 and reused by the video steps that follow.
let audio: Asset;
let transcript: StudioItem;
let script: StudioItem;
let renderJob: Detail;

describe('音视频转写与脚本（VID-01，模拟转写与文本模型）', () => {
  it('导入音频后生成带时间片段的转写，并进入素材库', async () => {
    const uploaded = await upload('/api/media', 'interview.wav', 'audio/wav', wave());
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    audio = uploaded.json<Asset>();
    expect(audio.mime).toBe('audio/wav');
    await provider('transcription', {
      name: '模拟转写',
      baseUrl: mockUrl,
      model: 'mock-whisper',
      apiKey: keys.transcription,
    });
    mock.transcriptionMode = 'valid';
    const job = await settle(
      (await create('transcribe', { assetId: audio.id, language: 'zh' })).id,
      'succeeded',
    );
    expect(mock.transcriptions.at(-1)).toEqual({ verbose: true, kind: 'audio' });
    expect(job.result.segments).toEqual(audioSegments.map(({ start, end, text }) => ({ start, end, text })));
    transcript = (await request('GET', `/api/studio/items/${job.result.transcriptId}`)).json<StudioItem>();
    expect(transcript.kind).toBe('transcript');
    expect(transcript.data).toEqual({
      assetId: audio.id,
      language: 'zh',
      model: 'mock-whisper',
      segments: audioSegments.map(({ start, end, text }) => ({ start, end, text })),
    });
    const materials = (
      await request('GET', `/api/materials?q=${encodeURIComponent('转写 · interview.wav')}`)
    ).json<{ items: Material[] }>().items;
    expect(materials.map((material) => material.id)).toEqual([job.result.materialId]);
    expect(materials[0].body).toContain(`[0.00–1.20 秒] ${audioSegments[0].text}`);
    expect(materials[0].body).toContain(`[1.20–2.00 秒] ${audioSegments[1].text}`);
    const entries = await usage(job.id);
    expect(entries.map((entry) => [entry.capability, entry.model, entry.status])).toEqual([
      ['transcription', 'mock-whisper', 'succeeded'],
    ]);
    expect(Number(entries[0].units)).toBeCloseTo(2 / 60, 4);
  });

  it('服务没有返回或返回无效时间戳时明确失败，原媒体保留', async () => {
    const before = (await request('GET', '/api/studio/items?kind=transcript')).json<{ total: number }>()
      .total;
    for (const mode of ['missing', 'reversed'] as const) {
      mock.transcriptionMode = mode;
      const job = await settle(
        (await create('transcribe', { assetId: audio.id, language: 'zh' })).id,
        'failed',
      );
      expect(job.error).toBe('转写服务未返回有效时间片段，请选择支持 verbose_json 时间戳的模型');
    }
    mock.transcriptionMode = 'valid';
    expect((await request('GET', '/api/studio/items?kind=transcript')).json<{ total: number }>().total).toBe(
      before,
    );
    expect((await assetBytes(audio.id)).equals(wave())).toBe(true);
  });

  it('由转写生成视频脚本，采用后保存为可编辑的脚本', async () => {
    const missingModel = await request(
      'POST',
      '/api/automation',
      { kind: 'video_script', data: { transcriptId: transcript.id, goal: '剪成 30 秒口播' } },
      { 'idempotency-key': id() },
    );
    expect(missingModel.statusCode).toBe(400);
    expect(missingModel.json().code).toBe('MODEL_NOT_CONFIGURED');
    const model = await request('PUT', '/api/settings/model', {
      name: '模拟文本模型',
      baseUrl: mockUrl,
      model: 'mock-chat',
      apiKey: keys.text,
    });
    expect(model.statusCode, model.body).toBe(200);
    const job = await settle(
      (await create('video_script', { transcriptId: transcript.id, goal: '剪成 30 秒口播' })).id,
      'succeeded',
    );
    const prompt = mock.chats.at(-1)!;
    expect(prompt.model).toBe('mock-chat');
    expect(prompt.messages[1].content).toContain(audioSegments[0].text);
    expect(prompt.messages[1].content).toContain('剪成 30 秒口播');
    expect(job.result.source).toEqual({
      id: transcript.id,
      revision: transcript.revision,
      assetId: audio.id,
    });
    expect((job.result.script as { transcriptId: string }).transcriptId).toBe(transcript.id);
    const applied = await request('POST', `/api/automation/${job.id}/apply`, {
      action: 'script',
      data: { name: '选题口播脚本' },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    script = applied.json<StudioItem>();
    expect(script).toMatchObject({ kind: 'video_script', name: '选题口播脚本', revision: 1 });
    expect(script.data).toMatchObject({
      transcriptId: transcript.id,
      ratio: '1:1',
      scenes: [
        { text: audioSegments[0].text, caption: '自媒体选题从哪里开始' },
        { text: audioSegments[1].text },
      ],
    });
    expect((await usage(job.id)).map((entry) => [entry.capability, entry.status])).toEqual([
      ['text', 'succeeded'],
    ]);
    // The saved script stays editable like any other studio resource.
    const scenes = (script.data.scenes as Record<string, unknown>[]).map((scene, index) =>
      index === 1 ? { ...scene, caption: '先回答：读者关心什么' } : scene,
    );
    const edited = await request('PUT', `/api/studio/items/${script.id}`, {
      kind: 'video_script',
      name: script.name,
      accountId: null,
      data: { ...script.data, scenes },
      expectedRevision: script.revision,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<StudioItem>().revision).toBe(2);
    expect(
      (
        await request('PUT', `/api/studio/items/${script.id}`, {
          kind: 'video_script',
          name: script.name,
          accountId: null,
          data: script.data,
          expectedRevision: script.revision,
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('脚本到短视频合成（VID-02，真实 FFmpeg 媒体服务）', () => {
  it('未配置视频服务时任务明确失败而不是崩溃；配置后重试不重复配音并输出视频、封面和字幕', async () => {
    expect(script?.id).toBeTruthy();
    const scene = await upload('/api/assets', 'scene.png', 'image/png', png());
    expect(scene.statusCode, scene.body).toBe(201);
    const current = (await request('GET', `/api/studio/items/${script.id}`)).json<StudioItem>();
    const scenes = (current.data.scenes as Record<string, unknown>[]).map((row, index) =>
      index === 0 ? { ...row, imageAssetId: scene.json<Asset>().id } : row,
    );
    const withImage = await request('PUT', `/api/studio/items/${current.id}`, {
      kind: 'video_script',
      name: current.name,
      accountId: null,
      data: { ...current.data, scenes },
      expectedRevision: current.revision,
    });
    expect(withImage.statusCode, withImage.body).toBe(200);

    await provider('tts', {
      name: '模拟配音',
      baseUrl: mockUrl,
      model: 'mock-tts',
      apiKey: keys.tts,
      options: { voice: 'nova' },
    });
    const missing = await settle((await create('render_video', { scriptId: script.id })).id, 'failed');
    expect(missing.error).toBe('请先在设置中配置「视频服务」服务');
    // The service check runs before narration, so a missing video service costs no speech calls.
    expect(mock.speeches).toHaveLength(0);

    // A wrong media token fails after narration; the retry must reuse both clips instead of paying again.
    await provider('video', {
      name: '本地媒体服务',
      baseUrl: mediaUrl,
      model: 'one-creator-media-v1',
      apiKey: 'wrong-media-service-token',
    });
    const failed = await settle((await create('render_video', { scriptId: script.id })).id, 'failed');
    expect(failed.error).toBe('服务拒绝访问，请核对 API Key 和模型权限');
    expect(mock.speeches).toHaveLength(2);
    expect(mock.speeches.map((speech) => [speech.model, speech.voice, speech.response_format])).toEqual([
      ['mock-tts', 'nova', 'mp3'],
      ['mock-tts', 'nova', 'mp3'],
    ]);
    expect((failed.progress.voices as unknown[]).length).toBe(2);

    await provider('video', {
      name: '本地媒体服务',
      baseUrl: mediaUrl,
      model: 'one-creator-media-v1',
      apiKey: mediaToken,
    });
    const tested = await request('POST', '/api/settings/providers/video/test', {});
    expect(tested.statusCode, tested.body).toBe(200);
    renderJob = await settle((await retry(failed.id)).id, 'succeeded', 150000);
    expect(mock.speeches).toHaveLength(2);

    const outputs = renderJob.result.outputs as Output[];
    expect(outputs.map((file) => [file.name, file.role, file.mime])).toEqual([
      ['video.mp4', 'video', 'video/mp4'],
      ['cover.jpg', 'cover', 'image/jpeg'],
      ['subtitles.srt', 'subtitles', 'application/x-subrip'],
    ]);
    const stored = await assets();
    for (const file of outputs) {
      const asset = stored.get(file.assetId)!;
      expect(asset.metadata).toMatchObject({
        jobId: renderJob.id,
        role: file.role,
        serviceJobId: renderJob.result.serviceJobId,
      });
      expect(asset.size).toBe(file.size);
    }
    expect(stored.get(outputs[0].assetId)!.mime).toBe('video/mp4');
    expect(stored.get(outputs[1].assetId)!.mime).toBe('image/jpeg');
    const video = await assetBytes(outputs[0].assetId);
    expect(video.subarray(4, 8).toString()).toBe('ftyp');
    expect((await assetBytes(outputs[1].assetId))[0]).toBe(255);
    const subtitles = (await assetBytes(outputs[2].assetId)).toString('utf8');
    expect(subtitles).toContain('00:00:00,000 --> ');
    expect(subtitles).toContain('自媒体选题从哪里开始');
    expect(subtitles).toContain('先回答：读者关心什么');
    await writeFile(path.join(folder, 'rendered.mp4'), video);
    const rendered = probe(path.join(folder, 'rendered.mp4'));
    expect(rendered.streams).toEqual(expect.arrayContaining(['video', 'audio']));
    expect(rendered.duration).toBeGreaterThan(2.4);
    expect(rendered.duration).toBeLessThan(4);

    // Parameters, progress and the timeline stay inspectable on the job.
    const spec = renderJob.progress.spec as {
      kind: string;
      ratio: string;
      scenes: { image?: string; audio?: string; caption: string }[];
    };
    expect(spec).toMatchObject({
      kind: 'render',
      ratio: '1:1',
      scenes: [
        { image: 'image0', audio: 'audio0', caption: '自媒体选题从哪里开始' },
        { audio: 'audio1', caption: '先回答：读者关心什么' },
      ],
    });
    expect(renderJob.progress).toMatchObject({
      serviceStatus: 'succeeded',
      percent: 100,
      serviceBaseUrl: mediaUrl,
    });
    expect(renderJob.result.timeline).toHaveLength(2);
    const voices = renderJob.progress.voices as { index: number; assetId: string }[];
    expect(voices.map((voice) => stored.get(voice.assetId)!.metadata)).toEqual([
      expect.objectContaining({
        kind: 'tts',
        text: audioSegments[0].text,
        voice: 'nova',
        model: 'mock-tts',
        providerRevision: 1,
        jobId: failed.id,
      }),
      expect.objectContaining({
        kind: 'tts',
        text: audioSegments[1].text,
        voice: 'nova',
        model: 'mock-tts',
        providerRevision: 1,
        jobId: failed.id,
      }),
    ]);
    expect(voices.map((voice) => stored.get(voice.assetId)!.mime)).toEqual(['audio/mpeg', 'audio/mpeg']);
    expect(
      (await usage(failed.id))
        .filter((entry) => entry.capability === 'tts')
        .map((entry) => [entry.status, entry.usageSource]),
    ).toEqual([
      ['succeeded', 'estimated'],
      ['succeeded', 'estimated'],
    ]);
    expect(
      (await usage(renderJob.id)).map((entry) => [entry.capability, entry.model, Number(entry.units)]),
    ).toEqual([['video', 'one-creator-media-v1', 1]]);
  }, 180000);

  it('导出发布包包含清单、视频、封面和字幕，并声明生成不等于平台发布', async () => {
    expect(renderJob?.status).toBe('succeeded');
    expect(renderJob.result.notice).toContain('生成文件与平台上传分别处理');
    const exported = await request('GET', `/api/automation/${renderJob.id}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/zip');
    const files = unzipSync(exported.rawPayload);
    expect(Object.keys(files).sort()).toEqual([
      'copy.md',
      'cover.jpg',
      'manifest.json',
      'subtitles.srt',
      'video.mp4',
    ]);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest).toMatchObject({
      format: 'one-creator-video-package',
      jobId: renderJob.id,
      publication: '生成发布包不表示已在平台发布',
    });
    expect(manifest.files.map((file: Output) => file.name)).toEqual([
      'video.mp4',
      'cover.jpg',
      'subtitles.srt',
    ]);
    expect(
      Buffer.from(files['video.mp4']).equals(
        await assetBytes((renderJob.result.outputs as Output[])[0].assetId),
      ),
    ).toBe(true);
    const copy = strFromU8(files['copy.md']);
    expect(copy).toContain('### 场景 1');
    expect(copy).toContain('不表示已在平台发布');
  });
});

describe('长视频切片与发布包（VID-03，真实 FFmpeg 媒体服务）', () => {
  let source: Asset;
  let sourceTranscript: StudioItem;
  let clipJob: Detail;

  it('按片段切出视频、封面和字幕，记录原视频时间区间', async () => {
    const uploaded = await upload(
      '/api/media',
      'long-video.mp4',
      'video/mp4',
      await readFile(path.join(folder, 'source.mp4')),
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    source = uploaded.json<Asset>();
    expect(source.mime).toBe('video/mp4');
    const transcribed = await settle(
      (await create('transcribe', { assetId: source.id, language: 'zh' })).id,
      'succeeded',
    );
    expect(mock.transcriptions.at(-1)).toEqual({ verbose: true, kind: 'video' });
    sourceTranscript = (
      await request('GET', `/api/studio/items/${transcribed.result.transcriptId}`)
    ).json<StudioItem>();
    expect(sourceTranscript.data.assetId).toBe(source.id);

    const segments = [
      { start: 0.5, end: 1.5, label: '开场' },
      { start: 1.8, end: 2.8, label: '收尾' },
    ];
    clipJob = await settle(
      (await create('clip_video', { assetId: source.id, segments, transcriptId: sourceTranscript.id })).id,
      'succeeded',
      120000,
    );
    const outputs = clipJob.result.outputs as Output[];
    expect(clipJob.result.sourceAssetId).toBe(source.id);
    expect(outputs.map((file) => file.name)).toEqual([
      'clip-0.mp4',
      'cover-0.jpg',
      'subtitles-0.srt',
      'clip-1.mp4',
      'cover-1.jpg',
      'subtitles-1.srt',
    ]);
    expect(outputs.filter((file) => file.role === 'video').map((file) => [file.start, file.end])).toEqual([
      [0.5, 1.5],
      [1.8, 2.8],
    ]);
    const stored = await assets();
    for (const [index, segment] of segments.entries()) {
      const clip = outputs.find((file) => file.name === `clip-${index}.mp4`)!;
      expect(stored.get(clip.assetId)!.metadata).toMatchObject({
        jobId: clipJob.id,
        role: 'video',
        sourceAssetId: source.id,
        start: segment.start,
        end: segment.end,
      });
      for (const name of [`cover-${index}.jpg`, `subtitles-${index}.srt`])
        expect(stored.get(outputs.find((file) => file.name === name)!.assetId)!.metadata).toMatchObject({
          jobId: clipJob.id,
          sourceAssetId: source.id,
        });
      await writeFile(path.join(folder, `clip-${index}.mp4`), await assetBytes(clip.assetId));
      expect(probe(path.join(folder, `clip-${index}.mp4`)).duration).toBeCloseTo(1, 0);
    }
    const subtitles = async (index: number) =>
      (await assetBytes(outputs.find((file) => file.name === `subtitles-${index}.srt`)!.assetId)).toString(
        'utf8',
      );
    const first = await subtitles(0);
    expect(first).toContain('00:00:00,000 --> 00:00:00,500\n第一句画面说明');
    expect(first).toContain('00:00:00,500 --> 00:00:01,000\n第二句承接');
    expect(first).not.toContain('第三句收尾');
    const second = await subtitles(1);
    expect(second).toContain('00:00:00,000 --> 00:00:00,400\n第二句承接');
    expect(second).toContain('00:00:00,400 --> 00:00:01,000\n第三句收尾');
    expect(second).not.toContain('第一句画面说明');
    expect((await usage(clipJob.id)).map((entry) => [entry.capability, Number(entry.units)])).toEqual([
      ['video', 2],
    ]);
  }, 180000);

  it('按片段导出只包含该片段的视频、封面和字幕', async () => {
    expect(clipJob?.status).toBe('succeeded');
    const exported = await request('GET', `/api/automation/${clipJob.id}/export?index=0`);
    expect(exported.statusCode).toBe(200);
    const files = unzipSync(exported.rawPayload);
    expect(Object.keys(files).sort()).toEqual([
      'clip-0.mp4',
      'copy.md',
      'cover-0.jpg',
      'manifest.json',
      'subtitles-0.srt',
    ]);
    // The copy is per clip: label, the original time range and the clip's own subtitle text.
    const copy = strFromU8(files['copy.md']);
    expect(copy).toContain('## 片段 1 · 开场');
    expect(copy).toContain('原视频区间：0:00.5 – 0:01.5');
    expect(copy).not.toContain('收尾');
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest.sourceAssetId).toBe(source.id);
    expect(manifest.publication).toBe('生成发布包不表示已在平台发布');
    expect(manifest.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'clip-0.mp4', start: 0.5, end: 1.5 })]),
    );
    expect(manifest.files).toHaveLength(3);
    expect(strFromU8(files['subtitles-0.srt'])).toContain('第一句画面说明');
    expect((await request('GET', `/api/automation/${clipJob.id}/export?index=5`)).statusCode).toBe(400);
  });

  it('片段超出原视频时长或转写不属于原视频时明确失败', async () => {
    const outside = await settle(
      (
        await create('clip_video', {
          assetId: source.id,
          segments: [{ start: 1, end: 30, label: '过长' }],
          transcriptId: null,
        })
      ).id,
      'failed',
      60000,
    );
    expect(outside.error).toBe('片段区间超出原视频时长');
    expect(outside.result.outputs).toBeUndefined();
    // The VID-01 transcript belongs to the uploaded audio, not to this video.
    expect(transcript.data.assetId).toBe(audio.id);
    // Mismatched sources and reversed ranges are rejected before any job or media upload exists.
    const mismatched = await request(
      'POST',
      '/api/automation',
      {
        kind: 'clip_video',
        data: {
          assetId: source.id,
          segments: [{ start: 0, end: 1, label: '错配' }],
          transcriptId: transcript.id,
        },
      },
      { 'idempotency-key': id() },
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().message).toBe('所选转写不属于这个原视频');
    const reversed = await request(
      'POST',
      '/api/automation',
      {
        kind: 'clip_video',
        data: { assetId: source.id, segments: [{ start: 2, end: 1, label: '倒序' }], transcriptId: null },
      },
      { 'idempotency-key': id() },
    );
    expect(reversed.statusCode).toBe(400);
    const audioOnly = await request(
      'POST',
      '/api/automation',
      {
        kind: 'clip_video',
        data: { assetId: audio.id, segments: [{ start: 0, end: 1, label: '音频' }], transcriptId: null },
      },
      { 'idempotency-key': id() },
    );
    expect(audioOnly.statusCode).toBe(400);
  }, 120000);
});

describe('媒体服务不可用（VID-02/VID-03 依赖检查）', () => {
  it('FFmpeg 路径无效时健康检查报告不可用，接口测试给出明确错误', async () => {
    const broken = await buildMediaService({
      dataDir: path.join(folder, 'broken-media'),
      token: mediaToken,
      ffmpeg: path.join(folder, 'missing-ffmpeg.exe'),
      ffprobe,
    });
    try {
      const address = await broken.listen({ port: 0, host: '127.0.0.1' });
      const health = await broken.inject('/v1/health');
      expect(health.statusCode).toBe(503);
      expect(health.json()).toEqual({ status: 'unavailable', reason: 'FFmpeg / ffprobe 不可用' });
      await provider('video', {
        name: '损坏的媒体服务',
        baseUrl: `${address}/v1`,
        model: 'one-creator-media-v1',
        apiKey: mediaToken,
      });
      const tested = await request('POST', '/api/settings/providers/video/test', {});
      expect(tested.statusCode).toBe(502);
      expect(tested.json()).toMatchObject({
        code: 'CAPABILITY_ERROR',
        message: '服务返回 HTTP 503：FFmpeg / ffprobe 不可用',
      });
    } finally {
      await broken.close();
    }
    expect((await media.inject('/v1/health')).json().status).toBe('ok');
  });
});
