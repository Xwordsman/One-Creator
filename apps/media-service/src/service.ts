import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';

const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('render'),
    ratio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
    audio: z.string().optional(),
    scenes: z
      .array(
        z.object({
          image: z.string().optional(),
          audio: z.string().optional(),
          caption: z.string().max(4000),
          duration: z.number().min(0.5).max(300),
        }),
      )
      .min(1)
      .max(60),
  }),
  z.object({
    kind: z.literal('clip'),
    media: z.string(),
    segments: z
      .array(
        z.object({
          start: z.number().nonnegative(),
          end: z.number().positive(),
          label: z.string().max(100).default(''),
        }),
      )
      .min(1)
      .max(30),
    subtitles: z
      .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
      .max(20000)
      .default([]),
  }),
]);
type MediaInput = z.infer<typeof inputSchema>;
export interface MediaConfig {
  dataDir: string;
  token: string;
  ffmpeg: string;
  ffprobe: string;
}
interface Output {
  name: string;
  role: string;
  mime: string;
  size: number;
  start?: number;
  end?: number;
}
interface MediaJob {
  id: string;
  requestKey: string;
  requestHash: string;
  input: MediaInput;
  files: Record<string, string>;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string;
  percent: number;
  outputs: Output[];
  timeline?: { start: number; end: number; text: string }[];
  attempt: number;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}
function timestamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function subtitles(segments: { start: number; end: number; text: string }[]) {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.start)} --> ${timestamp(segment.end)}\n${segment.text.replace(/\r|\0/g, '').replace(/\n{2,}/g, '\n')}\n`,
    )
    .join('\n');
}
function command(executable: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`媒体工具退出 ${code}：${output.slice(-1500)}`)),
    );
  });
}
export async function buildMediaService(config: MediaConfig) {
  if (config.token.length < 20) throw new Error('MEDIA_SERVICE_TOKEN 至少 20 字符');
  await mkdir(config.dataDir, { recursive: true });
  const jobs = new Map<string, MediaJob>();
  const writes = new Map<string, Promise<void>>();
  const persist = (job: MediaJob) => {
    const body = JSON.stringify(job);
    const operation = (writes.get(job.id) ?? Promise.resolve()).then(async () => {
      const temp = path.join(config.dataDir, job.id, `state-${randomUUID()}.tmp`);
      await writeFile(temp, body);
      await rename(temp, path.join(config.dataDir, job.id, 'state.json'));
    });
    writes.set(job.id, operation);
    return operation;
  };
  for (const folder of await readdir(config.dataDir)) {
    if (!/^[a-f\d-]{36}$/.test(folder)) continue;
    try {
      const job = JSON.parse(
        await readFile(path.join(config.dataDir, folder, 'state.json'), 'utf8'),
      ) as MediaJob;
      if (job.id !== folder) continue;
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = '媒体服务重启，请手动继续同一任务';
        await persist(job);
      }
      jobs.set(folder, job);
    } catch {}
  }
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024 });
  await app.register(multipart, {
    limits: { files: 121, fileSize: 128 * 1024 * 1024, fieldSize: 2 * 1024 * 1024 },
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/v1/health') return;
    const incoming = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected))
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof z.ZodError ? 400 : 500)
      .send({ error: error instanceof Error ? error.message : '媒体请求失败' }),
  );
  app.get('/v1/health', async (_request, reply) => {
    try {
      await command(config.ffmpeg, ['-version'], config.dataDir);
      await command(config.ffprobe, ['-version'], config.dataDir);
      return {
        status: 'ok',
        protocol: 'one-creator-media-v1',
        capabilities: ['render', 'clip', 'subtitles', 'poster'],
      };
    } catch {
      return reply.code(503).send({ status: 'unavailable', reason: 'FFmpeg / ffprobe 不可用' });
    }
  });
  app.post('/v1/jobs', async (request, reply) => {
    const requestKey = z.string().min(8).max(150).parse(request.headers['idempotency-key']);
    const jobId = randomUUID(),
      folder = path.join(config.dataDir, jobId);
    await mkdir(folder, { recursive: true });
    const files: Record<string, string> = {},
      hashes: Record<string, string> = {};
    let spec: unknown,
      total = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'spec') spec = JSON.parse(String(part.value));
          continue;
        }
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(part.fieldname)) throw new Error('文件字段名无效');
        const ext = path.extname(part.filename).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.m4a', '.mp3', '.wav'].includes(ext))
          throw new Error('媒体格式不支持');
        const filename = `source-${part.fieldname}${ext}`,
          hash = createHash('sha256');
        await pipeline(
          part.file,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              total += chunk.length;
              if (total > 512 * 1024 * 1024) {
                callback(new Error('任务媒体合计超过 512 MB'));
                return;
              }
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(path.join(folder, filename), { flags: 'wx' }),
        );
        files[part.fieldname] = filename;
        hashes[part.fieldname] = hash.digest('hex');
        if (part.file.truncated) throw new Error('单个媒体超过 128 MB');
      }
      const input = inputSchema.parse(spec);
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({ input, hashes: Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)) }),
        )
        .digest('hex');
      const old = [...jobs.values()].find((job) => job.requestKey === requestKey);
      if (old) {
        await rm(folder, { recursive: true, force: true });
        if (old.requestHash !== requestHash)
          return reply.code(409).send({ error: '同一个请求编号对应了不同内容' });
        await writes.get(old.id);
        return old;
      }
      const job: MediaJob = {
        id: jobId,
        requestKey,
        requestHash,
        input,
        files,
        status: 'queued',
        stage: 'queued',
        percent: 0,
        outputs: [],
        attempt: 1,
        error: '',
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      jobs.set(job.id, job);
      await persist(job);
      reply.code(202);
      return job;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      jobs.delete(jobId);
      throw error;
    }
  });
  const find = (id: unknown) => {
    const key = z.uuid().parse(id),
      job = jobs.get(key);
    if (!job) throw new Error('媒体任务不存在');
    return job;
  };
  app.get('/v1/jobs/:id', async (request) => find((request.params as { id: string }).id));
  app.post('/v1/jobs/:id/retry', async (request) => {
    const job = find((request.params as { id: string }).id);
    if (job.status === 'failed') {
      job.status = 'queued';
      job.stage = 'queued';
      job.error = '';
      job.attempt++;
      job.finishedAt = null;
      await persist(job);
    }
    return job;
  });
  app.get('/v1/jobs/:id/files/:name', async (request, reply) => {
    const params = request.params as { id: string; name: string };
    const job = find(params.id);
    const output = job.outputs.find((file) => file.name === params.name);
    if (!output || job.status !== 'succeeded') return reply.code(404).send({ error: '文件尚未就绪' });
    reply.type(output.mime).header('Content-Length', output.size).header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(path.join(config.dataDir, job.id, output.name)));
  });
  const abort = new AbortController();
  let stopped = false,
    running: Promise<void> | null = null;
  async function processJob(job: MediaJob) {
    const folder = path.join(config.dataDir, job.id);
    job.status = 'running';
    job.error = '';
    job.outputs = [];
    await persist(job);
    const media = (field: string | undefined) => {
      if (!field || !job.files[field]) throw new Error(`找不到输入媒体 ${field ?? ''}`);
      return job.files[field];
    };
    const probe = async (file: string) => {
      const value = JSON.parse(
        await command(
          config.ffprobe,
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            file,
          ],
          folder,
          abort.signal,
        ),
      );
      const duration = Number(value.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效媒体时长');
      return duration;
    };
    const tool = async (args: string[]) =>
      command(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], folder, abort.signal);
    const output = async (name: string, role: string, mime: string, extra: Partial<Output> = {}) => {
      job.outputs.push({ name, role, mime, size: (await stat(path.join(folder, name))).size, ...extra });
    };
    try {
      if (job.input.kind === 'render') {
        const input = job.input,
          [width, height] =
            input.ratio === '16:9' ? [1920, 1080] : input.ratio === '1:1' ? [1080, 1080] : [1080, 1920];
        const globalAudio = input.audio ? media(input.audio) : null,
          globalDuration = globalAudio ? await probe(globalAudio) : 0;
        const requested = input.scenes.reduce((sum, scene) => sum + scene.duration, 0);
        const factor = globalDuration ? Math.max(1, globalDuration / requested) : 1;
        const timeline: { start: number; end: number; text: string }[] = [];
        let elapsed = 0;
        for (const [index, scene] of input.scenes.entries()) {
          job.stage = `scene:${index + 1}/${input.scenes.length}`;
          job.percent = Math.round((index / input.scenes.length) * 70);
          await persist(job);
          const audio = scene.audio ? media(scene.audio) : null,
            duration = audio ? Math.max(scene.duration, await probe(audio)) : scene.duration * factor;
          const image = scene.image ? media(scene.image) : null;
          const args = image
            ? ['-loop', '1', '-i', image]
            : ['-f', 'lavfi', '-i', `color=c=0x233c30:s=${width}x${height}:r=30`];
          if (!globalAudio) {
            if (audio) args.push('-i', audio);
            else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
          }
          args.push(
            '-t',
            duration.toFixed(3),
            '-vf',
            `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`,
            '-r',
            '30',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '24',
            '-threads',
            '2',
          );
          if (!globalAudio) args.push('-af', 'apad', '-c:a', 'aac', '-ar', '48000', '-ac', '2');
          else args.push('-an');
          args.push(`scene-${index}.mp4`);
          await tool(args);
          timeline.push({ start: elapsed, end: elapsed + duration, text: scene.caption });
          elapsed += duration;
        }
        await writeFile(
          path.join(folder, 'concat.txt'),
          input.scenes.map((_scene, index) => `file 'scene-${index}.mp4'`).join('\n'),
        );
        await tool(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', 'joined.mp4']);
        await writeFile(path.join(folder, 'subtitles.srt'), subtitles(timeline), 'utf8');
        job.stage = 'captions';
        job.percent = 80;
        job.timeline = timeline;
        await persist(job);
        const args = ['-i', 'joined.mp4'];
        if (globalAudio) args.push('-i', globalAudio, '-map', '0:v', '-map', '1:a', '-af', 'apad');
        args.push(
          '-vf',
          `subtitles=subtitles.srt:force_style='FontName=${process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC'},FontSize=20,Outline=1,MarginV=40'`,
          '-t',
          elapsed.toFixed(3),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '24',
          '-threads',
          '2',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          'video.mp4',
        );
        await tool(args);
        await tool(['-i', 'video.mp4', '-frames:v', '1', 'cover.jpg']);
        await output('video.mp4', 'video', 'video/mp4');
        await output('cover.jpg', 'cover', 'image/jpeg');
        await output('subtitles.srt', 'subtitles', 'application/x-subrip');
      } else {
        const input = job.input,
          source = media(input.media),
          duration = await probe(source);
        for (const [index, segment] of input.segments.entries()) {
          if (segment.end <= segment.start || segment.end > duration + 0.1)
            throw new Error('片段区间超出原视频时长');
          job.stage = `clip:${index + 1}/${input.segments.length}`;
          job.percent = Math.round((index / input.segments.length) * 90);
          await persist(job);
          await tool([
            '-ss',
            String(segment.start),
            '-i',
            source,
            '-t',
            String(segment.end - segment.start),
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '24',
            '-threads',
            '2',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            `clip-${index}.mp4`,
          ]);
          await tool(['-i', `clip-${index}.mp4`, '-frames:v', '1', `cover-${index}.jpg`]);
          const captions = input.subtitles
            .filter((row) => row.end > segment.start && row.start < segment.end)
            .map((row) => ({
              start: Math.max(0, row.start - segment.start),
              end: Math.min(segment.end - segment.start, row.end - segment.start),
              text: row.text,
            }));
          await writeFile(path.join(folder, `subtitles-${index}.srt`), subtitles(captions), 'utf8');
          await output(`clip-${index}.mp4`, 'video', 'video/mp4', { start: segment.start, end: segment.end });
          await output(`cover-${index}.jpg`, 'cover', 'image/jpeg');
          await output(`subtitles-${index}.srt`, 'subtitles', 'application/x-subrip');
        }
      }
      job.status = 'succeeded';
      job.stage = 'done';
      job.percent = 100;
      job.finishedAt = new Date().toISOString();
      await persist(job);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : '媒体处理失败';
      job.finishedAt = new Date().toISOString();
      await persist(job);
    }
  }
  const timer = setInterval(() => {
    if (stopped || running) return;
    const next = [...jobs.values()].find((job) => job.status === 'queued');
    if (next)
      running = processJob(next)
        .catch((error) => {
          next.status = 'failed';
          next.error = error instanceof Error ? error.message : '媒体任务写入失败';
        })
        .finally(() => {
          running = null;
        });
  }, 500);
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(timer);
    abort.abort();
    await running;
    await Promise.all([...writes.values()].map((promise) => promise.catch(() => {})));
  });
  return app;
}
