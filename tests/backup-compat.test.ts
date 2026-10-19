import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { ContentDocument, WorkerJob } from '@one-creator/core';
import { emptyPreferences } from '@one-creator/core';
import { openDatabase } from '@one-creator/server/database';
import { loadConfig } from '@one-creator/server/config';
import { backupTables, restoreBackup } from '@one-creator/server/backup';
import { migrations } from '@one-creator/server/migrations';
import { hashPassword, tokenHash } from '@one-creator/server/crypto';
import { id, insert } from '@one-creator/server/records';

it('结构版本 2 的旧备份可恢复到版本 3，新增字段有默认值且已完成任务不会变成排队中', async () => {
  await mkdir('.data/test-temp', { recursive: true });
  const folder = await mkdtemp(path.resolve('.data/test-temp/legacy-backup-'));
  const config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'dd'.repeat(32),
    production: false,
    workerMode: 'inline',
  });
  const old = await openDatabase(config, true, migrations.slice(0, 2));
  const restored = await openDatabase(config, true);
  try {
    const workspaceId = id();
    await insert(old, 'workspaces', { id: workspaceId, name: '旧工作空间' });
    await insert(old, 'users', {
      id: id(),
      workspaceId,
      username: 'legacy',
      name: '旧用户',
      passwordHash: await hashPassword('Legacy-Test-Password'),
    });
    const document = await insert<ContentDocument>(old, 'documents', {
      id: id(),
      workspaceId,
      title: '旧版文章',
      body: '升级后保留',
      context: {
        account: null,
        persona: null,
        preferences: emptyPreferences,
        preferenceSources: {},
        citations: [],
      },
    });
    await insert(old, 'document_revisions', {
      id: id(),
      workspaceId,
      documentId: document.id,
      revision: 1,
      data: document,
      reason: '旧版保存',
    });
    const jobId = id();
    await insert(old, 'jobs', {
      id: jobId,
      workspaceId,
      documentId: document.id,
      kind: 'outline',
      status: 'succeeded',
      input: { document, instruction: '', model: 'legacy-model', baseUrl: 'https://example.com/v1' },
      output: '已生成的大纲',
      model: 'legacy-model',
      idempotencyKey: id(),
    });
    const tables: Record<string, Record<string, unknown>[]> = {};
    const existingTables = new Set(
      (
        await old.rows<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
        )
      ).map((row) => row.table_name),
    );
    for (const table of backupTables.filter((name) => existingTables.has(name)))
      tables[table] = await old.rows(`SELECT * FROM ${table}`);
    const manifest = {
      format: 'one-creator-backup',
      version: 1,
      schemaVersion: 2,
      keyFingerprint: tokenHash(config.encryptionKey),
      tables,
    };
    await restoreBackup(restored, config, zipSync({ 'data.json': strToU8(JSON.stringify(manifest)) }));
    const [current] = await restored.rows<ContentDocument>('SELECT * FROM documents WHERE id=$1', [
      document.id,
    ]);
    expect(current.body).toBe('升级后保留');
    expect(current.excerpts).toEqual([]);
    const [job] = await restored.rows<WorkerJob>('SELECT * FROM jobs WHERE id=$1', [jobId]);
    expect(job.status).toBe('succeeded');
    expect(job.stage).toBe('done');
    expect(job.warnings).toEqual([]);
    expect(job.progress).toEqual({});
    expect(await restored.rows('SELECT * FROM account_connections')).toEqual([]);
  } finally {
    await old.close();
    await restored.close();
    await rm(folder, { recursive: true, force: true });
  }
});
