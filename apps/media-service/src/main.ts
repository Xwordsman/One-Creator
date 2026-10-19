import path from 'node:path';
import { buildMediaService } from './service.js';

/** Local development can use the ffmpeg-static binaries; containers use the system FFmpeg. */
async function tools() {
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH)
    return { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  try {
    const [ffmpeg, ffprobe] = await Promise.all([import('ffmpeg-static'), import('ffprobe-static')]);
    return {
      ffmpeg: process.env.FFMPEG_PATH ?? (ffmpeg.default as unknown as string),
      ffprobe: process.env.FFPROBE_PATH ?? (ffprobe.default as { path: string }).path,
    };
  } catch {
    return { ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe' };
  }
}
const app = await buildMediaService({
  dataDir: path.resolve(process.env.MEDIA_DATA_DIR ?? '.data/media-service'),
  token: process.env.MEDIA_SERVICE_TOKEN ?? '',
  ...(await tools()),
});
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.MEDIA_PORT ?? 4100) });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
