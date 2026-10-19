import { capabilityNames, type CapabilityProvider, type ModelCapability } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { id } from './records.js';
import { validateProviderUrl } from './ai.js';
import { AppError, conflict } from './errors.js';
import { recordUsage } from './usage.js';

export interface CapabilityRecord extends Omit<CapabilityProvider, 'hasKey'> {
  workspaceId: string;
  keyCipher: string;
}
export function publicCapability(record: CapabilityRecord): CapabilityProvider {
  const { id, capability, name, baseUrl, model, options, revision, updatedAt } = record;
  return { id, capability, name, baseUrl, model, options, revision, updatedAt, hasKey: !!record.keyCipher };
}
export async function capabilityProvider(sql: Sql, workspaceId: string, capability: ModelCapability) {
  const [record] = await sql.rows<CapabilityRecord>(
    'SELECT * FROM capability_providers WHERE "workspaceId"=$1 AND capability=$2',
    [workspaceId, capability],
  );
  if (!record)
    throw new AppError(
      400,
      'CAPABILITY_NOT_CONFIGURED',
      `请先在设置中配置「${capabilityNames[capability]}」服务`,
    );
  return record;
}
/** A short, sanitized reason from a failing provider; credentials errors stay generic. */
async function failureReason(response: Response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const { value } = await reader.read();
    await reader.cancel();
    const parsed = JSON.parse(new TextDecoder().decode(value?.subarray(0, 4096)));
    const reason = parsed?.reason ?? parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    return typeof reason === 'string' ? reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : '';
  } catch {
    return '';
  }
}
export async function saveCapability(
  db: Database,
  config: AppConfig,
  workspaceId: string,
  input: {
    capability: ModelCapability;
    name: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    options: Record<string, unknown>;
    expectedRevision: number;
  },
) {
  return db.transaction(async (sql) => {
    const [previous] = await sql.rows<CapabilityRecord>(
      'SELECT * FROM capability_providers WHERE "workspaceId"=$1 AND capability=$2 FOR UPDATE',
      [workspaceId, input.capability],
    );
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      throw conflict('服务配置已改变，请刷新后再保存');
    const baseUrl = validateProviderUrl(input.baseUrl);
    if (!input.apiKey && (!previous || previous.baseUrl !== baseUrl))
      throw new AppError(400, 'KEY_REQUIRED', '首次配置或更换地址需要填写 API Key，本地无鉴权服务可填 local');
    const keyCipher = input.apiKey
      ? encryptSecret(input.apiKey, config.encryptionKey, `${workspaceId}:capability:${input.capability}`)
      : previous!.keyCipher;
    const [result] = await sql.rows<CapabilityRecord>(
      `INSERT INTO capability_providers(id,"workspaceId",capability,name,"baseUrl",model,"keyCipher",options) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT("workspaceId",capability) DO UPDATE SET name=excluded.name,"baseUrl"=excluded."baseUrl",model=excluded.model,"keyCipher"=excluded."keyCipher",options=excluded.options,revision=capability_providers.revision+1,"updatedAt"=now() RETURNING *`,
      [
        previous?.id ?? id(),
        workspaceId,
        input.capability,
        input.name,
        baseUrl,
        input.model,
        keyCipher,
        JSON.stringify(input.options),
      ],
    );
    return publicCapability(result);
  });
}
export async function capabilityRequest(
  config: AppConfig,
  provider: CapabilityRecord,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
) {
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${decryptSecret(provider.keyCipher, config.encryptionKey, `${provider.workspaceId}:capability:${provider.capability}`)}`,
        ...(body instanceof FormData ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
    });
  } catch {
    throw new AppError(502, 'CAPABILITY_NETWORK', '无法连接服务或响应超时，请检查配置后重试');
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new AppError(502, 'CAPABILITY_ERROR', '服务拒绝访问，请核对 API Key 和模型权限');
    }
    const reason = await failureReason(response);
    throw new AppError(
      502,
      'CAPABILITY_ERROR',
      `服务返回 HTTP ${response.status}${reason ? `：${reason}` : ''}`,
    );
  }
  return response;
}
export async function boundedJson(response: Response, maxBytes = 24 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError(502, 'CAPABILITY_EMPTY', '服务未返回内容');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError(502, 'CAPABILITY_TOO_LARGE', '服务响应超过容量限制');
    }
    chunks.push(item.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError(502, 'CAPABILITY_FORMAT', '服务返回内容不是兼容的 JSON');
  }
}
export async function embed(
  db: Database,
  config: AppConfig,
  provider: CapabilityRecord,
  texts: string[],
  context: { workspaceId: string; accountId?: string | null; jobId?: string; callKey: string; title: string },
  signal?: AbortSignal,
) {
  let data: Record<string, unknown>;
  try {
    data = await boundedJson(
      await capabilityRequest(
        config,
        provider,
        '/embeddings',
        { model: provider.model, input: texts },
        signal,
      ),
    );
  } catch (error) {
    await recordUsage(db, {
      ...context,
      baseUrl: provider.baseUrl,
      model: provider.model,
      capability: 'embedding',
      status: 'unknown',
    });
    throw error;
  }
  const rows = data.data as { index: number; embedding: number[] }[];
  if (
    !Array.isArray(rows) ||
    rows.length !== texts.length ||
    rows.some(
      (row) =>
        !Array.isArray(row.embedding) ||
        !row.embedding.length ||
        row.embedding.length > 8192 ||
        row.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)),
    )
  )
    throw new AppError(502, 'EMBEDDING_FORMAT', '向量数量或格式与输入不一致');
  rows.sort((a, b) => a.index - b.index);
  if (rows.some((row, index) => row.index !== index || row.embedding.length !== rows[0].embedding.length))
    throw new AppError(502, 'EMBEDDING_FORMAT', '向量维度或索引不一致');
  const usage = data.usage as Record<string, number> | undefined;
  await recordUsage(db, {
    ...context,
    baseUrl: provider.baseUrl,
    model: provider.model,
    capability: 'embedding',
    usage: usage
      ? { prompt_tokens: usage.prompt_tokens ?? usage.total_tokens, completion_tokens: 0 }
      : undefined,
  });
  return rows.map((row) => row.embedding);
}
