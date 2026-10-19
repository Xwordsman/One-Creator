import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { capabilitySchema } from '@one-creator/core';
import {
  capabilityProvider,
  saveCapability,
  publicCapability,
  capabilityRequest,
  boundedJson,
  embed,
  type CapabilityRecord,
} from '@one-creator/server/capabilities';
import { id } from '@one-creator/server/records';
import { workspace, type ApiContext } from './context.js';

export async function capabilityRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/settings/providers', async (request) => ({
    items: (
      await db.rows<CapabilityRecord>('SELECT * FROM capability_providers WHERE "workspaceId"=$1', [
        workspace(request),
      ])
    ).map(publicCapability),
  }));
  app.put('/api/settings/providers/:capability', async (request) => {
    const { capability } = z.object({ capability: capabilitySchema }).parse(request.params);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        baseUrl: z.url(),
        model: z.string().trim().min(1).max(150),
        apiKey: z.string().max(1000).optional(),
        expectedRevision: z.number().int().nonnegative(),
        options: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(request.body);
    return saveCapability(db, config, workspace(request), { ...input, capability });
  });
  app.post('/api/settings/providers/:capability/test', async (request) => {
    const { capability } = z.object({ capability: capabilitySchema }).parse(request.params);
    const ws = workspace(request),
      provider = await capabilityProvider(db, ws, capability),
      started = Date.now();
    if (capability === 'embedding') {
      const vectors = await embed(db, config, provider, ['连接测试'], {
        workspaceId: ws,
        callKey: `embedding-test:${id()}`,
        title: '向量连接测试',
      });
      return { ok: true, verified: true, dimensions: vectors[0].length, elapsedMs: Date.now() - started };
    }
    const result = await boundedJson(
      await capabilityRequest(config, provider, capability === 'video' ? '/health' : '/models'),
    );
    return {
      ok: true,
      verified: false,
      message:
        capability === 'video'
          ? '媒体服务可访问，需运行实际任务核对输出'
          : '模型列表可访问，实际生成与转写需用任务验证',
      elapsedMs: Date.now() - started,
      models: Array.isArray(result.data)
        ? result.data.map((row: Record<string, unknown>) => row.id)
        : undefined,
    };
  });
}
