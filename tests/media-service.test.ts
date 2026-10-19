import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildMediaService } from '../apps/media-service/src/service.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('ffprobe-static') as { path: string }).path;
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
function multipart(spec: unknown, name: string, bytes: Buffer, filename: string) {
  const boundary = 'CreatorMediaBoundary';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="spec"\r\n\r\n${JSON.stringify(spec)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
it('真实 FFmpeg 服务合成配音字幕视频、生成封面并切片，重复请求复用任务', async () => {
  await mkdir('.data/test-temp', { recursive: true });
  const folder = await mkdtemp(path.resolve('.data/test-temp/media-service-'));
  const token = 'Media-Service-Test-Token-2026',
    app = await buildMediaService({ dataDir: folder, token, ffmpeg, ffprobe });
  await app.ready();
  const headers = { authorization: `Bearer ${token}` };
  try {
    expect((await app.inject('/v1/health')).statusCode).toBe(200);
    expect((await app.inject('/v1/jobs/00000000-0000-4000-8000-000000000000')).statusCode).toBe(401);
    const payload = multipart(
      {
        kind: 'render',
        ratio: '1:1',
        audio: 'audio',
        scenes: [{ caption: 'One-Creator 字幕验证', duration: 2 }],
      },
      'audio',
      wave(),
      'voice.wav',
    );
    const key = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...headers, 'idempotency-key': key, 'content-type': payload.contentType },
      payload: payload.body,
    });
    expect(created.statusCode, created.body).toBe(202);
    const jobId = created.json().id;
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...headers, 'idempotency-key': key, 'content-type': payload.contentType },
      payload: payload.body,
    });
    expect(duplicate.json().id).toBe(jobId);
    await expect
      .poll(
        async () => {
          const state = (await app.inject({ url: `/v1/jobs/${jobId}`, headers })).json();
          if (state.status === 'failed') throw new Error(state.error);
          return state.status;
        },
        { timeout: 60000, interval: 500 },
      )
      .toBe('succeeded');
    const video = await app.inject({ url: `/v1/jobs/${jobId}/files/video.mp4`, headers });
    expect(video.rawPayload.subarray(4, 8).toString()).toBe('ftyp');
    const subtitles = await app.inject({ url: `/v1/jobs/${jobId}/files/subtitles.srt`, headers });
    expect(subtitles.body).toContain('00:00:00,000 --> 00:00:02,000');
    expect(subtitles.body).toContain('字幕验证');
    const cover = await app.inject({ url: `/v1/jobs/${jobId}/files/cover.jpg`, headers });
    expect(cover.rawPayload[0]).toBe(255);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/media-cover.jpg', cover.rawPayload);
    const clip = multipart(
      {
        kind: 'clip',
        media: 'media',
        segments: [{ start: 0.3, end: 1.2, label: '验证片段' }],
        subtitles: [{ start: 0, end: 2, text: '测试字幕' }],
      },
      'media',
      video.rawPayload,
      'source.mp4',
    );
    const clipped = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...headers, 'idempotency-key': randomUUID(), 'content-type': clip.contentType },
      payload: clip.body,
    });
    expect(clipped.statusCode).toBe(202);
    const clipId = clipped.json().id;
    await expect
      .poll(
        async () => {
          const state = (await app.inject({ url: `/v1/jobs/${clipId}`, headers })).json();
          if (state.status === 'failed') throw new Error(state.error);
          return state.status;
        },
        { timeout: 60000, interval: 500 },
      )
      .toBe('succeeded');
    const state = (await app.inject({ url: `/v1/jobs/${clipId}`, headers })).json();
    expect(state.outputs.find((file: { role: string }) => file.role === 'video')).toMatchObject({
      start: 0.3,
      end: 1.2,
    });
    expect((await app.inject({ url: `/v1/jobs/${clipId}/files/subtitles-0.srt`, headers })).body).toContain(
      '00:00:00,000 --> 00:00:00,900',
    );
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 120000);
