import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserProfiles } from '@one-creator/core';
import { runBrowserJob, type BrowserJob } from './browser.js';

const server = (process.env.EXECUTOR_SERVER ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const token = process.env.EXECUTOR_TOKEN ?? '';
if (!token.startsWith('ocn_')) throw new Error('请先在工作空间注册执行节点并设置 EXECUTOR_TOKEN');
const dataDir = path.resolve(process.env.EXECUTOR_DATA_DIR ?? '.data/executor');
await mkdir(dataDir, { recursive: true });
let encryptionKey = process.env.EXECUTOR_ENCRYPTION_KEY;
if (!encryptionKey) {
  try {
    encryptionKey = (await readFile(path.join(dataDir, 'profile.key'), 'utf8')).trim();
  } catch {
    encryptionKey = randomBytes(32).toString('hex');
    await writeFile(path.join(dataDir, 'profile.key'), encryptionKey, { flag: 'wx', mode: 0o600 });
  }
}
if (!/^[a-f\d]{64}$/i.test(encryptionKey)) throw new Error('执行器会话密钥必须为 64 位十六进制');
const instanceId = randomUUID(),
  abort = new AbortController();
async function request(url: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${server}/api/executor${url}`, {
    method,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Executor-Instance': instanceId,
      ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...extra,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
  });
  if (!response.ok) throw new Error(`Executor HTTP ${response.status}`);
  return response;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
while (!abort.signal.aborted) {
  try {
    const result = (await (
      await request('/poll', 'POST', {
        version: '0.1.0-alpha.1',
        capabilities: { platforms: Object.keys(browserProfiles), browser: true },
      })
    ).json()) as { job: BrowserJob | null };
    if (!result.job) {
      await delay(2000, undefined, { signal: abort.signal });
      continue;
    }
    const job = result.job,
      jobAbort = new AbortController();
    let stage = 'preparing',
      progress: Record<string, unknown> = {},
      heartbeating = false;
    const heartbeat = async (next: string, data: Record<string, unknown> = {}) => {
      stage = next;
      progress = data;
      await request(`/jobs/${job.id}/heartbeat`, 'POST', { leaseToken: job.leaseToken, stage, progress });
    };
    const timer = setInterval(() => {
      if (heartbeating) return;
      heartbeating = true;
      void heartbeat(stage, progress)
        .catch(() => jobAbort.abort())
        .finally(() => {
          heartbeating = false;
        });
    }, 5000);
    try {
      const outcome = await runBrowserJob(
        job,
        {
          dataDir,
          encryptionKey,
          executablePath: process.env.BROWSER_EXECUTABLE,
          headless: process.env.BROWSER_HEADLESS !== 'false',
        },
        {
          heartbeat,
          screenshot: async (bytes) => {
            const form = new FormData();
            form.set(
              'file',
              new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
              'browser-evidence.png',
            );
            await request(`/jobs/${job.id}/screenshot`, 'POST', form, { 'X-Job-Lease': job.leaseToken });
          },
          asset: async (assetId) =>
            Buffer.from(
              await (
                await request(`/jobs/${job.id}/assets/${assetId}`, 'GET', undefined, {
                  'X-Job-Lease': job.leaseToken,
                })
              ).arrayBuffer(),
            ),
          commands: async () => {
            const result = await (
              await request(`/jobs/${job.id}/commands`, 'GET', undefined, { 'X-Job-Lease': job.leaseToken })
            ).json();
            return result.commands;
          },
          ack: async (ids) => {
            await request(`/jobs/${job.id}/commands/ack`, 'POST', { ids }, { 'X-Job-Lease': job.leaseToken });
          },
        },
        AbortSignal.any([abort.signal, jobAbort.signal]),
      );
      await request(`/jobs/${job.id}/result`, 'POST', { leaseToken: job.leaseToken, result: outcome });
    } finally {
      clearInterval(timer);
    }
  } catch (error) {
    if (abort.signal.aborted) break;
    console.error(error instanceof Error ? error.message : '执行节点请求失败');
    await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
  }
}
