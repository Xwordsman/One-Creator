import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Account, ContentDocument } from '@one-creator/core';
import { loadConfig } from '@one-creator/server/config';
import { openDatabase } from '@one-creator/server/database';
import { buildApp } from '../apps/api/src/app.js';

/** Seeds an isolated embedded instance and times common requests in-process, without network or model calls. */
const dataDir = path.resolve('.data', 'benchmark');
await rm(dataDir, { recursive: true, force: true });
const config = await loadConfig({
  dataDir,
  encryptionKey: 'cd'.repeat(32),
  production: false,
  workerMode: 'inline',
  origin: 'http://localhost:4300',
});
const db = await openDatabase(config);
const app = await buildApp(db, config, { worker: false });
const client = { 'x-creator-client': 'web' };
const setup = await app.inject({
  method: 'POST',
  url: '/api/auth/setup',
  headers: client,
  payload: { username: 'benchmark', password: 'Benchmark-Password-2026', name: '基准测试' },
});
const cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    payload: payload as Record<string, unknown> | undefined,
    headers: { ...client, cookie },
  });
  if (response.statusCode >= 400)
    throw new Error(`${method} ${url} → ${response.statusCode} ${response.body}`);
  return response;
}

const counts = { accounts: 6, materials: 300, documents: 800 };
const seedStarted = performance.now();
const accounts: Account[] = [];
for (let index = 0; index < counts.accounts; index++) {
  const platform = (['wechat', 'xiaohongshu', 'toutiao'] as const)[index % 3];
  accounts.push(
    (await call('POST', '/api/accounts', { name: `基准账号 ${index + 1}`, platform })).json<Account>(),
  );
}
for (let index = 0; index < counts.materials; index++)
  await call('POST', '/api/materials', {
    title: `素材 ${index + 1}`,
    body: `关于工具与创作方法的摘录 ${index + 1}。`.repeat(20),
    tags: [`主题${index % 12}`],
  });
let target: ContentDocument | null = null;
for (let index = 0; index < counts.documents; index++) {
  const document = (
    await call('POST', '/api/documents', {
      title: `基准文稿 ${index + 1}`,
      body: `## 第 ${index + 1} 篇\n\n` + '记录一次真实的尝试，整理过程与结果。'.repeat(80),
      accountId: accounts[index % accounts.length].id,
    })
  ).json<ContentDocument>();
  target ??= document;
}
const seedSeconds = (performance.now() - seedStarted) / 1000;

async function measure(label: string, run: () => Promise<unknown>, times = 30) {
  await run();
  const durations: number[] = [];
  for (let index = 0; index < times; index++) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const pick = (ratio: number) =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))].toFixed(1);
  console.info(`| ${label} | ${pick(0.5)} | ${pick(0.95)} |`);
}
console.info(
  `环境：${os.cpus()[0]?.model ?? '未知 CPU'} · ${Math.round(os.totalmem() / 1024 ** 3)} GB · Node ${process.version} · ${process.platform} · ${db.kind}`,
);
console.info(
  `数据：${counts.accounts} 个账号、${counts.materials} 份素材、${counts.documents} 篇文稿（每篇约 1,400 字），写入用时 ${seedSeconds.toFixed(1)} s`,
);
console.info('| 请求 | p50 ms | p95 ms |\n| --- | --- | --- |');
const first = target!;
await measure('工作台概览', () => call('GET', '/api/dashboard'));
await measure('内容库首页（20 条）', () => call('GET', '/api/documents?limit=20'));
await measure('内容库关键词搜索', () => call('GET', '/api/documents?q=' + encodeURIComponent('第 799 篇')));
await measure('素材关键词搜索', () => call('GET', '/api/materials?q=' + encodeURIComponent('主题7')));
await measure('打开单篇文稿', () => call('GET', `/api/documents/${first.id}`));
let current = first;
await measure('保存一次修改（新修订）', async () => {
  current = (
    await call('PUT', `/api/documents/${current.id}`, {
      ...current,
      body: current.body + '。',
      expectedRevision: current.revision,
    })
  ).json<ContentDocument>();
});
await measure('导出发布包', () => call('GET', `/api/documents/${first.id}/export`), 10);
const memory = process.memoryUsage();
console.info(
  `内存：RSS ${(memory.rss / 1024 ** 2).toFixed(0)} MB · heap ${(memory.heapUsed / 1024 ** 2).toFixed(0)} MB（含进程内 PGlite 数据库）`,
);
await app.close();
await db.close();
await rm(dataDir, { recursive: true, force: true });
