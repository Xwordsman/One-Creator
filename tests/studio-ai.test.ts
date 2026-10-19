import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import type {
  Account,
  AIJob,
  ContentDocument,
  Idea,
  Material,
  Persona,
  PublishTask,
  StudioItem,
} from '@one-creator/core';
import { loadConfig, type AppConfig } from '@one-creator/server/config';
import { openDatabase, type Database } from '@one-creator/server/database';
import { id } from '@one-creator/server/records';
import { startWorker } from '@one-creator/server/jobs';
import { startAutomationWorker } from '@one-creator/server/automation';
import { buildApp } from '../apps/api/src/app.js';

// Loose shape for JSON columns (input/result/progress) inspected by the assertions.
type Json = Record<string, any>;
interface Automation {
  id: string;
  kind: string;
  status: string;
  stage: string;
  error: string;
  accountId: string | null;
  documentId: string | null;
  parentId: string | null;
  attempt: number;
  input: Json;
  result: Json;
  progress: Json;
  decisions: { itemKey: string; decision: string; data: Json }[];
}
interface MockCall {
  kind: string;
  system: string;
  user: string;
  data: Json;
  temperature: number | undefined;
}
type MockReply = string | ((call: MockCall) => string);

let app: FastifyInstance;
let db: Database;
let config: AppConfig;
let folder: string;
let cookie = '';
let server: Server;
let accountA: Account;
let accountB: Account;
let basePersona: Persona;

/** A local OpenAI-compatible endpoint; each step's reply is chosen from the request's system prompt. */
const mock = {
  calls: [] as MockCall[],
  replies: {} as Record<string, MockReply>,
  failures: {} as Record<string, number>,
};
const automationMarkers: [string, string][] = [
  ['提炼可编辑的定位', 'style'],
  ['推荐选题', 'topics'],
  ['只分析给定笔记', 'observer'],
  ['审校正文', 'review'],
  ['辅助核对', 'facts'],
  ['比较候选', 'compare'],
  ['做复盘', 'retrospective'],
  ['回复草稿', 'reply'],
];
const writingTasks: Record<string, string> = {
  生成大纲: 'outline',
  撰写正文: 'draft',
  润色改写: 'rewrite',
  标题灵感: 'titles',
  开头备选: 'opening',
  平台改写: 'adapt',
};
function kindOf(system: string, body: Json) {
  if (body.max_tokens) return 'test';
  const task = system.match(/当前任务是([^。]+)。/)?.[1];
  if (task) return writingTasks[task] ?? 'unknown';
  const instruction = system.split('\n不要虚构')[0];
  return automationMarkers.find(([marker]) => instruction.includes(marker))?.[1] ?? 'unknown';
}
const callsSince = (mark: number) => mock.calls.slice(mark);
const kinds = (mark: number) => callsSince(mark).map((call) => call.kind);
// References are stored as JSONB, so sources derived from them come back in key order, not selection order.
const sorted = <T>(values: T[]) => [...values].sort();
const sourceId = (call: MockCall, field: string, text: string) =>
  (call.data[field] as Json[]).find((source) => source.body.includes(text))!.id as string;

const request = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { cookie, 'x-creator-client': 'web', ...headers },
  });
const keyed = (url: string, payload: unknown) => request('POST', url, payload, { 'idempotency-key': id() });
const automation = async (jobId: string) =>
  (await request('GET', `/api/automation/${jobId}`)).json<Automation>();
const apply = (jobId: string, payload: Json) => request('POST', `/api/automation/${jobId}/apply`, payload);
const document = async (documentId: string) =>
  (await request('GET', `/api/documents/${documentId}`)).json<ContentDocument>();
const persona = async (personaId: string) =>
  (await request('GET', '/api/personas?limit=500'))
    .json<{ items: Persona[] }>()
    .items.find((item) => item.id === personaId)!;
const account = async (accountId: string) =>
  (await request('GET', '/api/accounts?limit=500'))
    .json<{ items: Account[] }>()
    .items.find((item) => item.id === accountId)!;
const studioItem = async (itemId: string) =>
  (await request('GET', `/api/studio/items/${itemId}`)).json<StudioItem>();
const preferences = async () =>
  (await request('GET', '/api/studio/items?kind=preference&limit=500')).json<{ items: StudioItem[] }>().items;

async function created<T>(method: 'POST' | 'PUT', url: string, payload: unknown, status = 201) {
  const response = await request(method, url, payload);
  expect(response.statusCode, response.body).toBe(status);
  return response.json<T>();
}
const material = (title: string, body: string, accountId: string | null = null) =>
  created<Material>('POST', '/api/materials', {
    title,
    body,
    accountId,
    url: `https://example.com/${encodeURIComponent(title)}`,
  });
const createDocument = (payload: Json) => created<ContentDocument>('POST', '/api/documents', payload);
const studio = (kind: string, name: string, data: Json, accountId: string | null = null) =>
  created<StudioItem>('POST', '/api/studio/items', { kind, name, accountId, data });
async function editDocument(documentId: string, change: Partial<ContentDocument>) {
  const current = await document(documentId);
  return created<ContentDocument>(
    'PUT',
    `/api/documents/${documentId}`,
    { ...current, ...change, expectedRevision: current.revision },
    200,
  );
}

/** Queue an automation job and run the worker deterministically until it leaves queued/running. */
async function run(payload: Json) {
  const response = await keyed('/api/automation', payload);
  expect(response.statusCode, response.body).toBe(202);
  return settle(response.json<Automation>().id);
}
async function settle(jobId: string) {
  const worker = startAutomationWorker(db, config, 1000000);
  try {
    await expect
      .poll(
        async () => {
          await worker.tick();
          return ['queued', 'running'].includes((await automation(jobId)).status);
        },
        { timeout: 20000, interval: 20 },
      )
      .toBe(false);
  } finally {
    await worker.stop();
  }
  return automation(jobId);
}
async function settleClassic(jobId: string) {
  const worker = startWorker(db, config, 1000000);
  const job = async () => (await request('GET', `/api/jobs/${jobId}`)).json<AIJob>();
  try {
    await expect
      .poll(
        async () => {
          await worker.tick();
          return ['queued', 'running'].includes((await job()).status);
        },
        { timeout: 20000, interval: 20 },
      )
      .toBe(false);
  } finally {
    await worker.stop();
  }
  return job();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/chat/completions' ||
        req.headers.authorization !== 'Bearer studio-mock-key'
      ) {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(raw) as Json;
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.at(-1)?.content ?? '';
      let data: Json = {};
      try {
        data = JSON.parse(user);
      } catch {
        data = {};
      }
      const call: MockCall = {
        kind: kindOf(system, body),
        system,
        user,
        data,
        temperature: body.temperature,
      };
      mock.calls.push(call);
      if (mock.failures[call.kind]) {
        mock.failures[call.kind]--;
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"mock failure"}');
        return;
      }
      const reply = call.kind === 'test' ? 'OK' : mock.replies[call.kind];
      if (reply === undefined) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"no reply configured"}');
        return;
      }
      const content = typeof reply === 'function' ? reply(call) : reply;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = path.resolve('.data/test-temp');
  await mkdir(base, { recursive: true });
  folder = await mkdtemp(path.join(base, 'studio-ai-'));
  config = await loadConfig({
    dataDir: folder,
    encryptionKey: 'ef'.repeat(32),
    production: false,
    workerMode: 'inline',
  });
  db = await openDatabase(config, true);
  app = await buildApp(db, config, { worker: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-creator-client': 'web' },
    payload: { username: 'studio', name: '创作工作台验证', password: 'Studio-Test-Password' },
  });
  expect(setup.statusCode).toBe(201);
  cookie = setup.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const port = (server.address() as { port: number }).port;
  await created(
    'PUT',
    '/api/settings/model',
    {
      name: '本地模拟模型',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      apiKey: 'studio-mock-key',
    },
    200,
  );
  expect((await request('POST', '/api/settings/model/test', {})).json().ok).toBe(true);
  basePersona = await created<Persona>('POST', '/api/personas', {
    name: '工具实践人设',
    positioning: '工具实践',
    audience: '独立开发者',
    tone: '平实',
    avoid: '夸张宣传',
  });
  accountA = await created<Account>('POST', '/api/accounts', {
    name: '实践笔记',
    platform: 'wechat',
    personaId: basePersona.id,
    preferences: { tone: '冷静克制', avoid: '绝对化表达' },
  });
  accountB = await created<Account>('POST', '/api/accounts', { name: '另一个账号', platform: 'xiaohongshu' });
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('ACC-05 样文风格提炼', () => {
  let target: Persona;
  let samples: Material[];
  let firstJob: Automation;

  it('只使用所选样文生成可编辑建议，记录样文来源与输入版本，采用前不改动人设', async () => {
    target = await created<Persona>('POST', '/api/personas', {
      name: '样文目标人设',
      positioning: '效率工具测评',
      tone: '克制',
      avoid: '标题党',
    });
    samples = [
      await material('我的样文一：三个整理习惯', '先说结论：每天十分钟整理素材。然后给出三个步骤。'),
      await material('我的样文二：工具对比', '我用了两周，下面是真实记录。每段都以一个问题开头。'),
    ];
    mock.replies.style = (call) =>
      JSON.stringify({
        positioning: `${call.data.existing.positioning}；聚焦样文中的实测记录`,
        audience: '刚开始做自媒体的个人创作者',
        tone: '平实、先给结论',
        avoid: '空泛口号',
        sample: '',
        reason: `依据《${call.data.samples[0].title}》等 ${call.data.samples.length} 篇样文的开头与段落结构`,
      });
    const mark = mock.calls.length;
    firstJob = await run({
      kind: 'style',
      data: {
        personaId: target.id,
        materialIds: samples.map((item) => item.id),
        instruction: '侧重开头方式',
      },
    });
    expect(firstJob.status, firstJob.error).toBe('succeeded');
    expect(kinds(mark)).toEqual(['style']);
    const [call] = callsSince(mark);
    // Only the selected samples reach the model, together with the target persona's current settings.
    expect(sorted(call.data.samples.map((sample: Json) => sample.id))).toEqual(
      sorted(samples.map((item) => item.id)),
    );
    for (const sample of samples)
      expect(call.data.samples.find((item: Json) => item.id === sample.id).body).toBe(sample.body);
    expect(call.data.instruction).toBe('侧重开头方式');
    expect(call.data.existing).toMatchObject({ positioning: '效率工具测评', tone: '克制', avoid: '标题党' });
    expect(call.system).toContain('不大段复制样文');
    // Input resource revisions are frozen on the job.
    expect(firstJob.input.references[target.id].revision).toBe(1);
    for (const sample of samples) expect(firstJob.input.references[sample.id].revision).toBe(sample.revision);
    expect(firstJob.result).toMatchObject({
      positioning: '效率工具测评；聚焦样文中的实测记录',
      audience: '刚开始做自媒体的个人创作者',
      tone: '平实、先给结论',
      avoid: '空泛口号',
      personaId: target.id,
      personaRevision: 1,
    });
    expect(firstJob.result.reason).toContain('2 篇样文');
    expect(
      sorted(
        firstJob.result.sources.map((source: Json) => [source.id, source.title, source.revision, source.url]),
      ),
    ).toEqual(sorted(samples.map((item) => [item.id, item.title, item.revision, item.url])));
    expect((await persona(target.id)).revision).toBe(1);
  });

  it('作者编辑后采用形成新的人设版本，旧版本保留；人设被改动后的旧结果不能直接覆盖', async () => {
    const edited = {
      ...firstJob.result,
      audience: '作者改过的读者：刚起步的内容创作者',
      feedbackNote: '少用“先说结论”这种固定开头',
    };
    const adopted = await apply(firstJob.id, { action: 'style', data: edited });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const saved = adopted.json<Persona>();
    expect(saved).toMatchObject({
      id: target.id,
      revision: 2,
      audience: '作者改过的读者：刚起步的内容创作者',
      tone: '平实、先给结论',
      name: '样文目标人设',
    });
    const revisions = (await request('GET', `/api/personas/${target.id}/revisions`)).json<
      { revision: number; data: Persona }[]
    >();
    expect(revisions.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(revisions[1].data.tone).toBe('克制');
    // The same choice is idempotent; a different edit for the same result is refused.
    expect((await apply(firstJob.id, { action: 'style', data: edited })).json().revision).toBe(2);
    expect(
      (await apply(firstJob.id, { action: 'style', data: { ...edited, tone: '另一种语气' } })).statusCode,
    ).toBe(409);
    expect((await persona(target.id)).revision).toBe(2);

    const second = await run({ kind: 'style', data: { personaId: target.id, materialIds: [samples[1].id] } });
    expect(second.status, second.error).toBe('succeeded');
    expect(second.result.personaRevision).toBe(2);
    const current = await persona(target.id);
    await created(
      'PUT',
      `/api/personas/${target.id}`,
      { ...current, avoid: '作者手工更新的避免表达', expectedRevision: 2 },
      200,
    );
    expect((await apply(second.id, { action: 'style' })).statusCode).toBe(409);
    expect((await persona(target.id)).avoid).toBe('作者手工更新的避免表达');
    expect((await automation(second.id)).decisions).toHaveLength(0);
  });

  it('不需要固定数量样文；未选人设时采用会建立新的人设', async () => {
    const job = await run({
      kind: 'style',
      data: { personaId: null, newName: '从一篇样文开始', materialIds: [samples[0].id] },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(job.result.sources).toHaveLength(1);
    const createdPersona = (await apply(job.id, { action: 'style' })).json<Persona>();
    expect(createdPersona).toMatchObject({ name: '从一篇样文开始', revision: 1, tone: '平实、先给结论' });
    expect((await request('GET', `/api/personas/${createdPersona.id}/revisions`)).json()).toHaveLength(1);
    expect(
      (
        await request(
          'POST',
          '/api/automation',
          { kind: 'style', data: { materialIds: [] } },
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(400);
  });

  it('ACC-06 采用时的反馈只形成待确认偏好；确认后追加到所属人设，不覆盖其他设置', async () => {
    const items = (await preferences()).filter((item) => item.data.sourceId === firstJob.id);
    expect(items).toHaveLength(1);
    const [preference] = items;
    expect(preference).toMatchObject({
      accountId: null,
      data: {
        personaId: target.id,
        sourceType: 'adoption',
        state: 'proposed',
        content: '少用“先说结论”这种固定开头',
      },
    });
    const before = await persona(target.id);
    expect(before.avoid).toBe('作者手工更新的避免表达');
    expect(
      (await request('POST', `/api/studio/items/${preference.id}/adopt-preference`, { field: 'sample' }))
        .statusCode,
    ).toBe(400);
    const adopted = await request('POST', `/api/studio/items/${preference.id}/adopt-preference`, {
      field: 'avoid',
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(adopted.json().data.state).toBe('adopted');
    const after = await persona(target.id);
    expect(after.avoid).toBe('作者手工更新的避免表达\n少用“先说结论”这种固定开头');
    expect({ tone: after.tone, audience: after.audience, positioning: after.positioning }).toEqual({
      tone: before.tone,
      audience: before.audience,
      positioning: before.positioning,
    });
    expect(after.revision).toBe(before.revision + 1);
    // Adopting again does not append twice.
    await request('POST', `/api/studio/items/${preference.id}/adopt-preference`, { field: 'avoid' });
    expect((await persona(target.id)).avoid).toBe(after.avoid);
    expect((await persona(basePersona.id)).revision).toBe(1);
  });
});

describe('IDEA-03 按账号推荐选题', () => {
  let job: Automation;
  let sources: Material[];
  let existing: Idea;

  it('给出关联理由、候选角度和实际来源，提示重复主题，并记录使用的人设版本', async () => {
    sources = [
      await material('读者调查：素材整理', '62% 的受访创作者说素材散落在多个应用里。', accountA.id),
      await material('访谈：周更作者', '一位周更作者说每周日集中整理一次。', accountA.id),
    ];
    existing = await created<Idea>('POST', '/api/ideas', {
      title: 'AI 写作工具怎么选',
      accountId: accountA.id,
    });
    mock.replies.topics = (call) => {
      const [first, second] = [sourceId(call, 'sources', '62%'), sourceId(call, 'sources', '周日')];
      return JSON.stringify({
        topics: [
          {
            title: 'AI 写作工具怎么选',
            reason: '与工具实践定位一致',
            angle: '按预算比较',
            sourceIds: [first],
          },
          {
            title: 'AI写作工具，怎么选？',
            reason: '同一主题的另一种写法',
            angle: '按场景比较',
            sourceIds: [second],
          },
          {
            title: '周更作者的素材整理流程',
            reason: '读者调查显示素材分散是普遍问题',
            angle: '复盘一位周更作者的做法',
            sourceIds: [first, second, id()],
          },
        ],
      });
    };
    const mark = mock.calls.length;
    job = await run({
      kind: 'topics',
      data: { materialIds: sources.map((item) => item.id), limit: 3, goal: '下周选题' },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(job.accountId).toBe(accountA.id);
    const [call] = callsSince(mark);
    expect(call.kind).toBe('topics');
    expect(call.data.account.preferences.tone).toBe('冷静克制');
    expect(sorted(call.data.sources.map((source: Json) => source.body))).toEqual(
      sorted(sources.map((item) => item.body)),
    );
    const topics = job.result.topics as Json[];
    expect(topics.map((topic) => topic.duplicate)).toEqual([true, true, false]);
    expect(topics[2]).toMatchObject({
      reason: '读者调查显示素材分散是普遍问题',
      angle: '复盘一位周更作者的做法',
      sourceIds: sources.map((item) => item.id),
      unverifiedSources: true,
    });
    expect(topics[0].unverifiedSources).toBe(false);
    expect(job.result.persona).toEqual({ id: basePersona.id, name: basePersona.name, revision: 1 });
    expect(sorted(job.result.sources.map((source: Json) => [source.id, source.revision]))).toEqual(
      sorted(sources.map((item) => [item.id, item.revision])),
    );
  });

  it('采用会建立带来源的选题，相同主题复用已有选题，跳过被记录', async () => {
    const adopted = await apply(job.id, {
      action: 'topic',
      index: 2,
      data: { feedbackNote: '偏好有真实案例的选题' },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(adopted.json().status).toBe('created');
    const idea = adopted.json().idea as Idea;
    expect(idea).toMatchObject({
      title: '周更作者的素材整理流程',
      accountId: accountA.id,
      materialIds: sources.map((item) => item.id),
      status: 'inbox',
    });
    expect(idea.body).toContain('读者调查显示素材分散是普遍问题');
    expect(idea.body).toContain('角度：复盘一位周更作者的做法');
    const repeat = await apply(job.id, {
      action: 'topic',
      index: 2,
      data: { feedbackNote: '偏好有真实案例的选题' },
    });
    expect(repeat.json().idea.id).toBe(idea.id);
    const duplicate = await apply(job.id, { action: 'topic', index: 0 });
    expect(duplicate.json()).toMatchObject({ status: 'reused', idea: { id: existing.id } });
    const skipped = await apply(job.id, {
      action: 'skip',
      index: 1,
      data: { feedbackNote: '不想再写泛泛的工具清单' },
    });
    expect(skipped.json()).toEqual({ skipped: true, index: 1 });
    const decisions = (await automation(job.id)).decisions;
    expect(decisions.map((decision) => decision.itemKey).sort()).toEqual(['skip:1', 'topic:0', 'topic:2']);
    const ideas = (await request('GET', '/api/ideas?limit=500')).json<{ items: Idea[] }>().items;
    expect(ideas.filter((item) => item.title === 'AI 写作工具怎么选')).toHaveLength(1);
    expect(ideas.filter((item) => item.title === '周更作者的素材整理流程')).toHaveLength(1);
  });

  it('ACC-06 采用与跳过的反馈各自成为待确认偏好；可修改、拒绝、删除，确认后只追加到所属账号', async () => {
    const items = (await preferences()).filter((item) => item.data.sourceId === job.id);
    const adoption = items.find((item) => item.data.sourceType === 'adoption')!;
    const rejection = items.find((item) => item.data.sourceType === 'rejection')!;
    expect(items).toHaveLength(2);
    expect(adoption).toMatchObject({
      accountId: accountA.id,
      data: { personaId: basePersona.id, content: '偏好有真实案例的选题', state: 'proposed' },
    });
    expect(rejection).toMatchObject({
      accountId: accountA.id,
      data: { content: '不想再写泛泛的工具清单', state: 'proposed' },
    });
    // Nothing is applied automatically.
    expect((await account(accountA.id)).preferences).toMatchObject({
      tone: '冷静克制',
      avoid: '绝对化表达',
      positioning: '',
    });
    const edited = await created<StudioItem>(
      'PUT',
      `/api/studio/items/${adoption.id}`,
      {
        ...adoption,
        data: { ...adoption.data, content: '偏好有真实案例与数据的选题' },
        expectedRevision: adoption.revision,
      },
      200,
    );
    expect(edited.revision).toBe(2);
    const adopted = await request('POST', `/api/studio/items/${adoption.id}/adopt-preference`, {
      field: 'tone',
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const after = await account(accountA.id);
    expect(after.preferences.tone).toBe('冷静克制\n偏好有真实案例与数据的选题');
    expect(after.preferences.avoid).toBe('绝对化表达');
    expect((await persona(basePersona.id)).tone).toBe('平实');
    expect((await account(accountB.id)).preferences.tone).toBe('');
    const context = (await request('GET', `/api/accounts/${accountA.id}/context`)).json();
    expect(context.preferences.tone).toBe('冷静克制\n偏好有真实案例与数据的选题');
    expect(context.preferenceSources.tone).toBe('账号专属设置');

    const rejected = await created<StudioItem>(
      'PUT',
      `/api/studio/items/${rejection.id}`,
      {
        ...rejection,
        data: { ...rejection.data, state: 'rejected' },
        expectedRevision: rejection.revision,
      },
      200,
    );
    expect(rejected.data.state).toBe('rejected');
    expect((await request('DELETE', `/api/studio/items/${rejection.id}`)).json().archived).toBe(true);
    expect((await preferences()).some((item) => item.id === rejection.id)).toBe(false);
    expect((await account(accountA.id)).preferences.avoid).toBe('绝对化表达');
    const history = (await request('GET', `/api/studio/items/${adoption.id}/revisions`)).json<
      { revision: number; data: StudioItem }[]
    >();
    expect(history.map((row) => row.data.data.state)).toEqual(['adopted', 'proposed', 'proposed']);

    // An empty account field falls back to the persona; adopting must extend that value, not replace it.
    const inherited = await studio(
      'preference',
      '定位补充',
      {
        personaId: basePersona.id,
        content: '优先写可复现的实测',
        sourceType: 'review',
        sourceId: job.id,
        state: 'proposed',
      },
      accountA.id,
    );
    expect(
      (await request('POST', `/api/studio/items/${inherited.id}/adopt-preference`, { field: 'positioning' }))
        .statusCode,
    ).toBe(200);
    expect((await account(accountA.id)).preferences.positioning).toBe('工具实践\n优先写可复现的实测');
    expect((await persona(basePersona.id)).positioning).toBe('工具实践');
  });

  it('被提示重复的选题即使标点不同，采用时也复用已有选题', async () => {
    const variant = await apply(job.id, { action: 'topic', index: 1 });
    expect(variant.json()).toMatchObject({ status: 'reused', idea: { id: existing.id } });
    const ideas = (await request('GET', '/api/ideas?limit=500')).json<{ items: Idea[] }>().items;
    expect(ideas.filter((item) => item.title.replace(/[\p{P}\s]/gu, '') === 'AI写作工具怎么选')).toHaveLength(
      1,
    );
  });
});

describe('IDEA-04 对标账号与内容观察', () => {
  it('分析只基于保存的笔记和已获取内容，列出实际数据范围、时间和来源方式', async () => {
    const feed = await created<Json>('POST', '/api/feeds', {
      name: '对标账号订阅',
      kind: 'rss',
      url: 'https://example.com/benchmark.xml',
      accountId: accountA.id,
      enabled: false,
    });
    const [{ id: workspaceId }] = await db.rows<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
    const entry = (title: string, fetchedAt: string) =>
      db.rows<{ id: string }>(
        'INSERT INTO feed_entries(id,"workspaceId","accountId","feedId","externalKey",title,url,body,"fetchedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [
          id(),
          workspaceId,
          accountA.id,
          feed.id,
          title,
          title,
          `https://example.com/${encodeURIComponent(title)}`,
          `${title}的正文`,
          fetchedAt,
        ],
      );
    const [old] = await entry('去年的旧文章', '2026-01-05T00:00:00.000Z');
    const [recent] = await entry('本月的新文章', new Date().toISOString());
    const note = await material('手工记录：对标账号的封面', '封面统一使用大字标题。', accountA.id);
    const observer = await studio(
      'observer',
      '对标：同类工具号',
      {
        platform: 'wechat',
        homepage: 'https://example.com/benchmark',
        notes: '每周二、周五更新，标题偏长',
        feedId: feed.id,
        materialIds: [note.id],
      },
      accountA.id,
    );
    mock.replies.observer = (call) =>
      `本次分析 ${call.data.sources.length} 条已获取内容：${call.data.sources.map((source: Json) => source.title).join('、')}`;
    const mark = mock.calls.length;
    const job = await run({
      kind: 'observer_analysis',
      data: { observerId: observer.id, since: '2026-06-01' },
    });
    expect(job.status, job.error).toBe('succeeded');
    const [call] = callsSince(mark);
    expect(call.data.observer.notes).toBe('每周二、周五更新，标题偏长');
    expect(call.system).toContain('不声称掌握对方全部内容');
    const ids = (job.result.sources as Json[]).map((source) => source.id).sort();
    expect(ids).toEqual([recent.id, note.id].sort());
    expect(ids).not.toContain(old.id);
    expect(job.result.text).toBe(
      `本次分析 2 条已获取内容：${call.data.sources.map((source: Json) => source.title).join('、')}`,
    );
    expect(job.result.scope).toMatchObject({ count: 2, since: '2026-06-01', mode: '订阅与手工资料' });
    expect(Date.parse(job.result.scope.analyzedAt)).toBeGreaterThan(Date.now() - 600000);

    const manual = await studio(
      'observer',
      '只有笔记的对标',
      { platform: 'xiaohongshu', notes: '只有手工笔记' },
      accountA.id,
    );
    const manualJob = await run({ kind: 'observer_analysis', data: { observerId: manual.id } });
    expect(manualJob.status, manualJob.error).toBe('succeeded');
    expect(manualJob.result.scope).toMatchObject({ count: 0, since: null, mode: '手工资料' });
    const empty = await studio('observer', '还没有资料的对标', { platform: 'zhihu' }, accountA.id);
    const emptyJob = await run({ kind: 'observer_analysis', data: { observerId: empty.id } });
    expect(emptyJob.status).toBe('failed');
    expect(emptyJob.error).toContain('尚未保存观察笔记');
    expect(
      (
        await request(
          'POST',
          '/api/automation',
          { kind: 'observer_analysis', data: { observerId: note.id } },
          { 'idempotency-key': id() },
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('IDEA-05 栏目、系列与创作计划', () => {
  it('选题按顺序和计划日期归入系列，可查看关联稿件，且不产生发布任务', async () => {
    const first = await created<Idea>('POST', '/api/ideas', {
      title: '系列一：建立素材库',
      accountId: accountA.id,
    });
    const second = await created<Idea>('POST', '/api/ideas', {
      title: '系列二：每周复盘',
      accountId: accountA.id,
    });
    const series = await studio(
      'series',
      '素材管理系列',
      {
        description: '三周计划',
        entries: [
          { ideaId: first.id, date: '2026-11-02' },
          { ideaId: second.id, date: '2026-11-09' },
        ],
      },
      accountA.id,
    );
    const draft = await createDocument({
      title: '建立素材库（草稿）',
      body: '第一篇正文',
      accountId: accountA.id,
      ideaId: first.id,
    });
    let contents = (await request('GET', `/api/series/${series.id}/contents`)).json<{ items: Json[] }>()
      .items;
    expect(contents.map((entry) => [entry.idea.id, entry.date])).toEqual([
      [first.id, '2026-11-02'],
      [second.id, '2026-11-09'],
    ]);
    expect(contents[0].documents).toEqual([
      { id: draft.id, title: draft.title, status: 'editing', revision: 1 },
    ]);
    expect(contents[1].documents).toEqual([]);
    const reordered = await created<StudioItem>(
      'PUT',
      `/api/studio/items/${series.id}`,
      {
        ...series,
        data: {
          ...series.data,
          entries: [
            { ideaId: second.id, date: '2026-11-02' },
            { ideaId: first.id, date: '2026-11-16' },
          ],
        },
        expectedRevision: series.revision,
      },
      200,
    );
    expect(reordered.revision).toBe(2);
    contents = (await request('GET', `/api/series/${series.id}/contents`)).json<{ items: Json[] }>().items;
    expect(contents.map((entry) => [entry.idea.title, entry.date])).toEqual([
      ['系列二：每周复盘', '2026-11-02'],
      ['系列一：建立素材库', '2026-11-16'],
    ]);
    const plans = (await request('GET', `/api/publishing?accountId=${accountA.id}&limit=500`)).json<{
      items: PublishTask[];
    }>().items;
    expect(plans.filter((plan) => plan.documentId === draft.id)).toHaveLength(0);
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'series',
          name: '无效系列',
          accountId: null,
          data: { entries: [{ ideaId: id(), date: '' }] },
        })
      ).statusCode,
    ).toBe(404);
    expect((await request('GET', `/api/series/${draft.id}/contents`)).statusCode).toBe(404);
  });
});

describe('CRE-06 提示词与写作预设', () => {
  let preset: StudioItem;
  let target: ContentDocument;

  it('任务使用填入变量的模板，模型收到渲染后的提示词，任务记录模板版本和参数', async () => {
    preset = await studio('prompt', '清单体正文', {
      description: '适合工具测评',
      scenario: 'draft',
      template: '以「{{topic}}」为题，写给{{reader}}，采用清单结构。',
      variables: [
        { key: 'topic', label: '主题', required: true },
        { key: 'reader', label: '读者', default: '新手' },
      ],
      creativity: 0.3,
    });
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'prompt',
          name: '未声明变量',
          accountId: null,
          data: { template: '写{{missing}}' },
        })
      ).json().code,
    ).toBe('TEMPLATE_VARIABLE');
    target = await createDocument({ title: '预设测试稿', body: '旧正文', accountId: accountA.id });
    mock.replies.draft = (call) => `按预设生成：${call.data.instruction}`;
    const mark = mock.calls.length;
    const queued = await keyed('/api/jobs', {
      documentId: target.id,
      expectedRevision: 1,
      kind: 'draft',
      templateId: preset.id,
      variables: { topic: '素材整理' },
      instruction: '再补一个反例',
    });
    expect(queued.statusCode, queued.body).toBe(202);
    const job = await settleClassic(queued.json<AIJob>().id);
    expect(job.status, job.error).toBe('succeeded');
    const rendered = '以「素材整理」为题，写给新手，采用清单结构。\n再补一个反例';
    expect(job.input.instruction).toBe(rendered);
    expect(job.input.template).toMatchObject({
      id: preset.id,
      name: '清单体正文',
      revision: 1,
      params: { topic: '素材整理', reader: '新手' },
    });
    expect(job.input.creativity).toBe(0.3);
    expect(kinds(mark)).toEqual(['draft']);
    const [call] = callsSince(mark);
    expect(call.data.instruction).toBe(rendered);
    expect(call.temperature).toBe(0.3);
    expect(job.output).toBe(`按预设生成：${rendered}`);
  });

  it('缺少必填变量、未声明变量、场景或账号不匹配时拒绝创建任务', async () => {
    const attempt = (payload: Json) =>
      keyed('/api/jobs', {
        documentId: target.id,
        expectedRevision: 1,
        kind: 'draft',
        templateId: preset.id,
        ...payload,
      });
    const missing = await attempt({ variables: { reader: '老手' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'TEMPLATE_VARIABLE' });
    expect(missing.json().message).toContain('主题');
    const blank = await attempt({ variables: { topic: '   ' } });
    expect(blank.json().code).toBe('TEMPLATE_VARIABLE');
    expect((await attempt({ variables: { topic: '素材', extra: '多余' } })).json().code).toBe(
      'TEMPLATE_VARIABLE',
    );
    expect((await attempt({ kind: 'outline', variables: { topic: '素材' } })).json().code).toBe(
      'TEMPLATE_SCENARIO',
    );
    const privatePreset = await studio(
      'prompt',
      '另一个账号的预设',
      { scenario: 'draft', template: '写短句' },
      accountB.id,
    );
    expect((await attempt({ templateId: privatePreset.id, variables: {} })).json().code).toBe(
      'TEMPLATE_SCOPE',
    );
    expect((await request('GET', `/api/jobs?documentId=${target.id}`)).json().total).toBe(1);
  });

  it('模板可导出导入为副本；修改后新任务记录新版本，旧任务保留当时版本', async () => {
    const exported = (await request('GET', `/api/studio/items/${preset.id}/export`)).json();
    expect(exported).toMatchObject({
      format: 'one-creator-resource',
      version: 1,
      resource: { kind: 'prompt', name: '清单体正文', accountId: null },
    });
    const copy = await created<StudioItem>('POST', '/api/studio/import', exported);
    expect(copy.id).not.toBe(preset.id);
    expect(copy.data).toEqual(preset.data);
    const updated = await created<StudioItem>(
      'PUT',
      `/api/studio/items/${preset.id}`,
      {
        ...preset,
        data: { ...preset.data, template: '以「{{topic}}」为题，写给{{reader}}，每段不超过三句。' },
        expectedRevision: 1,
      },
      200,
    );
    expect(updated.revision).toBe(2);
    const queued = await keyed('/api/jobs', {
      documentId: target.id,
      expectedRevision: 1,
      kind: 'draft',
      templateId: preset.id,
      variables: { topic: '复盘' },
    });
    const job = await settleClassic(queued.json<AIJob>().id);
    expect(job.input.template).toMatchObject({ revision: 2, params: { topic: '复盘', reader: '新手' } });
    expect(job.input.instruction).toBe('以「复盘」为题，写给新手，每段不超过三句。');
    const jobs = (await request('GET', `/api/jobs?documentId=${target.id}`)).json<{ items: AIJob[] }>().items;
    expect(jobs.map((item) => item.input.template?.revision).sort()).toEqual([1, 2]);
  });
});

describe('CRE-07 可复用多步骤创作工作流', () => {
  let workflow: StudioItem;
  let target: ContentDocument;
  let failed: Automation;
  let resumed: Automation;
  const outline = '## 大纲\n1. 为什么要整理\n2. 怎么整理\n3. 何时回看';

  it('多步执行记录每步输入输出；中途失败保留已完成步骤', async () => {
    const outlinePreset = await studio('prompt', '三点大纲', {
      scenario: 'outline',
      template: '围绕「{{topic}}」列出三点大纲',
      variables: [{ key: 'topic', label: '主题', required: true }],
    });
    workflow = await studio('workflow', '大纲-正文-润色', {
      steps: [
        {
          name: '列大纲',
          kind: 'outline',
          promptId: outlinePreset.id,
          instruction: '面向新手',
          variables: { topic: '素材整理' },
        },
        { name: '写正文', kind: 'draft', instruction: '展开成正文' },
        { name: '润色', kind: 'rewrite', instruction: '语气更平实' },
      ],
    });
    target = await createDocument({ title: '工作流目标稿', body: '作者的原始想法', accountId: accountA.id });
    mock.replies.outline = outline;
    mock.replies.draft = () => '整理素材的第一步是分类。';
    mock.replies.rewrite = (call) => `${call.data.body}（已润色）`;
    mock.failures.draft = 1;
    const mark = mock.calls.length;
    failed = await run({ kind: 'workflow', documentId: target.id, data: { workflowId: workflow.id } });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('HTTP 500');
    expect(kinds(mark)).toEqual(['outline', 'draft']);
    const [outlineCall] = callsSince(mark);
    expect(outlineCall.data.instruction).toBe('围绕「素材整理」列出三点大纲\n面向新手');
    expect(failed.progress.steps).toHaveLength(1);
    expect(failed.progress.steps[0]).toMatchObject({
      index: 0,
      name: '列大纲',
      output: outline,
      input: {
        body: '作者的原始想法',
        sourceRevision: 1,
        instruction: '围绕「素材整理」列出三点大纲\n面向新手',
      },
      template: { id: outlinePreset.id, revision: 1 },
    });
    expect(failed.progress.workflowRevision).toBe(1);
    expect(failed.input.references[workflow.id].revision).toBe(1);
    expect(failed.input.document.revision).toBe(1);
    expect((await apply(failed.id, { action: 'workflow', expectedRevision: 1 })).statusCode).toBe(409);
    expect((await document(target.id)).revision).toBe(1);
  });

  it('从检查点继续时不重做已完成步骤；没有完整检查点的步骤不能跳过', async () => {
    let mark = mock.calls.length;
    const skipped = await run({
      kind: 'workflow',
      documentId: target.id,
      parentId: failed.id,
      data: { workflowId: workflow.id, startStep: 2 },
    });
    expect(skipped.status).toBe('failed');
    expect(skipped.error).toContain('检查点');
    expect(kinds(mark)).toEqual([]);

    mark = mock.calls.length;
    const retry = await keyed(`/api/automation/${failed.id}/retry`, {});
    expect(retry.statusCode, retry.body).toBe(202);
    resumed = await settle(retry.json<Automation>().id);
    expect(resumed.status, resumed.error).toBe('succeeded');
    expect(resumed).toMatchObject({ parentId: failed.id, attempt: 2 });
    expect(resumed.input.data.startStep).toBe(1);
    expect(kinds(mark)).toEqual(['draft', 'rewrite']);
    const [draftCall] = callsSince(mark);
    expect(draftCall.data.outline).toBe(outline);
    const steps = resumed.result.steps as Json[];
    expect(steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(steps[0]).toEqual(failed.progress.steps[0]);
    expect(steps[1]).toMatchObject({
      name: '写正文',
      input: { outline, body: '作者的原始想法', instruction: '展开成正文' },
      output: '整理素材的第一步是分类。',
    });
    expect(steps[2]).toMatchObject({
      name: '润色',
      input: { body: '整理素材的第一步是分类。' },
      output: '整理素材的第一步是分类。（已润色）',
    });
    expect(resumed.result).toMatchObject({
      body: '整理素材的第一步是分类。（已润色）',
      outline,
      workflow: { id: workflow.id, revision: 1 },
    });
  });

  it('采用最终结果写入文稿前核对版本；生成后被作者修改的文稿不会被覆盖', async () => {
    expect((await apply(resumed.id, { action: 'workflow', expectedRevision: 2 })).statusCode).toBe(409);
    const saved = await apply(resumed.id, { action: 'workflow', expectedRevision: 1 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 2, body: '整理素材的第一步是分类。（已润色）', outline });
    const revisions = (await request('GET', `/api/documents/${target.id}/revisions`)).json<
      { revision: number; reason: string }[]
    >();
    expect(revisions[0]).toMatchObject({ revision: 2, reason: '采用 workflow 结果' });

    const mark = mock.calls.length;
    const again = await run({ kind: 'workflow', documentId: target.id, data: { workflowId: workflow.id } });
    expect(again.status, again.error).toBe('succeeded');
    expect(kinds(mark)).toEqual(['outline', 'draft', 'rewrite']);
    expect(again.input.document.revision).toBe(2);
    await editDocument(target.id, { body: '作者在生成期间重写的正文' });
    expect((await apply(again.id, { action: 'workflow', expectedRevision: 2 })).statusCode).toBe(409);
    expect((await apply(again.id, { action: 'workflow', expectedRevision: 3 })).statusCode).toBe(409);
    expect(await document(target.id)).toMatchObject({ revision: 3, body: '作者在生成期间重写的正文' });
  });
});

describe('REV-02 语言与文风审校', () => {
  const body =
    '震惊！这个方法最好用。最近我因该整理素材，众所周知整理很重要。非常非常推荐每天整理素材的的习惯。';
  let dictionary: StudioItem;
  let target: ContentDocument;
  let job: Automation;
  const find = (original: string, source = 'rule') =>
    (job.result.suggestions as Json[]).findIndex(
      (item) => item.original === original && item.source === source,
    );

  it('规则与模型建议都带原文定位；例外术语不提示；记录文稿与词典版本', async () => {
    dictionary = await studio(
      'dictionary',
      '账号审校词典',
      { blocked: ['震惊', '最'], exceptions: ['最近'], typos: [{ from: '因该', to: '应该' }] },
      accountA.id,
    );
    target = await createDocument({ title: '审校稿', body, accountId: accountA.id });
    mock.replies.review = (call) =>
      JSON.stringify({
        suggestions: [
          {
            start: call.data.body.indexOf('非常非常'),
            original: '非常非常',
            replacement: '非常',
            reason: '重复表达',
          },
          { start: 0, original: '每天', replacement: '每天坚持', reason: '补充动作' },
          { start: call.data.body.indexOf('最近'), original: '最近', replacement: '近来', reason: '口语化' },
          { start: 3, original: '这句话不存在', replacement: '', reason: '虚构位置' },
        ],
      });
    const mark = mock.calls.length;
    job = await run({
      kind: 'language_review',
      documentId: target.id,
      data: { dictionaryId: dictionary.id },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(kinds(mark)).toEqual(['review']);
    expect(callsSince(mark)[0].data.exceptions).toEqual(['最近']);
    expect(job.result).toMatchObject({ documentRevision: 1, dictionaryRevision: 1, warning: '' });
    expect(job.input.references[dictionary.id].revision).toBe(1);
    const suggestions = job.result.suggestions as Json[];
    for (const suggestion of suggestions) {
      expect(body.slice(suggestion.start, suggestion.end)).toBe(suggestion.original);
      expect(suggestion.end - suggestion.start).toBe(suggestion.original.length);
    }
    const summary = suggestions.map((item) => [item.source, item.original, item.replacement]).sort();
    expect(summary).toEqual(
      [
        ['rule', '震惊', ''],
        ['rule', '最', ''],
        ['rule', '因该', '应该'],
        ['rule', '的的', '的'],
        ['rule', '众所周知', ''],
        ['model', '非常非常', '非常'],
        ['model', '每天', '每天坚持'],
      ].sort(),
    );
    expect(suggestions.find((item) => item.original === '最')!.start).toBe(body.indexOf('最好'));
    expect(suggestions.find((item) => item.original === '每天')!.start).toBe(body.indexOf('每天'));
    expect(suggestions.find((item) => item.original === '震惊')!.reason).toContain('禁用词');
  });

  it('逐项采用只修改对应位置并产生新版本；可忽略；文稿被改动后拒绝旧建议', async () => {
    let expected = body.replace('因该', '应该');
    let saved = await apply(job.id, { action: 'suggestion', index: find('因该'), expectedRevision: 1 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 2, body: expected });
    expected = expected.slice(2);
    saved = await apply(job.id, { action: 'suggestion', index: find('震惊'), expectedRevision: 2 });
    expect(saved.json()).toMatchObject({ revision: 3, body: expected });
    expected = expected.replace('非常非常', '非常');
    saved = await apply(job.id, {
      action: 'suggestion',
      index: find('非常非常', 'model'),
      expectedRevision: 3,
    });
    expect(saved.json()).toMatchObject({ revision: 4, body: expected });
    expect(expected).toBe(
      '！这个方法最好用。最近我应该整理素材，众所周知整理很重要。非常推荐每天整理素材的的习惯。',
    );
    expect((await apply(job.id, { action: 'skip', index: find('每天', 'model') })).json()).toEqual({
      skipped: true,
      index: find('每天', 'model'),
    });
    expect((await document(target.id)).revision).toBe(4);
    expect(
      (await apply(job.id, { action: 'suggestion', index: find('的的'), expectedRevision: 3 })).statusCode,
    ).toBe(409);

    const edited = await editDocument(target.id, { body: `${expected}\n\n作者补充的一段话` });
    expect(edited.revision).toBe(5);
    expect(
      (await apply(job.id, { action: 'suggestion', index: find('的的'), expectedRevision: 5 })).statusCode,
    ).toBe(409);
    expect((await document(target.id)).body).toBe(`${expected}\n\n作者补充的一段话`);
    const revisions = (await request('GET', `/api/documents/${target.id}/revisions`)).json<
      { revision: number; reason: string }[]
    >();
    expect(revisions.map((revision) => revision.revision)).toEqual([5, 4, 3, 2, 1]);
    expect(revisions[1].reason).toBe('采用 language_review 结果');
  });

  it('模型结果格式不兼容时保留原始输出，规则检查仍可用', async () => {
    const fallbackDocument = await createDocument({ title: '降级审校', body: '我们的的目标。' });
    mock.replies.review = '这不是 JSON';
    const fallback = await run({ kind: 'language_review', documentId: fallbackDocument.id, data: {} });
    expect(fallback.status, fallback.error).toBe('succeeded');
    expect(fallback.result.warning).toContain('原始输出已保留');
    expect(fallback.progress.rawOutput).toBe('这不是 JSON');
    expect(fallback.result.dictionaryRevision).toBeNull();
    expect(fallback.result.suggestions).toMatchObject([
      { original: '的的', replacement: '的', source: 'rule', start: 2 },
    ]);
  });
});

describe('REV-03 引用与事实辅助核对', () => {
  it('列出待核查的数字与引述及来源状态，模型结论不作为保证，作者核对结论单独记录', async () => {
    const report = await material('行业报告', '报告显示 25% 的创作者每周使用 AI 工具。', accountA.id);
    const interview = await material('访谈记录', '编辑说审核通常需要三天。', accountA.id);
    const body =
      '超过 25% 的创作者每周使用 AI 工具。编辑说“审核只要一天”。平台审核需要 48 小时。这一句没有可核查内容。';
    const target = await createDocument({
      title: '事实核对稿',
      body,
      accountId: accountA.id,
      materialIds: [report.id, interview.id],
    });
    mock.replies.facts = (call) =>
      JSON.stringify({
        checks: (call.data.claims as Json[]).map((claim) =>
          claim.text.includes('25%')
            ? { id: claim.id, state: 'supported', sourceIds: [report.id], reason: '报告给出相同比例' }
            : claim.text.includes('一天')
              ? { id: claim.id, state: 'supported', sourceIds: [id()], reason: '引用了不存在的来源' }
              : { id: claim.id, state: 'conflict', sourceIds: [interview.id], reason: '访谈说需要三天' },
        ),
      });
    const mark = mock.calls.length;
    const job = await run({ kind: 'fact_review', documentId: target.id, data: {} });
    expect(job.status, job.error).toBe('succeeded');
    const [call] = callsSince(mark);
    expect(call.kind).toBe('facts');
    expect(call.data.sources.map((source: Json) => source.id)).toEqual([report.id, interview.id]);
    expect(job.input.document.revision).toBe(1);
    expect(job.input.document.context.citations.map((citation: Json) => citation.revision)).toEqual([
      report.revision,
      interview.revision,
    ]);
    const claims = job.result.claims as Json[];
    expect(claims.map((claim) => [claim.text, claim.state, claim.sourceIds])).toEqual([
      ['超过 25% 的创作者每周使用 AI 工具。', 'supported', [report.id]],
      ['编辑说“审核只要一天”。', 'unverified', []],
      ['平台审核需要 48 小时。', 'conflict', [interview.id]],
    ]);
    for (const claim of claims)
      expect(body.slice(claim.start, claim.start + claim.text.length)).toBe(claim.text);
    expect(job.result.notice).toContain('不是正确性保证');
    expect(job.result.sources).toHaveLength(2);

    const checked = await apply(job.id, {
      action: 'fact',
      index: 1,
      data: { state: 'conflict', sourceIds: [interview.id], note: '作者打电话确认需要三天' },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toEqual({
      claimId: '1',
      state: 'conflict',
      sourceIds: [interview.id],
      note: '作者打电话确认需要三天',
      source: 'user_checked',
    });
    expect(
      (await apply(job.id, { action: 'fact', index: 0, data: { state: 'supported', sourceIds: [] } })).json()
        .code,
    ).toBe('FACT_SOURCE');
    expect(
      (
        await apply(job.id, { action: 'fact', index: 0, data: { state: 'supported', sourceIds: [id()] } })
      ).json().code,
    ).toBe('FACT_SOURCE');
    expect((await apply(job.id, { action: 'fact', index: 0, data: { state: 'proven' } })).json().code).toBe(
      'FACT_STATE',
    );
    expect(
      (await apply(job.id, { action: 'fact', index: 9, data: { state: 'unverified' } })).json().code,
    ).toBe('RESULT_INDEX');
    const after = await automation(job.id);
    expect(after.decisions.map((decision) => [decision.itemKey, decision.data.result.source])).toEqual([
      ['fact:1', 'user_checked'],
    ]);
    expect(after.result.claims[1].state).toBe('unverified');
    expect((await document(target.id)).revision).toBe(1);
  });
});

describe('REV-04 候选版本评估', () => {
  it('评分标为模型建议并说明依据，作者选择单独记录', async () => {
    const first = await createDocument({
      title: '标题 A：三个整理习惯',
      body: '开头直接给结论。',
      accountId: accountA.id,
    });
    const second = await createDocument({
      title: '标题 B：我整理素材的方法',
      body: '开头讲一个故事。',
      accountId: accountA.id,
    });
    mock.replies.compare = (call) =>
      JSON.stringify({
        comparisons: [
          ...(call.data.candidates as Json[]).map((candidate, index) => ({
            id: candidate.id,
            score: 80 - index * 10,
            reason: `${candidate.title} 的开头${index ? '较慢' : '更直接'}`,
          })),
          { id: id(), score: 99, reason: '不存在的候选' },
        ],
      });
    const mark = mock.calls.length;
    const job = await run({
      kind: 'compare',
      data: { documentIds: [first.id, second.id], goal: '提高打开率' },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(job.accountId).toBe(accountA.id);
    const [call] = callsSince(mark);
    expect(call.data.goal).toBe('提高打开率');
    expect(call.system).toContain('评分只是模型建议');
    expect(job.result.comparisons).toEqual([
      { id: first.id, score: 80, reason: '标题 A：三个整理习惯 的开头更直接' },
      { id: second.id, score: 70, reason: '标题 B：我整理素材的方法 的开头较慢' },
    ]);
    expect(job.result.scoreSource).toBe('model_suggestion');
    expect(job.result.notice).toContain('并非真实流量表现');
    expect(job.result.candidates.map((candidate: Json) => [candidate.id, candidate.revision])).toEqual([
      [first.id, 1],
      [second.id, 1],
    ]);
    const chosen = await apply(job.id, { action: 'choose', index: 1 });
    expect(chosen.json()).toEqual({ documentId: second.id, source: 'user_chosen' });
    expect((await apply(job.id, { action: 'choose', index: 5 })).statusCode).toBe(400);
    expect((await automation(job.id)).decisions).toMatchObject([{ itemKey: 'choose:1', decision: 'choose' }]);
    expect((await document(first.id)).revision).toBe(1);
    expect((await document(second.id)).revision).toBe(1);
  });
});

describe('DAT-04 内容复盘', () => {
  it('基于真实指标快照给出可追溯建议并说明局限，写入偏好需作者确认', async () => {
    const idea = await created<Idea>('POST', '/api/ideas', {
      title: '复盘：素材整理清单',
      accountId: accountA.id,
    });
    const published = await createDocument({
      title: '素材整理清单',
      body: '已经发布的正文。',
      accountId: accountA.id,
      ideaId: idea.id,
    });
    const planResponse = await keyed('/api/publishing', {
      documentId: published.id,
      expectedRevision: published.revision,
    });
    expect(planResponse.statusCode, planResponse.body).toBe(201);
    const plan = planResponse.json<PublishTask>();
    const capture = (capturedAt: string, views: number) =>
      request('POST', '/api/metrics', {
        publishTaskId: plan.id,
        capturedAt,
        basis: 'cumulative',
        values: { views, likes: 12, comments: 3, shares: null },
      });
    expect((await capture(new Date(Date.now() - 3600000).toISOString(), 800)).statusCode).toBe(400);
    const recorded = await request('POST', `/api/publishing/${plan.id}/record`, {
      url: 'https://mp.weixin.qq.com/s/retro',
      publishedAt: new Date(Date.now() - 86400000).toISOString(),
    });
    expect(recorded.json().status).toBe('published');
    const firstMetric = (await capture(new Date(Date.now() - 7200000).toISOString(), 800)).json().snapshot;
    const secondMetric = (await capture(new Date(Date.now() - 3600000).toISOString(), 1300)).json().snapshot;
    mock.replies.retrospective = (call) => {
      const [early, late] = call.data.metrics as Json[];
      return JSON.stringify({
        summary: `阅读从 ${early.values.views} 增长到 ${late.values.views}`,
        limitations: '只有一篇内容、两次快照，不能断言标题导致了增长',
        suggestions: [
          { content: '继续保留清单式小标题', metricIds: [late.id, id()] },
          { content: '下次对比发布时间', metricIds: [early.id] },
        ],
      });
    };
    const mark = mock.calls.length;
    const job = await run({
      kind: 'retrospective',
      data: {
        publishTaskId: plan.id,
        metricIds: [firstMetric.id, secondMetric.id],
        notes: '作者笔记：标题改过一次',
      },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(job.accountId).toBe(accountA.id);
    const [call] = callsSince(mark);
    expect(call.system).toContain('不从单次表现断言因果');
    expect(call.data.notes).toBe('作者笔记：标题改过一次');
    expect(call.data.publication).toMatchObject({
      id: plan.id,
      snapshot: { ideaId: idea.id, revision: published.revision },
    });
    expect(call.data.metrics.map((metric: Json) => metric.values.views)).toEqual([800, 1300]);
    expect(job.result.summary).toBe('阅读从 800 增长到 1300');
    expect(job.result.limitations).toContain('不能断言');
    expect(job.result.suggestions).toEqual([
      { content: '继续保留清单式小标题', metricIds: [secondMetric.id] },
      { content: '下次对比发布时间', metricIds: [firstMetric.id] },
    ]);
    expect(job.result.scope).toMatchObject({ count: 2, source: 'captured_metrics' });
    expect(job.result.publicationId).toBe(plan.id);
    const before = (await account(accountA.id)).preferences;
    const proposal = await apply(job.id, { action: 'preference', index: 0 });
    expect(proposal.statusCode, proposal.body).toBe(200);
    expect(proposal.json()).toMatchObject({
      kind: 'preference',
      accountId: accountA.id,
      data: { content: '继续保留清单式小标题', sourceType: 'review', sourceId: job.id, state: 'proposed' },
    });
    expect((await account(accountA.id)).preferences).toEqual(before);
    const noMetrics = await run({ kind: 'retrospective', data: { publishTaskId: plan.id, metricIds: [] } });
    expect(noMetrics.status).toBe('failed');
    expect(noMetrics.error).toContain('指标');
  });
});

describe('OPS-01 评论与回复辅助', () => {
  it('手工或 CSV 导入评论并关联发布记录；AI 回复保存为可编辑草稿，不向平台发送', async () => {
    const doc = await createDocument({ title: '有评论的文章', body: '正文', accountId: accountA.id });
    const plan = (
      await keyed('/api/publishing', { documentId: doc.id, expectedRevision: 1 })
    ).json<PublishTask>();
    await request('POST', `/api/publishing/${plan.id}/record`, {
      url: 'https://mp.weixin.qq.com/s/comments',
      publishedAt: new Date(Date.now() - 86400000).toISOString(),
    });
    const manual = await studio('comment', '手工记录的评论', {
      publishTaskId: plan.id,
      author: '读者甲',
      text: '能讲讲怎么给素材打标签吗？',
      publishedAt: new Date().toISOString(),
    });
    expect(manual.accountId).toBe(accountA.id);
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'comment',
          name: '错账号',
          accountId: accountB.id,
          data: { publishTaskId: plan.id, text: 'x', publishedAt: new Date().toISOString() },
        })
      ).json().code,
    ).toBe('ACCOUNT_MISMATCH');
    const csv = [
      'publishTaskId,author,text,publishedAt,externalId',
      `${plan.id},读者乙,"工具太多了，选哪个？",2026-10-01T08:00:00+08:00,c-1`,
      `${plan.id},读者乙,"工具太多了，选哪个？",2026-10-01T08:00:00+08:00,c-1`,
      'not-a-task,读者丙,无效行,2026-10-01T08:00:00+08:00,c-2',
    ].join('\n');
    const imported = (await request('POST', '/api/comments/import', { csv })).json<{ results: Json[] }>()
      .results;
    expect(imported.map((row) => [row.row, row.status])).toEqual([
      [2, 'created'],
      [3, 'reused'],
      [4, 'failed'],
    ]);
    expect(imported[1].id).toBe(imported[0].id);
    const importedComment = await studioItem(imported[0].id);
    expect(importedComment).toMatchObject({
      accountId: accountA.id,
      data: {
        publishTaskId: plan.id,
        author: '读者乙',
        text: '工具太多了，选哪个？',
        externalId: 'c-1',
        replyState: 'none',
      },
    });

    mock.replies.reply = (call) =>
      `谢谢${call.data.comment.author}的留言，下一篇会专门回答：${call.data.comment.text}`;
    const mark = mock.calls.length;
    const job = await run({
      kind: 'comment_reply',
      data: { commentIds: [manual.id, importedComment.id], instruction: '语气亲切' },
    });
    expect(job.status, job.error).toBe('succeeded');
    expect(kinds(mark)).toEqual(['reply', 'reply']);
    expect(callsSince(mark)[0].data.instruction).toBe('语气亲切');
    expect(job.result.replies).toEqual([
      {
        commentId: manual.id,
        text: '谢谢读者甲的留言，下一篇会专门回答：能讲讲怎么给素材打标签吗？',
        revision: 1,
      },
      {
        commentId: importedComment.id,
        text: '谢谢读者乙的留言，下一篇会专门回答：工具太多了，选哪个？',
        revision: 1,
      },
    ]);
    expect(job.result.scope.count).toBe(2);
    expect(Date.parse(job.result.scope.generatedAt)).toBeGreaterThan(Date.now() - 600000);

    const saved = await apply(job.id, {
      action: 'reply',
      index: 0,
      data: { text: '作者改过的回复：下周专门写打标签。' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      id: manual.id,
      revision: 2,
      data: {
        replyDraft: '作者改过的回复：下周专门写打标签。',
        replyState: 'drafted',
        text: '能讲讲怎么给素材打标签吗？',
      },
    });
    const current = await studioItem(manual.id);
    const reedited = await created<StudioItem>(
      'PUT',
      `/api/studio/items/${manual.id}`,
      { ...current, data: { ...current.data, replyDraft: '再次手工修改' }, expectedRevision: 2 },
      200,
    );
    expect(reedited.data).toMatchObject({ replyDraft: '再次手工修改', replyState: 'drafted' });
    const otherCurrent = await studioItem(importedComment.id);
    await created(
      'PUT',
      `/api/studio/items/${importedComment.id}`,
      { ...otherCurrent, data: { ...otherCurrent.data, replyDraft: '作者先写的草稿' }, expectedRevision: 1 },
      200,
    );
    expect((await apply(job.id, { action: 'reply', index: 1 })).statusCode).toBe(409);
    expect((await studioItem(importedComment.id)).data.replyDraft).toBe('作者先写的草稿');

    const publication = (await request('GET', `/api/publishing?accountId=${accountA.id}&limit=500`))
      .json<{ items: PublishTask[] }>()
      .items.find((item) => item.id === plan.id)!;
    expect(publication).toMatchObject({
      status: 'published',
      resultSource: 'user_recorded',
      publishId: null,
    });
    const platformJobs = await db.rows(
      "SELECT id FROM automation_jobs WHERE kind IN ('wechat_publish','wechat_verify','browser_publish','browser_verify')",
    );
    expect(platformJobs).toHaveLength(0);
  });
});

describe('OPS-02 合作与收益台账', () => {
  it('记录合作方、关联内容、费用和收款状态并导出 CSV', async () => {
    const doc = await createDocument({ title: '合作稿件', body: '合作正文', accountId: accountA.id });
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'collaboration',
          name: '超额',
          accountId: null,
          data: { partner: '某品牌', amount: 100, paid: 200 },
        })
      ).json().code,
    ).toBe('PAYMENT_AMOUNT');
    const deal = await studio(
      'collaboration',
      '十月品牌合作',
      {
        partner: '某工具品牌',
        contact: 'partner@example.com',
        documentIds: [doc.id],
        amount: 5000,
        paid: 2000,
        currency: 'CNY',
        dueDate: '2026-11-30',
        status: 'contracted',
        notes: '=二期另议',
      },
      accountA.id,
    );
    expect(deal.data).toMatchObject({
      documentIds: [doc.id],
      amount: 5000,
      paid: 2000,
      status: 'contracted',
    });
    const old = await studio('collaboration', '已归档的合作', { partner: '旧伙伴', amount: 1 });
    await request('DELETE', `/api/studio/items/${old.id}`);
    const exported = await request('GET', '/api/collaborations/export');
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain('collaborations.csv');
    const lines = exported.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('"名称","合作方","联系方式","关联内容","金额","已收","币种","到期","状态","备注"');
    expect(lines.slice(1)).toEqual([
      '"十月品牌合作","某工具品牌","partner@example.com","合作稿件","5000","2000","CNY","2026-11-30","contracted","\'=二期另议"',
    ]);
  });
});

describe('FMT-05 视觉模板库', () => {
  it('文稿使用视觉模板渲染主题色与页脚，模板版本可追溯', async () => {
    const theme = {
      background: '#fdf6e3',
      foreground: '#3b2f2f',
      accent: '#b5523b',
      font: 'serif',
      footer: '关注「实践笔记」',
      ratio: '1:1',
    };
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'visual',
          name: '无效颜色',
          accountId: null,
          data: { ...theme, accent: 'red' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/api/studio/items', {
          kind: 'visual',
          name: '无效字体',
          accountId: null,
          data: { ...theme, font: 'comic' },
        })
      ).statusCode,
    ).toBe(400);
    const visual = await studio('visual', '暖色主题', theme, accountA.id);
    const doc = await createDocument({
      title: '带视觉模板的文章',
      body: '## 小标题\n\n正文段落，含[链接](https://example.com/a)。',
      accountId: accountA.id,
      visualTemplateId: visual.id,
    });
    expect(doc.context.visual).toMatchObject({ id: visual.id, name: '暖色主题', revision: 1, ...theme });
    const html = (revision?: number) =>
      request('GET', `/api/documents/${doc.id}/export${revision ? `?revision=${revision}` : ''}`).then(
        (response) => {
          expect(response.statusCode).toBe(200);
          const files = unzipSync(response.rawPayload);
          return {
            html: strFromU8(files['article.html']),
            manifest: JSON.parse(strFromU8(files['manifest.json'])),
          };
        },
      );
    const first = await html();
    expect(first.html).toContain('background:#fdf6e3');
    expect(first.html).toContain('color:#3b2f2f');
    expect(first.html).toContain('border-left:3px solid #b5523b');
    expect(first.html).toContain('color:#b5523b;text-decoration:underline');
    expect(first.html).toContain('Noto Serif CJK SC');
    expect(first.html).toContain('关注「实践笔记」');
    expect(first.html).not.toContain('#31745b');
    expect(first.manifest.visual).toMatchObject({ id: visual.id, revision: 1, accent: '#b5523b' });

    await created(
      'PUT',
      `/api/studio/items/${visual.id}`,
      { ...visual, data: { ...theme, accent: '#1f6feb' }, expectedRevision: 1 },
      200,
    );
    expect((await document(doc.id)).context.visual?.revision).toBe(1);
    const resaved = await editDocument(doc.id, { body: `${doc.body}\n\n补充一段。` });
    expect(resaved.context.visual).toMatchObject({ revision: 2, accent: '#1f6feb' });
    expect((await html()).html).toContain('border-left:3px solid #1f6feb');
    const previous = await html(1);
    expect(previous.html).toContain('border-left:3px solid #b5523b');
    expect(previous.manifest.visual.revision).toBe(1);
    expect(
      (
        await request('POST', '/api/documents', {
          title: '跨账号模板',
          accountId: accountB.id,
          visualTemplateId: visual.id,
        })
      ).json().code,
    ).toBe('VISUAL_SCOPE');
  });
});

describe('通用：输入版本、采用核对与无效模型输出', () => {
  it('模型返回无效 JSON 时任务失败并保留原始输出，不写入任何数据；重试可继续', async () => {
    const target = await created<Persona>('POST', '/api/personas', {
      name: '无效输出测试人设',
      tone: '原有语气',
    });
    const sample = await material('无效输出样文', '一篇样文。');
    const preferenceCount = (await preferences()).length;
    mock.replies.style = '抱歉，我无法按 JSON 返回：{"tone":';
    const job = await run({ kind: 'style', data: { personaId: target.id, materialIds: [sample.id] } });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('原始输出已保留');
    expect(job.progress.rawOutput).toBe('抱歉，我无法按 JSON 返回：{"tone":');
    expect(job.result).toEqual({});
    expect((await apply(job.id, { action: 'style' })).statusCode).toBe(409);
    expect(await persona(target.id)).toMatchObject({ revision: 1, tone: '原有语气' });
    expect((await request('GET', `/api/personas/${target.id}/revisions`)).json()).toHaveLength(1);
    expect((await automation(job.id)).decisions).toHaveLength(0);
    expect((await preferences()).length).toBe(preferenceCount);

    mock.replies.compare = '{"comparisons": [';
    const first = await createDocument({ title: '候选一', body: '一', accountId: accountA.id });
    const second = await createDocument({ title: '候选二', body: '二', accountId: accountA.id });
    const compare = await run({ kind: 'compare', data: { documentIds: [first.id, second.id] } });
    expect(compare.status).toBe('failed');
    expect(compare.progress.rawOutput).toBe('{"comparisons": [');
    expect((await apply(compare.id, { action: 'choose', index: 0 })).statusCode).toBe(409);

    mock.replies.style = JSON.stringify({
      positioning: '',
      audience: '',
      tone: '修正后的语气',
      avoid: '',
      sample: '',
      reason: '重试',
    });
    const retry = await keyed(`/api/automation/${job.id}/retry`, {});
    const retried = await settle(retry.json<Automation>().id);
    expect(retried.status, retried.error).toBe('succeeded');
    expect(retried).toMatchObject({ parentId: job.id, attempt: 2 });
    expect(retried.result.tone).toBe('修正后的语气');
    expect((await apply(retried.id, { action: 'style' })).json()).toMatchObject({
      revision: 2,
      tone: '修正后的语气',
    });
  });

  it('任务快照记录输入资源版本；采用时重新核对目标文稿版本', async () => {
    const source = await material('版本记录素材', '第一版内容', accountA.id);
    await created(
      'PUT',
      `/api/materials/${source.id}`,
      { ...source, body: '第二版内容', expectedRevision: 1 },
      200,
    );
    const target = await createDocument({
      title: '版本核对稿',
      body: '原文的的保留',
      accountId: accountA.id,
      materialIds: [source.id],
    });
    const job = await run({ kind: 'language_review', documentId: target.id, data: { useModel: false } });
    expect(job.status, job.error).toBe('succeeded');
    expect(job.input.document).toMatchObject({ id: target.id, revision: 1 });
    expect(job.input.document.context.citations[0]).toMatchObject({
      id: source.id,
      revision: 2,
      body: '第二版内容',
    });
    expect(job.result.documentRevision).toBe(1);
    await editDocument(target.id, { title: '标题改了，正文没变' });
    expect((await apply(job.id, { action: 'suggestion', index: 0, expectedRevision: 1 })).statusCode).toBe(
      409,
    );
    expect((await apply(job.id, { action: 'suggestion', index: 0, expectedRevision: 2 })).statusCode).toBe(
      409,
    );
    expect((await document(target.id)).body).toBe('原文的的保留');
  });
});
