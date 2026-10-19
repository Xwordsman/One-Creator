import type { Material } from '@one-creator/core';
import type { Database } from './database.js';
import type { AppConfig } from './config.js';
import type { AutomationContext } from './automation-types.js';
import { capabilityProvider, embed, type CapabilityRecord } from './capabilities.js';
import { canonical } from './studio.js';
import { tokenHash } from './crypto.js';
import { id, owned } from './records.js';
import { accountScope } from './permissions.js';
import { AppError } from './errors.js';

export const embeddingFingerprint = (provider: CapabilityRecord) =>
  tokenHash(canonical({ baseUrl: provider.baseUrl, model: provider.model, options: provider.options }));
function chunks(body: string) {
  const chars = Array.from(body);
  const result: string[] = [];
  for (let start = 0; start < chars.length; start += 700) {
    const text = chars.slice(start, start + 800).join('');
    if (text.trim()) result.push(text);
  }
  return result;
}
export async function rebuildEmbeddings(context: AutomationContext) {
  const provider = await capabilityProvider(context.db, context.job.workspaceId, 'embedding');
  const fingerprint = embeddingFingerprint(provider),
    completed = (context.job.progress.completed ?? []) as { id: string; revision: number; chunks: number }[],
    skipped: string[] = [];
  for (const materialId of context.input.data.materialIds as string[]) {
    if (completed.some((item) => item.id === materialId)) continue;
    await context.report('embedding', {
      ...context.job.progress,
      completed,
      modelFingerprint: fingerprint,
      total: (context.input.data.materialIds as string[]).length,
      done: completed.length,
    });
    const material = await owned<Material>(context.db, 'materials', context.job.workspaceId, materialId);
    if (material.revision !== context.input.references[materialId].revision || material.archived) {
      skipped.push(materialId);
      continue;
    }
    const parts = chunks(material.body),
      existing = new Set(
        (
          await context.db.rows<{ chunkIndex: number }>(
            'SELECT "chunkIndex" FROM material_chunks WHERE "materialId"=$1 AND revision=$2 AND "modelFingerprint"=$3',
            [material.id, material.revision, fingerprint],
          )
        ).map((row) => row.chunkIndex),
      );
    const missing = parts.map((body, index) => ({ body, index })).filter((part) => !existing.has(part.index));
    for (let start = 0; start < missing.length; start += 16) {
      const batch = missing.slice(start, start + 16);
      const vectors = await embed(
        context.db,
        context.config,
        provider,
        batch.map((part) => part.body),
        {
          workspaceId: context.job.workspaceId,
          accountId: material.accountId,
          jobId: context.job.id,
          callKey: `${context.job.id}:${material.id}:${start}`,
          title: `语义索引 · ${material.title}`,
        },
        context.signal,
      );
      await context.report('embedding', {
        ...context.job.progress,
        completed,
        current: material.title,
        chunk: start,
        total: parts.length,
      });
      await context.db.transaction(async (sql) => {
        for (const [entry, part] of batch.entries())
          await sql.rows(
            `INSERT INTO material_chunks(id,"workspaceId","accountId","materialId",revision,"modelFingerprint","chunkIndex",body,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [
              id(),
              context.job.workspaceId,
              material.accountId,
              material.id,
              material.revision,
              fingerprint,
              part.index,
              part.body,
              JSON.stringify(vectors[entry]),
            ],
          );
      });
    }
    // Once this revision is fully indexed, older revisions and models of the same material are never read again.
    await context.db.rows(
      'DELETE FROM material_chunks WHERE "materialId"=$1 AND NOT (revision=$2 AND "modelFingerprint"=$3)',
      [material.id, material.revision, fingerprint],
    );
    completed.push({ id: material.id, revision: material.revision, chunks: parts.length });
    await context.report('embedding', {
      ...context.job.progress,
      completed,
      done: completed.length,
      total: (context.input.data.materialIds as string[]).length,
    });
  }
  return {
    model: provider.model,
    modelFingerprint: fingerprint,
    completed,
    skipped,
    message: skipped.length ? '部分素材在建索引期间改变，请再发起重建' : '语义索引已就绪',
  };
}
function similarity(a: number[], b: number[]) {
  if (a.length !== b.length) return -1;
  let dot = 0,
    left = 0,
    right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    left += a[index] ** 2;
    right += b[index] ** 2;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
export async function searchMaterials(
  db: Database,
  config: AppConfig,
  ws: string,
  q: string,
  accountId?: string,
) {
  const params: unknown[] = [ws];
  let where = 'm."workspaceId"=$1 AND m.archived=false';
  if (accountId) {
    await owned(db, 'accounts', ws, accountId);
    params.push(accountId);
    where += ` AND (m."accountId" IS NULL OR m."accountId"=$${params.length})`;
  }
  where += ` AND ${accountScope(params, 'm."accountId"')}`;
  try {
    const provider = await capabilityProvider(db, ws, 'embedding');
    params.push(embeddingFingerprint(provider));
    const rows = await db.rows<{
      materialId: string;
      title: string;
      url: string;
      body: string;
      revision: number;
      embedding: number[];
    }>(
      `SELECT c."materialId",m.title,m.url,c.body,c.revision,c.embedding FROM material_chunks c JOIN materials m ON m.id=c."materialId" AND m.revision=c.revision WHERE ${where} AND c."modelFingerprint"=$${params.length} LIMIT 20000`,
      params,
    );
    if (!rows.length) throw new AppError(400, 'INDEX_REQUIRED', '当前模型还没有可用索引，请重建语义索引');
    const [vector] = await embed(db, config, provider, [q], {
      workspaceId: ws,
      accountId,
      callKey: `search:${id()}`,
      title: '语义检索',
    });
    return {
      mode: 'semantic',
      model: provider.model,
      items: rows
        .map(({ embedding, ...row }) => ({ ...row, score: similarity(vector, embedding) }))
        .filter((row) => row.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20),
    };
  } catch (error) {
    // Build a new parameter set: semantic queries append their model fingerprint.
    const values: unknown[] = [ws];
    let scope = 'm."workspaceId"=$1 AND m.archived=false';
    if (accountId) {
      values.push(accountId);
      scope += ` AND (m."accountId" IS NULL OR m."accountId"=$${values.length})`;
    }
    scope += ` AND ${accountScope(values, 'm."accountId"')}`;
    values.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const items = await db.rows(
      `SELECT m.id AS "materialId",m.title,m.url,left(m.body,1200) AS body,m.revision FROM materials m WHERE ${scope} AND (m.title ILIKE $${values.length} OR m.body ILIKE $${values.length} OR m.tags::text ILIKE $${values.length}) ORDER BY m."updatedAt" DESC LIMIT 20`,
      values,
    );
    return {
      mode: 'keyword',
      reason: error instanceof AppError ? error.message : '向量服务暂时不可用，已回退关键词检索',
      items,
    };
  }
}
