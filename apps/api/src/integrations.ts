import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  accountSchema,
  documentSchema,
  jobSchema,
  publishSchema,
  ideaSchema,
  materialSchema,
} from '@one-creator/core';
import { newToken, encryptSecret } from '@one-creator/server/crypto';
import { id, owned, insert, update } from '@one-creator/server/records';
import { AppError } from '@one-creator/server/errors';
import { workspace, recordId, pagination, type ApiContext } from './context.js';

const webhookInput = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.url({ protocol: /^https?$/ }),
  events: z
    .array(z.string().regex(/^(content|task|publication|account)\.(\*|[a-z_]+)$/))
    .min(1)
    .max(30),
  enabled: z.boolean().default(true),
});
const tools = [
  {
    name: 'list_accounts',
    description: '列出有权访问的账号档案；发布能力请用 get_account_capabilities 查询',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_account_capabilities',
    description: '查询一个账号当前的草稿、发布、调度与数据能力及原因；未验证的能力为 unknown，不代表可用',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_automation_task',
    description:
      '查询创作 / 发布自动化任务；发布结果以 status 与平台核对为准，needs_verification 表示结果不确定',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_contents',
    description: '搜索当前授权范围的文稿',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        accountId: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_content',
    description: '读取一份文稿及修订和引用上下文',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_content',
    description: '创建工作台草稿，不代表平台发布',
    inputSchema: z.toJSONSchema(documentSchema, { io: 'input' }),
  },
  {
    name: 'create_ai_task',
    description: '基于指定修订创建 AI 任务，返回任务状态；需要 requestId 去重',
    inputSchema: z.toJSONSchema(jobSchema.extend({ requestId: z.string().min(8).max(120) }), { io: 'input' }),
  },
  {
    name: 'get_task',
    description: '查询后台任务的真实状态，草稿成功不代表已发布',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_platform_draft',
    description: '将已冻结的发布计划保存为公众号草稿；能力、权限和幂等校验由业务 API 执行',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string', format: 'uuid' }, requestId: { type: 'string', minLength: 8 } },
      required: ['planId', 'requestId'],
      additionalProperties: false,
    },
  },
];
export async function integrationRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/webhooks', async (request) => ({
    items: await db.rows(
      'SELECT id,name,url,events,enabled,"createdAt","updatedAt" FROM webhook_subscriptions WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC',
      [workspace(request)],
    ),
  }));
  app.post('/api/webhooks', async (request, reply) => {
    const input = webhookInput.parse(request.body);
    const target = new URL(input.url);
    if (target.username || target.password)
      throw new AppError(400, 'WEBHOOK_URL', '接收地址不能包含账号密码');
    const ws = workspace(request),
      subscriptionId = id(),
      secret = newToken();
    await insert(db, 'webhook_subscriptions', {
      ...input,
      id: subscriptionId,
      workspaceId: ws,
      secretCipher: encryptSecret(secret, config.encryptionKey, `${ws}:webhook:${subscriptionId}`),
    });
    reply.code(201);
    return { id: subscriptionId, ...input, secret };
  });
  app.put('/api/webhooks/:id', async (request) => {
    const input = webhookInput.parse(request.body);
    const ws = workspace(request),
      subscriptionId = recordId(request);
    await db.transaction(async (sql) => {
      await owned(sql, 'webhook_subscriptions', ws, subscriptionId, true);
      await update(sql, 'webhook_subscriptions', ws, subscriptionId, {
        ...input,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await sql.rows(
        `UPDATE webhook_deliveries SET status='failed',error='订阅配置已改变，旧投递停止',"leaseToken"=NULL,"leaseUntil"=NULL WHERE "subscriptionId"=$1 AND status IN ('queued','running')`,
        [subscriptionId],
      );
    });
    return { id: subscriptionId, ...input };
  });
  app.get('/api/webhooks/:id/deliveries', async (request) => {
    const ws = workspace(request),
      subscriptionId = recordId(request);
    await owned(db, 'webhook_subscriptions', ws, subscriptionId);
    const { limit, offset } = pagination(request.query);
    const items = await db.rows(
      'SELECT id,"eventId",status,attempts,"responseCode",error,"createdAt","finishedAt" FROM webhook_deliveries WHERE "workspaceId"=$1 AND "subscriptionId"=$2 ORDER BY "createdAt" DESC LIMIT $3 OFFSET $4',
      [ws, subscriptionId, limit, offset],
    );
    const [{ total }] = await db.rows<{ total: number }>(
      'SELECT count(*)::int AS total FROM webhook_deliveries WHERE "workspaceId"=$1 AND "subscriptionId"=$2',
      [ws, subscriptionId],
    );
    return { items, total, limit, offset };
  });
  app.get('/api/openapi.json', async () => {
    const schemas = {
      accounts: z.toJSONSchema(accountSchema, { io: 'input' }),
      documents: z.toJSONSchema(documentSchema, { io: 'input' }),
      ideas: z.toJSONSchema(ideaSchema, { io: 'input' }),
      materials: z.toJSONSchema(materialSchema, { io: 'input' }),
      jobs: z.toJSONSchema(jobSchema, { io: 'input' }),
      publishing: z.toJSONSchema(publishSchema, { io: 'input' }),
    };
    const paths: Record<string, unknown> = {};
    for (const [resource, schema] of Object.entries(schemas)) {
      paths[`/api/v1/${resource}`] = {
        get: {
          summary: `列出 ${resource}`,
          parameters: [
            { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0 } },
          ],
          responses: { 200: { description: 'items、total、limit、offset' } },
        },
        post: {
          summary: `创建 ${resource}`,
          parameters: ['jobs', 'publishing'].includes(resource)
            ? [
                {
                  in: 'header',
                  name: 'Idempotency-Key',
                  required: true,
                  schema: { type: 'string', minLength: 8 },
                },
              ]
            : [],
          requestBody: { required: true, content: { 'application/json': { schema } } },
          responses: {
            201: { description: '创建的资源' },
            202: { description: '已排队的任务' },
            400: { description: '输入校验失败' },
            403: { description: '权限不足' },
            409: { description: '版本或幂等冲突' },
          },
        },
      };
    }
    const idParam = [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }];
    const page = [
      { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500 } },
      { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0 } },
    ];
    const key = {
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', minLength: 8 },
    };
    paths['/api/v1/jobs/{id}'] = {
      get: {
        summary: '查询任务',
        parameters: idParam,
        responses: { 200: { description: '任务、阶段、尝试、输出；需要读取授权' } },
      },
    };
    paths['/api/v1/automation'] = {
      get: {
        summary: '列出自动化任务（选题、审校、配图、视频、发布与核对）',
        parameters: [
          ...page,
          { in: 'query', name: 'kind', schema: { type: 'string' } },
          { in: 'query', name: 'accountId', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { 200: { description: 'items、total、limit、offset' } },
      },
      post: {
        summary: '创建自动化任务；kind 与 data 见 /api/v1/automation/catalog',
        parameters: [key],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['kind'],
                properties: {
                  kind: { type: 'string' },
                  accountId: { type: ['string', 'null'], format: 'uuid' },
                  documentId: { type: ['string', 'null'], format: 'uuid' },
                  data: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          202: { description: '已排队的任务；平台发布需要 publish:write' },
          400: { description: '输入或能力校验失败' },
          403: { description: '权限不足' },
          409: { description: '幂等冲突或计划状态不允许' },
        },
      },
    };
    paths['/api/v1/automation/catalog'] = {
      get: {
        summary: '各类自动化任务的输入 JSON Schema 与是否已接入',
        responses: { 200: { description: 'kind → {name, schema, implemented}' } },
      },
    };
    paths['/api/v1/automation/{id}'] = {
      get: {
        summary: '查询自动化任务的阶段、进度、结果与采用记录',
        parameters: idParam,
        responses: { 200: { description: 'needs_verification 表示平台结果不确定，不是成功' } },
      },
    };
    paths['/api/v1/automation/{id}/retry'] = {
      post: {
        summary: '从检查点继续失败或取消的任务',
        parameters: [...idParam, key],
        responses: { 202: { description: '新的尝试' } },
      },
    };
    paths['/api/v1/automation/{id}/cancel'] = {
      post: {
        summary: '取消排队或执行中的任务；平台可能已接收时拒绝',
        parameters: idParam,
        responses: { 200: { description: '已取消' }, 409: { description: '不能取消' } },
      },
    };
    paths['/api/v1/tokens'] = {
      get: { summary: '列出访问令牌（不含令牌值）', responses: { 200: { description: 'items' } } },
      post: {
        summary: '创建访问令牌，令牌值只返回一次；需要 settings:admin',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  scopes: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['content:read', 'content:write', 'ai:run', 'publish:write', 'settings:admin'],
                    },
                  },
                  days: { type: 'integer', minimum: 1, maximum: 365 },
                  accountIds: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
        },
        responses: { 201: { description: '含 token 字段' } },
      },
    };
    paths['/api/v1/tokens/{id}'] = {
      delete: {
        summary: '撤销访问令牌，立即失效',
        parameters: idParam,
        responses: { 200: { description: '已撤销' } },
      },
    };
    paths['/api/v1/webhooks'] = {
      get: { summary: '列出 Webhook 订阅', responses: { 200: { description: 'items' } } },
      post: {
        summary:
          '创建订阅，签名密钥只返回一次；投递头含 X-OneCreator-Event-Id、X-OneCreator-Timestamp、X-OneCreator-Signature（sha256=HMAC(secret, timestamp.body)）',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: z.toJSONSchema(webhookInput, { io: 'input' }) } },
        },
        responses: { 201: { description: '含 secret 字段' } },
      },
    };
    paths['/api/v1/webhooks/{id}/deliveries'] = {
      get: {
        summary: '投递记录；重投保留同一事件 ID',
        parameters: [...idParam, ...page],
        responses: { 200: { description: 'items、total、limit、offset' } },
      },
    };
    return {
      openapi: '3.1.0',
      info: {
        title: 'One-Creator API',
        version: '1.0.0-alpha.1',
        description: 'Bearer 令牌按权限和账号范围执行；写稿、草稿保存和正式发布是独立操作。',
      },
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      paths,
    };
  });
  app.post('/api/mcp', async (request, reply) => {
    // Protocol problems are JSON-RPC errors; business failures stay tool results with isError.
    const envelope = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!envelope.success) {
      reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const message = envelope.data;
    const respond = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
    const invalidParams = (text: string) => ({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32602, message: text },
    });
    if (message.id === undefined) {
      reply.code(202).send();
      return;
    }
    if (message.method === 'initialize')
      return respond({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'one-creator', version: '0.1.0-alpha.1' },
      });
    if (message.method === 'ping') return respond({});
    if (message.method === 'tools/list') return respond({ tools });
    if (message.method !== 'tools/call')
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    const call = z
      .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
      .safeParse(message.params);
    if (!call.success) return invalidParams('Invalid params: tools/call 需要 name 与 arguments');
    const { name, arguments: args } = call.data;
    if (!tools.some((item) => item.name === name)) return invalidParams(`Unknown tool: ${name}`);
    const headers: Record<string, string> = {
      'x-creator-client': 'web',
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : { cookie: request.headers.cookie ?? '' }),
    };
    let method: 'GET' | 'POST' = 'GET',
      url = '',
      body: unknown;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args))
      if (['q', 'limit', 'accountId'].includes(key) && value !== undefined) query.set(key, String(value));
    try {
      if (name === 'list_accounts') url = `/api/accounts?${query}`;
      else if (name === 'list_contents') url = `/api/documents?${query}`;
      else if (name === 'get_content') url = `/api/documents/${z.uuid().parse(args.id)}`;
      else if (name === 'get_task') url = `/api/jobs/${z.uuid().parse(args.id)}`;
      else if (name === 'get_account_capabilities')
        url = `/api/accounts/${z.uuid().parse(args.id)}/capabilities`;
      else if (name === 'get_automation_task') url = `/api/automation/${z.uuid().parse(args.id)}`;
      else if (name === 'create_content') {
        method = 'POST';
        url = '/api/documents';
        body = args;
      } else if (name === 'create_ai_task') {
        method = 'POST';
        url = '/api/jobs';
        body = args;
        headers['idempotency-key'] = z.string().min(8).max(120).parse(args.requestId);
      } else {
        method = 'POST';
        url = `/api/publishing/${z.uuid().parse(args.planId)}/wechat-draft`;
        body = {};
        headers['idempotency-key'] = z.string().min(8).max(120).parse(args.requestId);
      }
    } catch (error) {
      if (error instanceof ZodError) return invalidParams(`Invalid params for ${name}`);
      throw error;
    }
    const result = await app.inject({ method, url, headers, payload: body as Record<string, unknown> });
    return respond({
      isError: result.statusCode >= 400,
      content: [{ type: 'text', text: result.body }],
      structuredContent: result.json(),
    });
  });
}
