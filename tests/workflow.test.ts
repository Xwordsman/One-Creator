import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Activity, ContentDocument, Material, WorkTask } from '@one-creator/core';
import { loadConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { buildMessages } from '@one-creator/server/ai';
import { reviewSources } from '@one-creator/server/source-review';
import { buildApp } from '../apps/api/src/app.js';

let app: FastifyInstance;
let db: Database;
let folder: string;
let cookie = '';
let document: ContentDocument;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { cookie, 'x-creator-client': 'web' },
  });
beforeAll(async () => {
  await mkdir('.data/test-temp', { recursive: true });
  folder = await mkdtemp(path.resolve('.data/test-temp/workflow-'));
  const config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'dc'.repeat(32),
    production: false,
    workerMode: 'inline',
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await call('POST', '/api/auth/setup', {
    username: 'workflow',
    password: 'Workflow-Test-Password',
    name: '工作流验证',
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('摘录与生成结果的出处检查', () => {
  it('只关联已选资料的摘录，保留历史快照，原文变化后明确标记找不到', async () => {
    const material = (
      await call('POST', '/api/materials', {
        title: '实践记录',
        body: '开头。可靠的原始片段。结尾。',
        url: 'https://example.com/source',
      })
    ).json<Material>();
    const invalid = await call('POST', '/api/documents', {
      title: '错误引用',
      excerpts: [{ materialId: material.id, text: '可靠的原始片段' }],
    });
    expect(invalid.statusCode).toBe(400);
    const created = await call('POST', '/api/documents', {
      title: '摘录驱动写作',
      body: '自己的正文',
      materialIds: [material.id],
      excerpts: [{ materialId: material.id, text: '可靠的原始片段' }],
    });
    expect(created.statusCode).toBe(201);
    document = created.json();
    expect(document.context.citations[0].excerpts).toEqual([{ text: '可靠的原始片段', found: true }]);
    const prompt = buildMessages({
      kind: 'draft',
      input: { document, instruction: '', baseUrl: '', model: 'test' },
    });
    const references = JSON.parse(prompt[1].content).references;
    expect(references[0].excerpt).toBe('可靠的原始片段');
    await call('PUT', `/api/materials/${material.id}`, {
      ...material,
      body: '原文已经调整。',
      expectedRevision: material.revision,
    });
    const saved = await call('PUT', `/api/documents/${document.id}`, {
      ...document,
      brief: '重新检查引用',
      expectedRevision: document.revision,
    });
    document = saved.json();
    expect(document.context.citations[0].excerpts?.[0].found).toBe(false);
    const revisions = (await call('GET', `/api/documents/${document.id}/revisions`)).json();
    expect(revisions[1].data.context.citations[0].excerpts[0].found).toBe(true);
    const refreshed = buildMessages({
      kind: 'draft',
      input: { document, instruction: '', baseUrl: '', model: 'test' },
    });
    expect(JSON.parse(refreshed[1].content).references[0].excerpt).toBe('');
  });
  it('新链接在候选正文和任务中标为待核实，已有来源不被伪造为新资料', () => {
    const reviewed = reviewSources(
      '出处：https://example.com/source\n\n[模型新增](https://invented.example/research)',
      document,
    );
    expect(reviewed.warnings.some((warning) => warning.includes('invented.example'))).toBe(true);
    expect(reviewed.warnings.some((warning) => warning.includes('当前原文中已找不到'))).toBe(true);
    expect(reviewed.warnings.some((warning) => warning.includes('https://example.com/source'))).toBe(false);
    expect(reviewed.output).toContain('> 待核实：');
    expect(document.materialIds).toHaveLength(1);
  });
});

describe('统一任务中心与浏览器操作恢复', () => {
  it('导入、图片处理和服务端导出统一可查，正常完成有阶段和时间', async () => {
    const activity = (
      await call('POST', '/api/activities', {
        kind: 'render_cards',
        title: '生成卡片',
        documentId: document.id,
      })
    ).json<Activity>();
    expect(activity.stage).toBe('rendering');
    expect(activity.status).toBe('running');
    const finish = await call('POST', `/api/activities/${activity.id}/finish`, {
      status: 'succeeded',
      message: '已生成两张卡片',
    });
    expect(finish.json().stage).toBe('done');
    expect(finish.json().finishedAt).toBeTruthy();
    expect((await call('GET', `/api/documents/${document.id}/export`)).statusCode).toBe(200);
    const tasks = (await call('GET', '/api/tasks')).json<{ items: WorkTask[]; total: number }>();
    expect(tasks.items.map((task) => task.kind)).toContain('render_cards');
    expect(tasks.items.map((task) => task.kind)).toContain('export_document');
    expect((await call('GET', '/api/tasks?type=exporting')).json().total).toBe(1);
    expect((await call('GET', '/api/tasks?type=publishing')).json().total).toBe(0);
    expect((await app.inject('/api/tasks')).statusCode).toBe(401);
  });
  it('页面离开后不再续期，迟到成功不能覆盖失败，重做关联原任务', async () => {
    const activity = (
      await call('POST', '/api/activities', { kind: 'import_text', title: '未完成导入' })
    ).json<Activity>();
    await db.rows(`UPDATE activities SET "leaseUntil"=now()-interval '1 second' WHERE id=$1`, [activity.id]);
    const tasks = (await call('GET', '/api/tasks?type=importing')).json<{ items: WorkTask[] }>();
    expect(tasks.items[0].status).toBe('failed');
    expect(tasks.items[0].stage).toBe('importing');
    expect(
      (await call('POST', `/api/activities/${activity.id}/finish`, { status: 'succeeded' })).statusCode,
    ).toBe(409);
    expect((await call('POST', `/api/activities/${activity.id}/heartbeat`, {})).statusCode).toBe(409);
    const retry = await call('POST', '/api/activities', {
      kind: 'import_text',
      title: '重做导入',
      parentId: activity.id,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().attempt).toBe(2);
    expect(retry.json().parentId).toBe(activity.id);
    expect(
      (
        await call('POST', '/api/activities', {
          kind: 'crop_cover',
          title: '不相关操作',
          parentId: activity.id,
        })
      ).statusCode,
    ).toBe(409);
  });
});
