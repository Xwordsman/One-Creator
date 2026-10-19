import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectionSchema, type Account } from '@one-creator/core';
import {
  findConnection,
  publicConnection,
  saveConnection,
  removeConnection,
} from '@one-creator/server/connections';
import { draftAdapter } from '@one-creator/server/platforms/index';
import { owned } from '@one-creator/server/records';
import { AppError } from '@one-creator/server/errors';
import { recordId, workspace, type ApiContext } from './context.js';

export async function connectionRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get('/api/accounts/:id/connection', async (request) => {
    const ws = workspace(request);
    const accountId = recordId(request);
    await owned(db, 'accounts', ws, accountId);
    return publicConnection(accountId, await findConnection(db, ws, accountId));
  });
  app.put(
    '/api/accounts/:id/connection',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const ws = workspace(request);
      const accountId = recordId(request);
      const connection = await saveConnection(
        db,
        config,
        ws,
        accountId,
        connectionSchema.parse(request.body),
      );
      await draftAdapter('wechat')!.check(db, config, connection);
      return publicConnection(accountId, await findConnection(db, ws, accountId));
    },
  );
  app.post(
    '/api/accounts/:id/connection/check',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const ws = workspace(request);
      const accountId = recordId(request);
      const account = await owned<Account>(db, 'accounts', ws, accountId);
      const connection = await findConnection(db, ws, accountId);
      const adapter = draftAdapter(account.platform);
      if (!connection || !adapter)
        throw new AppError(400, 'CONNECTION_REQUIRED', '请先保存这个账号的连接配置');
      await adapter.check(db, config, connection);
      return publicConnection(accountId, await findConnection(db, ws, accountId));
    },
  );
  app.delete('/api/accounts/:id/connection', async (request) => {
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .parse(request.body);
    return removeConnection(db, workspace(request), recordId(request), expectedRevision);
  });
}
