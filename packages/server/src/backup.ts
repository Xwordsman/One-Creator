import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import type { Asset } from '@one-creator/core';
import type { Database } from './database.js';
import type { AppConfig } from './config.js';
import { AppError, conflict } from './errors.js';
import { assetPath } from './files.js';
import { insert } from './records.js';
import { tokenHash } from './crypto.js';
import { migrations } from './migrations.js';

export const backupTables = [
  'workspaces',
  'users',
  'personas',
  'persona_revisions',
  'accounts',
  'account_connections',
  // Publications and automation jobs reference nodes, so nodes restore first.
  'execution_nodes',
  // Documents reference visual templates (creator_items), so studio items restore before documents.
  'creator_items',
  'creator_item_revisions',
  'ideas',
  'assets',
  'materials',
  'documents',
  'document_revisions',
  'providers',
  'publish_tasks',
  'jobs',
  'activities',
  'api_tokens',
  'capability_providers',
  'model_prices',
  'usage_entries',
  'notifications',
  'notification_reads',
  'workspace_events',
  'webhook_subscriptions',
  'webhook_deliveries',
  'automation_jobs',
  'creator_decisions',
  'feeds',
  'feed_entries',
  'material_chunks',
  'metric_snapshots',
  'browser_connections',
] as const;
const tableVersion: Partial<Record<(typeof backupTables)[number], number>> = {
  account_connections: 3,
  activities: 3,
  api_tokens: 4,
  creator_items: 4,
  creator_item_revisions: 4,
  capability_providers: 4,
  model_prices: 4,
  usage_entries: 4,
  notifications: 4,
  notification_reads: 4,
  workspace_events: 4,
  webhook_subscriptions: 4,
  webhook_deliveries: 4,
  automation_jobs: 4,
  creator_decisions: 4,
  feeds: 5,
  feed_entries: 5,
  material_chunks: 5,
  metric_snapshots: 5,
  execution_nodes: 6,
  browser_connections: 6,
};
export async function createBackup(db: Database, config: AppConfig, workspaceId?: string) {
  const tables = await db.transaction(async (sql) => {
    await sql.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const result: Record<string, Record<string, unknown>[]> = {};
    for (const table of backupTables) {
      const filter = workspaceId ? ` WHERE ${table === 'workspaces' ? 'id' : '"workspaceId"'}=$1` : '';
      const order =
        table === 'documents'
          ? ' ORDER BY CASE WHEN "sourceId" IS NULL THEN 0 ELSE 1 END,"createdAt",id'
          : table === 'jobs' || table === 'activities' || table === 'automation_jobs'
            ? ' ORDER BY attempt,"createdAt",id'
            : '';
      result[table] = await sql.rows(
        `SELECT * FROM ${table}${filter}${order}`,
        workspaceId ? [workspaceId] : [],
      );
    }
    return result;
  });
  const assets = tables.assets as unknown as Asset[];
  if (assets.reduce((size, asset) => size + asset.size, 0) > 150 * 1024 * 1024)
    throw new AppError(
      400,
      'BACKUP_TOO_LARGE',
      '网页备份目前支持 150 MB 素材以内；更大的实例请使用数据库与数据卷备份',
    );
  const files: Record<string, Uint8Array> = {};
  files['data.json'] = strToU8(
    JSON.stringify({
      format: 'one-creator-backup',
      version: 1,
      schemaVersion: migrations.length,
      createdAt: new Date().toISOString(),
      keyFingerprint: tokenHash(config.encryptionKey),
      tables,
    }),
  );
  for (const asset of assets)
    files[`assets/${asset.storageKey}`] = await readFile(assetPath(config.dataDir, asset.storageKey));
  return Buffer.from(zipSync(files, { level: 6 }));
}

const backupSchema = z.object({
  format: z.literal('one-creator-backup'),
  version: z.literal(1),
  schemaVersion: z.number().int().positive().default(1),
  keyFingerprint: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export async function restoreBackup(db: Database, config: AppConfig, bytes: Uint8Array) {
  let size = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      size += file.originalSize;
      if (size > 200 * 1024 * 1024) throw new AppError(400, 'BACKUP_TOO_LARGE', '备份解压后超过 200 MB');
      return (
        file.name === 'data.json' ||
        /^assets\/[a-f\d-]{36}\.(png|jpg|webp|mp4|mp3|m4a|wav|srt|vtt)$/.test(file.name)
      );
    },
  });
  if (!files['data.json']) throw new AppError(400, 'BACKUP_FORMAT', '备份缺少 data.json');
  const manifest = backupSchema.parse(JSON.parse(strFromU8(files['data.json'])));
  // Older backups restore into the current schema (new columns take their defaults); newer ones cannot be read safely.
  if (manifest.schemaVersion > migrations.length)
    throw new AppError(400, 'BACKUP_VERSION', '备份来自更新的程序版本，请先升级 One-Creator 再恢复');
  if (manifest.keyFingerprint !== tokenHash(config.encryptionKey))
    throw new AppError(
      400,
      'BACKUP_KEY',
      '加密密钥不匹配。请先配置原实例的 ENCRYPTION_KEY 或 encryption.key',
    );
  for (const table of backupTables) {
    if (manifest.schemaVersion < (tableVersion[table] ?? 1)) manifest.tables[table] ??= [];
    if (!manifest.tables[table]) throw new AppError(400, 'BACKUP_FORMAT', `备份缺少 ${table}`);
  }
  const assets = manifest.tables.assets as unknown as Asset[];
  for (const asset of assets) {
    assetPath(config.dataDir, asset.storageKey);
    const file = files[`assets/${asset.storageKey}`];
    if (
      !file ||
      createHash('sha256').update(file).digest('hex') !== asset.hash ||
      file.byteLength !== asset.size
    )
      throw new AppError(400, 'BACKUP_ASSET', `图片文件校验失败：${asset.filename}`);
  }
  const written: string[] = [];
  try {
    await db.transaction(async (sql) => {
      await sql.rows("SELECT set_config('one_creator.restoring','true',true)");
      await sql.rows('SELECT id FROM installation WHERE id=1 FOR UPDATE');
      const existing = await sql.rows('SELECT id FROM workspaces LIMIT 1');
      if (existing.length) throw conflict('只允许恢复到尚未初始化的空实例，现有数据不会被覆盖');
      await mkdir(path.join(config.dataDir, 'assets'), { recursive: true });
      for (const asset of assets) {
        const target = assetPath(config.dataDir, asset.storageKey);
        await writeFile(target, files[`assets/${asset.storageKey}`], { flag: 'wx', mode: 0o600 });
        written.push(target);
      }
      for (const table of backupTables)
        for (const row of manifest.tables[table]) {
          if (manifest.schemaVersion < 3 && table === 'jobs')
            row.stage =
              row.status === 'succeeded' ? 'done' : row.status === 'running' ? 'generating' : 'queued';
          await insert(sql, table, row);
        }
      await sql.exec(`
        UPDATE jobs SET status=CASE WHEN kind='wechat_draft' AND (stage IN ('creating_draft','verifying_draft') OR status='needs_verification') THEN 'needs_verification' ELSE 'failed' END,
          error='从备份恢复的未完成任务，请核对后手动处理',"leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=now()
          WHERE status IN ('queued','running','needs_verification');
        UPDATE automation_jobs j SET status=CASE WHEN j.kind IN ('wechat_publish','browser_publish') AND (j.status='needs_verification' OR j.stage IN ('publishing','verifying'))
            AND NOT EXISTS(SELECT 1 FROM publish_tasks p WHERE p.id=j."publishTaskId" AND p."publishId" IS NOT NULL) THEN 'needs_verification' ELSE 'failed' END,
          error='备份恢复后请核对平台结果并手动继续',"leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=COALESCE("finishedAt",now())
          WHERE status IN ('queued','running','needs_verification');
        UPDATE publish_tasks p SET status=CASE
            WHEN EXISTS(SELECT 1 FROM jobs j WHERE j."publishTaskId"=p.id AND j.status='needs_verification') THEN 'verification_required'
            WHEN EXISTS(SELECT 1 FROM automation_jobs j WHERE j."publishTaskId"=p.id AND j.status='needs_verification') THEN 'verification_required'
            WHEN p."publishId" IS NOT NULL THEN 'submitted'
            WHEN p."platformDraftId" IS NOT NULL THEN 'draft_saved'
            WHEN p."scheduledAt" IS NOT NULL THEN 'planned' ELSE 'waiting_user' END
          WHERE status IN ('submitting','verification_required');
        -- A restored instance never publishes on its own for a time that has already passed.
        UPDATE publish_tasks SET "dispatchedRevision"="executionRevision",status=CASE WHEN status='planned' THEN 'waiting_user' ELSE status END,
          "platformResult"="platformResult"||jsonb_build_object('scheduleError','从备份恢复，过去的自动执行计划需要重新确认')
          WHERE "executionMode"<>'manual' AND "scheduledAt"<=now() AND "dispatchedRevision"<"executionRevision";
        UPDATE execution_nodes SET "tokenHash"='revoked:'||id::text,"instanceId"=NULL,"lastSeenAt"=NULL;
        UPDATE browser_connections SET status='expired',error='备份恢复后请轮换节点令牌并重新扫码登录',"screenshotAssetId"=NULL;
        UPDATE activities SET status='failed',error='从备份恢复的未完成操作，请重新执行',"finishedAt"=now() WHERE status='running';
        UPDATE account_connections SET "tokenCipher"='',"tokenExpiresAt"=NULL,status='unchecked',"checkedAt"=NULL,error='恢复后请重新检查平台连接';
        UPDATE api_tokens SET "revokedAt"=now() WHERE "revokedAt" IS NULL;
        UPDATE webhook_subscriptions SET enabled=false;
        UPDATE webhook_deliveries SET status='failed',error='备份恢复后不自动重放历史投递',"leaseToken"=NULL,"leaseUntil"=NULL WHERE status IN ('queued','running');
      `);
    });
  } catch (error) {
    await Promise.all(written.map((file) => unlink(file).catch(() => {})));
    throw error;
  }
  return {
    workspaces: manifest.tables.workspaces.length,
    documents: manifest.tables.documents.length,
    assets: assets.length,
  };
}
