import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadConfig } from '@one-creator/server/config';
import { openDatabase } from '@one-creator/server/database';
import { buildApp } from '../apps/api/src/app.js';
import { createWechatMock } from '../tests/helpers/wechat.js';
import { createRequire } from 'node:module';
import { buildMediaService } from '../apps/media-service/src/service.js';

/** Fixed token for the isolated preview only; it never leaves loopback. */
const previewMediaToken = 'preview-media-service-token';

const port = Number(process.env.PREVIEW_PORT ?? 4173);
const wechat = createWechatMock();
interface Schema {
  type?: string;
  enum?: unknown[];
  format?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
/** Deterministic sample matching a structured step's JSON Schema, so every preview flow is clickable. */
function sample(schema: Schema, key = ''): unknown {
  // An optional reference stays empty: a made-up ID would point at a record that does not exist.
  if (
    schema.anyOf?.some((item) => item.type === 'null') &&
    schema.anyOf.some((item) => item.format === 'uuid')
  )
    return null;
  if (schema.anyOf) return sample(schema.anyOf.find((item) => item.type !== 'null') ?? schema.anyOf[0], key);
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, value]) => [name, sample(value, name)]),
    );
  if (schema.type === 'array') {
    // Identifier lists stay empty: the preview cannot know which records a real model would cite.
    if (schema.items?.format === 'uuid') return [];
    return Array.from({ length: Math.min(Math.max(schema.minItems ?? 0, 2), schema.maxItems ?? 2) }, () =>
      sample(schema.items ?? { type: 'string' }, key),
    );
  }
  if (schema.type === 'number' || schema.type === 'integer')
    return Math.min(
      Math.max(schema.minimum ?? 0, key === 'score' ? 72 : key.endsWith('duration') ? 6 : 1),
      schema.maximum ?? 100,
    );
  if (schema.type === 'boolean') return false;
  if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  const text = `本地预览模型示例：${key || '内容'}。这是固定的模拟结果，用于检查流程，不代表真实模型的写作质量。`;
  return text.slice(0, schema.maxLength ?? text.length).padEnd(schema.minLength ?? 0, '。');
}
const model = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    // A transcription service for the media flow; it returns fixed timed segments for any upload.
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'local-test-model' }, { id: 'local-whisper' }] }));
      return;
    }
    if (request.url === '/v1/audio/transcriptions') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          language: 'zh',
          duration: 3,
          segments: [
            { start: 0, end: 1.2, text: '这是本地预览转写的第一句。' },
            { start: 1.2, end: 2.6, text: '固定结果，用于检查时间片段和字幕。' },
          ],
        }),
      );
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const payload = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const system = String(payload.messages[0].content);
    // The schema is serialized on one line; the server appends its own rules after it.
    const schema = system.match(/严格遵守以下 JSON Schema：(\{[^\n]*\})/)?.[1];
    const output = payload.max_tokens
      ? 'OK'
      : schema
        ? JSON.stringify(sample(JSON.parse(schema)))
        : system.includes('当前任务是生成大纲')
          ? '## 先明确自己的需求\n\n- 记录真实的使用场景\n- 选择一个小问题开始\n- 保存实践中的发现\n\n## 把经验写成内容\n\n将过程和结果分开整理，让读者可以跟着尝试。'
          : '## 让工具为创作服务\n\n先写下自己真正想解决的问题，再选择合适的工具。比起收集更多工具，完成一次真实的尝试更有价值。\n\n### 留下自己的实践记录\n\n记录使用过程、遇到的问题和最后的结果。积累下来的真实经验，会成为下一篇内容的起点。\n\n> 这是本地测试模型的固定响应，用于验证生成与版本工作流。';
    response.end(
      JSON.stringify({
        choices: [{ message: { content: output } }],
        usage: { prompt_tokens: 50, completion_tokens: 120 },
      }),
    );
  });
});
// Binding first fails fast when another preview already uses this port, before its data folder is touched.
await new Promise<void>((resolve, reject) => {
  model.once('error', reject);
  model.listen(port + 1, '127.0.0.1', resolve);
});
const wechatApiBase = await wechat.listen(port + 2);
// One folder per port, emptied on start: test runners on Windows can stop the process without a signal.
const dataDir = path.resolve('.data', `preview-${port}`);
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const config = await loadConfig({
  host: '127.0.0.1',
  port,
  origin: `http://localhost:${port}`,
  dataDir,
  encryptionKey: 'ef'.repeat(32),
  production: false,
  workerMode: 'inline',
  wechatApiBase,
});
const db = await openDatabase(config);
const app = await buildApp(db, config);
// The real media service with the bundled FFmpeg, so video flows produce actual files in the preview.
const require = createRequire(import.meta.url);
const media = await buildMediaService({
  dataDir: path.join(dataDir, 'media-service'),
  token: previewMediaToken,
  ffmpeg: require('ffmpeg-static') as string,
  ffprobe: (require('ffprobe-static') as { path: string }).path,
});
await media.listen({ host: '127.0.0.1', port: port + 3 });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await media.close();
  await db.close();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await wechat.close();
  await rm(dataDir, { recursive: true, force: true });
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
await app.listen({ host: config.host, port });
console.info(
  `Isolated preview: http://localhost:${port}; mock model: http://127.0.0.1:${port + 1}/v1; media service: http://127.0.0.1:${port + 3}/v1 (token ${previewMediaToken})`,
);
