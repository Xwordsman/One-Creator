import type { FastifyInstance } from 'fastify';
import { createBackup } from '@one-creator/server/backup';
import { workspace, type ApiContext } from './context.js';

export async function backupRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  app.get(
    '/api/settings/backup',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const data = await createBackup(db, config, workspace(request));
      reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="one-creator-backup-${new Date().toISOString().slice(0, 10)}.zip"`,
        );
      return data;
    },
  );
}
