import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionUser } from '@one-creator/core';
import type { Database } from '@one-creator/server/database';
import type { AppConfig } from '@one-creator/server/config';
import { AppError } from '@one-creator/server/errors';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}
export interface ApiContext {
  db: Database;
  config: AppConfig;
}
export const workspace = (request: FastifyRequest) => {
  if (!request.user) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  return request.user.workspaceId;
};
export const recordId = (request: FastifyRequest) => z.object({ id: z.uuid() }).parse(request.params).id;
export const pagination = (query: unknown) =>
  z
    .object({
      q: z.string().max(200).default(''),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    })
    .parse(query);
export const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
export function idempotencyKey(request: FastifyRequest) {
  return z.string().min(8).max(120).parse(request.headers['idempotency-key']);
}
