import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { AppConfig } from '@one-creator/server/config';
import type { Database } from '@one-creator/server/database';
import { AppError } from '@one-creator/server/errors';
import { startWorker } from '@one-creator/server/jobs';
import { authRoutes, findSession } from './auth.js';
import { accountRoutes } from './accounts.js';
import { libraryRoutes } from './library.js';
import { documentRoutes } from './documents.js';
import { jobRoutes } from './tasks.js';
import { publishingRoutes } from './publishing.js';
import { settingsRoutes } from './settings.js';
import { backupRoutes } from './backup-routes.js';
import { connectionRoutes } from './connections.js';
import { activityRoutes } from './activities.js';
import { accessContext, authorize } from '@one-creator/server/permissions';
import { administrationRoutes } from './administration.js';
import { integrationRoutes } from './integrations.js';
import { studioRoutes } from './studio.js';
import { capabilityRoutes } from './capabilities.js';
import { automationRoutes } from './automation.js';
import { discoveryRoutes } from './discovery.js';
import { analyticsRoutes } from './analytics.js';
import { nodeRoutes } from './nodes.js';

/** The router decodes percent-encoded paths, so checks follow the matched route rather than the raw URL. */
const routePath = (request: FastifyRequest) => request.routeOptions.url ?? request.url.split('?')[0];
const apiRequest = (request: FastifyRequest) =>
  request.url.startsWith('/api/') || routePath(request).startsWith('/api/');

export async function buildApp(
  db: Database,
  config: AppConfig,
  options: { logger?: boolean; worker?: boolean; staticRoot?: string } = {},
) {
  const app = Fastify({
    rewriteUrl: (request) => request.url?.replace(/^\/api\/v1\//, '/api/') ?? '/',
    bodyLimit: 2 * 1024 * 1024,
    logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 2 } });
  await app.register(rateLimit, { global: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', (_request, _reply, done) => accessContext.run({ user: null }, done));
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (apiRequest(request)) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && apiRequest(request)) {
      if (
        request.headers['x-creator-client'] !== 'web' &&
        !request.headers.authorization?.startsWith('Bearer ')
      )
        throw new AppError(403, 'CLIENT_HEADER_REQUIRED', '请求缺少工作台客户端标识');
      if (request.headers.origin && request.headers.origin !== config.origin)
        throw new AppError(403, 'ORIGIN_REJECTED', '请求来源与 APP_ORIGIN 不一致');
    }
  });
  app.addHook('preHandler', async (request) => {
    if (!apiRequest(request) || request.routeOptions.config.public) return;
    request.user = await findSession(db, request);
    if (!request.user) throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
    accessContext.getStore()!.user = request.user;
    authorize(request.method, routePath(request), request.user);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const fields = Object.fromEntries(error.issues.map((issue) => [issue.path.join('.'), issue.message]));
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: `请检查填写内容：${error.issues[0]?.path.join('.') || '请求数据'}`,
        fields,
      });
    }
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message, fields: error.fields });
    const known = error as { code?: string; statusCode?: number };
    // MCP clients expect JSON-RPC errors; a body that is not JSON is a parse error (-32700).
    if (known.code === 'FST_ERR_CTP_INVALID_JSON_BODY' && routePath(request) === '/api/mcp')
      return reply
        .code(400)
        .send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    if (known.code === '23505')
      return reply
        .code(409)
        .send({ code: 'DUPLICATE', message: '记录已存在，请检查账号平台标识或刷新后重试' });
    if (known.code === '23503')
      return reply
        .code(400)
        .send({ code: 'REFERENCE_ERROR', message: '关联的记录已经不存在，请刷新后重新选择' });
    if (known.statusCode === 413)
      return reply.code(413).send({
        code: 'TOO_LARGE',
        message: request.url.startsWith('/api/media')
          ? '媒体文件过大，最多 128 MB'
          : '文件或请求过大，单张图片最多 12 MB',
      });
    if (known.statusCode === 429)
      return reply.code(429).send({ code: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试' });
    if (known.statusCode && known.statusCode < 500)
      return reply.code(known.statusCode).send({ code: 'BAD_REQUEST', message: '请求格式不正确' });
    app.log.error(
      {
        requestId: request.id,
        code: known.code,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Request failed',
    );
    return reply
      .code(500)
      .send({ code: 'INTERNAL_ERROR', message: '服务暂时无法完成操作，请稍后重试', requestId: request.id });
  });
  app.get('/api/health', { config: { public: true } }, async () => {
    await db.rows('SELECT 1');
    return { status: 'ok', version: '0.1.0-alpha.1' };
  });
  const context = { db, config };
  await authRoutes(app, context);
  await accountRoutes(app, context);
  await connectionRoutes(app, context);
  await activityRoutes(app, context);
  await administrationRoutes(app, context);
  await integrationRoutes(app, context);
  await studioRoutes(app, context);
  await capabilityRoutes(app, context);
  await automationRoutes(app, context);
  await discoveryRoutes(app, context);
  await analyticsRoutes(app, context);
  await nodeRoutes(app, context);
  await libraryRoutes(app, context);
  await documentRoutes(app, context);
  await jobRoutes(app, context);
  await publishingRoutes(app, context);
  await settingsRoutes(app, context);
  await backupRoutes(app, context);
  const staticRoot = options.staticRoot ?? path.resolve('apps/web/dist');
  if (existsSync(path.join(staticRoot, 'index.html'))) {
    await app.register(staticFiles, { root: staticRoot });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !path.extname(request.url.split('?')[0])
      )
        return reply.type('text/html').sendFile('index.html', { cacheControl: false });
      return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个接口' });
    });
  }
  let worker: ReturnType<typeof startWorker> | undefined;
  app.addHook('onReady', async () => {
    if (options.worker !== false && config.workerMode === 'inline') worker = startWorker(db, config);
  });
  app.addHook('onClose', async () => {
    await worker?.stop();
  });
  return app;
}
