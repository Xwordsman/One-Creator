import type { FastifyInstance } from 'fastify';
import { providerSchema, type ContentDocument, type PublishTask } from '@one-creator/core';
import { encryptSecret, decryptSecret } from '@one-creator/server/crypto';
import { getProvider, type ProviderRecord } from '@one-creator/server/jobs';
import { callModel, validateProviderUrl } from '@one-creator/server/ai';
import { AppError } from '@one-creator/server/errors';
import { accountScope } from '@one-creator/server/permissions';
import { measuredModel } from '@one-creator/server/usage';
import { id } from '@one-creator/server/records';
import { workspace, type ApiContext } from './context.js';

export async function settingsRoutes(app: FastifyInstance, { db, config }: ApiContext) {
  const publicProvider = (provider: ProviderRecord) => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    hasKey: Boolean(provider.keyCipher),
    updatedAt: provider.updatedAt,
  });
  app.get('/api/settings/model', async (request) => {
    const [provider] = await db.rows<ProviderRecord>('SELECT * FROM providers WHERE "workspaceId"=$1', [
      workspace(request),
    ]);
    return provider ? publicProvider(provider) : null;
  });
  app.put('/api/settings/model', async (request) => {
    const input = providerSchema.parse(request.body);
    const ws = workspace(request);
    const baseUrl = validateProviderUrl(input.baseUrl);
    const [previous] = await db.rows<ProviderRecord>('SELECT * FROM providers WHERE "workspaceId"=$1', [ws]);
    if (!input.apiKey?.trim() && !previous) throw new AppError(400, 'KEY_REQUIRED', '首次配置请填写 API Key');
    if (!input.apiKey?.trim() && previous?.baseUrl !== baseUrl)
      throw new AppError(400, 'KEY_REQUIRED', '更换模型服务地址时，请重新填写 API Key');
    const keyCipher = input.apiKey?.trim()
      ? encryptSecret(input.apiKey.trim(), config.encryptionKey, ws)
      : previous!.keyCipher;
    const [provider] = await db.rows<ProviderRecord>(
      `INSERT INTO providers("workspaceId",name,"baseUrl",model,"keyCipher") VALUES($1,$2,$3,$4,$5) ON CONFLICT("workspaceId") DO UPDATE SET name=excluded.name,"baseUrl"=excluded."baseUrl",model=excluded.model,"keyCipher"=excluded."keyCipher","updatedAt"=now() RETURNING *`,
      [ws, input.name, baseUrl, input.model, keyCipher],
    );
    return publicProvider(provider);
  });
  app.post(
    '/api/settings/model/test',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request) => {
      const ws = workspace(request);
      const provider = await getProvider(db, ws);
      const started = Date.now();
      await measuredModel(
        db,
        { ...provider, apiKey: decryptSecret(provider.keyCipher, config.encryptionKey, ws) },
        [{ role: 'user', content: '请只回复 OK' }],
        { workspaceId: ws, callKey: `connection-test:${id()}`, title: '模型连接测试' },
        undefined,
        true,
      );
      return { ok: true, model: provider.model, elapsedMs: Date.now() - started };
    },
  );
  app.get('/api/dashboard', async (request) => {
    const ws = workspace(request);
    const parameters: unknown[] = [ws];
    const accountsScope = accountScope(parameters, 'id', false);
    const scope = accountScope(parameters);
    const [counts] = await db.rows(
      `SELECT
      (SELECT count(*)::int FROM accounts WHERE "workspaceId"=$1 AND active=true AND ${accountsScope}) AS accounts,
      (SELECT count(*)::int FROM documents WHERE "workspaceId"=$1 AND status<>'archived' AND ${scope}) AS documents,
      (SELECT count(*)::int FROM materials WHERE "workspaceId"=$1 AND archived=false AND ${scope}) AS materials,
      (SELECT count(*)::int FROM ideas WHERE "workspaceId"=$1 AND status IN ('inbox','selected') AND ${scope}) AS ideas,
      (SELECT count(*)::int FROM publish_tasks WHERE "workspaceId"=$1 AND status IN ('planned','waiting_user','submitting','draft_saved','verification_required') AND ${scope}) AS planned,
      (SELECT count(*)::int FROM publish_tasks WHERE "workspaceId"=$1 AND status='published' AND ${scope}) AS published`,
      parameters,
    );
    const docParameters: unknown[] = [ws];
    const docScope = accountScope(docParameters, 'd."accountId"');
    const documents = await db.rows<ContentDocument>(
      `SELECT d.*,a.name AS "accountName",a.platform FROM documents d LEFT JOIN accounts a ON a.id=d."accountId" WHERE d."workspaceId"=$1 AND d.status<>'archived' AND ${docScope} ORDER BY d."updatedAt" DESC LIMIT 5`,
      docParameters,
    );
    const taskParameters: unknown[] = [ws];
    const taskScope = accountScope(taskParameters);
    const tasks = await db.rows<PublishTask>(
      `SELECT * FROM publish_tasks WHERE "workspaceId"=$1 AND status IN ('planned','waiting_user','submitting','draft_saved','verification_required') AND ${taskScope} ORDER BY "scheduledAt" ASC NULLS FIRST LIMIT 4`,
      taskParameters,
    );
    return { counts, documents, tasks };
  });
}
