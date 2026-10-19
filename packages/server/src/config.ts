import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  origin: string;
  dataDir: string;
  databaseUrl?: string;
  encryptionKey: string;
  secureCookie: boolean;
  workerMode: 'inline' | 'external';
  production: boolean;
  /** Test-only transport override; normal deployments always call api.weixin.qq.com. */
  wechatApiBase?: string;
  wechatTimeoutMs?: number;
  integrationOrigins: string[];
}

export async function loadConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  const production = overrides.production ?? process.env.NODE_ENV === 'production';
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? '.data/local');
  await mkdir(path.join(dataDir, 'assets'), { recursive: true });
  let encryptionKey = overrides.encryptionKey ?? process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    if (production) throw new Error('生产部署必须设置 ENCRYPTION_KEY。请先运行 npm run setup:docker。');
    const keyFile = path.join(dataDir, 'encryption.key');
    try {
      encryptionKey = (await readFile(keyFile, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = randomBytes(32).toString('hex');
      try {
        await writeFile(keyFile, generated, { mode: 0o600, flag: 'wx' });
        encryptionKey = generated;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        encryptionKey = (await readFile(keyFile, 'utf8')).trim();
      }
    }
  }
  if (!/^[\da-f]{64}$/i.test(encryptionKey)) throw new Error('ENCRYPTION_KEY 必须是 64 位十六进制字符串。');
  const port = overrides.port ?? Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 配置无效');
  const origin = overrides.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:5173';
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN 应只包含协议、主机和端口');
  const workerMode = overrides.workerMode ?? (process.env.WORKER_MODE === 'external' ? 'external' : 'inline');
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (workerMode === 'external' && !databaseUrl)
    throw new Error('独立 worker 需要 DATABASE_URL；嵌入式数据库请使用 inline 模式');
  if (production && !databaseUrl) throw new Error('生产部署必须设置 PostgreSQL DATABASE_URL');
  return {
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port,
    origin,
    dataDir,
    encryptionKey,
    databaseUrl,
    secureCookie: overrides.secureCookie ?? process.env.COOKIE_SECURE === 'true',
    workerMode,
    production,
    wechatApiBase: overrides.wechatApiBase,
    wechatTimeoutMs: overrides.wechatTimeoutMs,
    integrationOrigins:
      overrides.integrationOrigins ??
      (process.env.INTEGRATION_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
  };
}
