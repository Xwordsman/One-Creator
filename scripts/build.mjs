import { build as viteBuild } from 'vite';
import { build as bundle } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

await viteBuild({ configFile: path.resolve('apps/web/vite.config.ts') });
const external = new Set();
for (const parent of ['apps', 'packages']) {
  for (const name of await readdir(parent)) {
    const metadata = JSON.parse(await readFile(path.join(parent, name, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      if (!dependency.startsWith('@one-creator/')) external.add(dependency);
  }
}
for (const [entry, output] of [
  ['apps/api/src/main.ts', 'apps/api/dist/main.mjs'],
  ['apps/worker/src/main.ts', 'apps/worker/dist/main.mjs'],
  ['apps/api/src/backup.ts', 'apps/api/dist/backup.mjs'],
  ['apps/media-service/src/main.ts', 'apps/media-service/dist/main.mjs'],
  ['apps/executor/src/main.ts', 'apps/executor/dist/main.mjs'],
]) {
  await bundle({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // The media service resolves the optional static FFmpeg binaries at runtime.
    external: [...external, 'ffmpeg-static', 'ffprobe-static'],
  });
}
console.info('Web、API、worker、备份工具、媒体服务和执行节点构建完成。');
