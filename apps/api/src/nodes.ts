import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import type { Account, BrowserConnection, AutomationJob } from '@one-creator/core';
import {
  authenticateNode,
  registerNode,
  nodeInput,
  nodeView,
  saveBrowserConnection,
  browserConnection,
  claimNodeJob,
  nodeHeartbeat,
  nodeScreenshot,
  nodeResult,
  nodeCommands,
  queueNodeCommand,
  nodeAsset,
  loginScreenPath,
  type NodeRecord,
} from '@one-creator/server/nodes';
import { readFile } from 'node:fs/promises';
import { createAutomation } from '@one-creator/server/automation';
import { owned, update } from '@one-creator/server/records';
import { assetPath } from '@one-creator/server/files';
import { AppError, conflict } from '@one-creator/server/errors';
import { newToken, tokenHash } from '@one-creator/server/crypto';
import { workspace, recordId, idempotencyKey, type ApiContext } from './context.js';

export async function nodeRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/nodes', async (request) => ({
    items: (
      await db.rows<NodeRecord>(
        'SELECT * FROM execution_nodes WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC',
        [workspace(request)],
      )
    ).map(nodeView),
  }));
  app.post('/api/nodes', async (request, reply) => {
    const result = await registerNode(db, workspace(request), request.body);
    reply.code(201);
    return result;
  });
  app.put('/api/nodes/:id', async (request) => {
    const data = nodeInput.parse(request.body);
    for (const accountId of data.accountIds) await owned(db, 'accounts', workspace(request), accountId);
    const result = await update<NodeRecord>(
      db,
      'execution_nodes',
      workspace(request),
      recordId(request),
      data,
    );
    return nodeView(result);
  });
  app.delete('/api/nodes/:id', async (request) => {
    await update(db, 'execution_nodes', workspace(request), recordId(request), { active: false });
    return { ok: true };
  });
  app.post('/api/nodes/:id/rotate-token', async (request) => {
    const token = `ocn_${newToken()}`;
    await update(db, 'execution_nodes', workspace(request), recordId(request), {
      tokenHash: tokenHash(token),
      prefix: token.slice(0, 12),
      instanceId: null,
      lastSeenAt: null,
    });
    return { token };
  });
  app.get('/api/accounts/:id/browser-connection', async (request) => {
    await owned(db, 'accounts', workspace(request), recordId(request));
    return browserConnection(db, workspace(request), recordId(request));
  });
  app.put('/api/accounts/:id/browser-connection', async (request) => {
    if (request.user!.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '平台连接由管理员管理');
    const input = z
      .object({ nodeId: z.uuid(), selectors: z.record(z.string().max(50), z.string().max(2000)).default({}) })
      .parse(request.body);
    return saveBrowserConnection(db, workspace(request), recordId(request), input.nodeId, input.selectors);
  });
  app.post('/api/accounts/:id/browser-login', async (request, reply) => {
    if (request.user!.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '平台登录需要管理员权限');
    const input = z.object({ resetSession: z.boolean().default(false) }).parse(request.body);
    const connection = await browserConnection(db, workspace(request), recordId(request));
    if (!connection) throw new AppError(400, 'CONNECTION_REQUIRED', '请先保存节点连接');
    const job = await db.transaction((sql) =>
      createAutomation(
        sql,
        workspace(request),
        {
          kind: 'browser_login',
          accountId: recordId(request),
          data: { nodeId: connection.nodeId, resetSession: input.resetSession },
        },
        idempotencyKey(request),
      ),
    );
    reply.code(202);
    return job;
  });
  app.post('/api/accounts/:id/confirm-browser-identity', async (request) => {
    if (request.user!.role !== 'admin')
      throw new AppError(403, 'ADMIN_REQUIRED', '绑定实际账号需要管理员权限');
    const { identity } = z.object({ identity: z.string().min(1).max(300) }).parse(request.body);
    return db.transaction(async (sql) => {
      const account = await owned<Account>(sql, 'accounts', workspace(request), recordId(request), true);
      const [connection] = await sql.rows<BrowserConnection>(
        'SELECT * FROM browser_connections WHERE "accountId"=$1 AND "workspaceId"=$2 FOR UPDATE',
        [account.id, workspace(request)],
      );
      if (!connection || connection.status !== 'waiting_confirmation' || connection.identity !== identity)
        throw conflict('账号身份已变化，请重新登录核对');
      if (account.handle && account.handle !== identity)
        throw conflict('档案中已有不同账号 ID，请先修改档案');
      await update(sql, 'accounts', workspace(request), account.id, {
        handle: identity,
        updatedAt: new Date().toISOString(),
      });
      await sql.rows(
        `UPDATE browser_connections SET status='connected',error='',"updatedAt"=now() WHERE id=$1`,
        [connection.id],
      );
      return { ok: true };
    });
  });
  app.delete('/api/accounts/:id/browser-connection', async (request) => {
    if (request.user!.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '断开连接需要管理员权限');
    await owned(db, 'accounts', workspace(request), recordId(request));
    const pending = await db.rows(
      "SELECT id FROM automation_jobs WHERE \"accountId\"=$1 AND status IN ('queued','running','needs_verification') AND kind LIKE 'browser_%' LIMIT 1",
      [recordId(request)],
    );
    if (pending.length) throw conflict('请先处理执行中或待核对任务');
    await db.rows('DELETE FROM browser_connections WHERE "accountId"=$1 AND "workspaceId"=$2', [
      recordId(request),
      workspace(request),
    ]);
    return { ok: true };
  });
  app.post('/api/automation/:id/browser-command', async (request) => {
    if (request.user!.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '登录交互需要管理员权限');
    return queueNodeCommand(db, config, workspace(request), recordId(request), request.body);
  });
  app.post('/api/executor/poll', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const report = z
      .object({
        version: z.string().max(100).optional(),
        capabilities: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body);
    return { job: await claimNodeJob(db, node, report) };
  });
  app.post('/api/executor/jobs/:id/heartbeat', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const { leaseToken, stage, progress } = z
      .object({
        leaseToken: z.uuid(),
        stage: z.string().max(80),
        progress: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(request.body);
    await nodeHeartbeat(db, node, recordId(request), leaseToken, stage, progress);
    return { ok: true };
  });
  app.post('/api/executor/jobs/:id/screenshot', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const token = z.uuid().parse(request.headers['x-job-lease']);
    const file = await request.file();
    if (!file) throw new AppError(400, 'SCREENSHOT_REQUIRED', '缺少截图');
    return nodeScreenshot(db, config, node, recordId(request), token, await file.toBuffer());
  });
  app.post('/api/executor/jobs/:id/result', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const input = z
      .object({
        leaseToken: z.uuid(),
        result: z.object({
          state: z.enum(['connected', 'failed', 'submitted', 'published', 'uncertain', 'not_found']),
          identity: z.string().max(300).optional(),
          url: z.url({ protocol: /^https?$/ }).optional(),
          message: z.string().max(2000).optional(),
          receipt: z.record(z.string(), z.unknown()).optional(),
        }),
      })
      .parse(request.body);
    return nodeResult(db, config, node, recordId(request), input.leaseToken, input.result);
  });
  app.get('/api/automation/:id/browser-screen', async (request, reply) => {
    const job = await owned<AutomationJob>(db, 'automation_jobs', workspace(request), recordId(request));
    if (job.kind !== 'browser_login' || !['queued', 'running'].includes(job.status))
      throw new AppError(404, 'SCREEN_GONE', '登录画面已结束');
    try {
      const bytes = await readFile(loginScreenPath(config.dataDir, job.id));
      reply.type('image/png').header('Cache-Control', 'no-store, private');
      return reply.send(bytes);
    } catch {
      throw new AppError(404, 'SCREEN_PENDING', '执行节点尚未上传登录画面');
    }
  });
  app.get('/api/executor/jobs/:id/commands', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const commands = await nodeCommands(
      db,
      config,
      node,
      recordId(request),
      z.uuid().parse(request.headers['x-job-lease']),
    );
    return { commands };
  });
  app.post('/api/executor/jobs/:id/commands/ack', { config: { public: true } }, async (request) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const { ids } = z.object({ ids: z.array(z.uuid()).max(50) }).parse(request.body);
    await nodeCommands(db, config, node, recordId(request), z.uuid().parse(request.headers['x-job-lease']));
    for (const commandId of ids)
      await db.rows('DELETE FROM node_commands WHERE id=$1 AND "jobId"=$2 AND "nodeId"=$3', [
        commandId,
        recordId(request),
        node.id,
      ]);
    return { ok: true };
  });
  app.get('/api/executor/jobs/:id/assets/:assetId', { config: { public: true } }, async (request, reply) => {
    const node = await authenticateNode(
      db,
      request.headers.authorization,
      request.headers['x-executor-instance'],
    );
    const params = z.object({ id: z.uuid(), assetId: z.uuid() }).parse(request.params);
    const asset = await nodeAsset(
      db,
      node,
      params.id,
      z.uuid().parse(request.headers['x-job-lease']),
      params.assetId,
    );
    reply.type(asset.mime).header('Content-Length', asset.size);
    return reply.send(createReadStream(assetPath(config.dataDir, asset.storageKey)));
  });
}
