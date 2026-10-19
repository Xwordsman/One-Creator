import type { Database } from './database.js';
import { id } from './records.js';
import { callModel, type ChatProvider } from './ai.js';

export interface UsageInput {
  workspaceId: string;
  accountId?: string | null;
  jobId?: string | null;
  callKey: string;
  title: string;
  capability: string;
  baseUrl: string;
  model: string;
  inputText?: string;
  outputText?: string;
  usage?: Record<string, number> | null;
  units?: number;
  status?: 'succeeded' | 'failed' | 'unknown';
  usageSource?: 'reported' | 'estimated' | 'unknown';
}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
export async function recordUsage(db: Database, input: UsageInput) {
  let inputTokens = count(input.usage?.prompt_tokens ?? input.usage?.input_tokens);
  let outputTokens = count(input.usage?.completion_tokens ?? input.usage?.output_tokens);
  const status = input.status ?? 'succeeded';
  let usageSource =
    input.usageSource ??
    (inputTokens !== null || outputTokens !== null || input.units !== undefined ? 'reported' : 'unknown');
  if (usageSource === 'unknown' && status === 'succeeded' && input.outputText !== undefined) {
    usageSource = 'estimated';
    inputTokens = Math.ceil([...(input.inputText ?? '')].length / 2);
    outputTokens = Math.ceil([...input.outputText].length / 2);
  }
  const [price] = await db.rows<Record<string, unknown>>(
    'SELECT * FROM model_prices WHERE "workspaceId"=$1 AND "baseUrl"=$2 AND model=$3',
    [input.workspaceId, input.baseUrl.replace(/\/+$/, ''), input.model],
  );
  let cost: number | null = null;
  if (price && status === 'succeeded') {
    if (input.units !== undefined && price.unitPrice !== null) cost = input.units * Number(price.unitPrice);
    else if (
      inputTokens !== null &&
      outputTokens !== null &&
      price.inputPerMillion !== null &&
      price.outputPerMillion !== null
    )
      cost =
        (inputTokens * Number(price.inputPerMillion) + outputTokens * Number(price.outputPerMillion)) /
        1000000;
  }
  await db.rows(
    `INSERT INTO usage_entries(id,"workspaceId","accountId","jobId","callKey",title,capability,"baseUrl",model,"inputTokens","outputTokens",units,"usageSource",cost,currency,"priceSnapshot",status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT("workspaceId","callKey") DO NOTHING`,
    [
      id(),
      input.workspaceId,
      input.accountId ?? null,
      input.jobId ?? null,
      input.callKey,
      input.title,
      input.capability,
      input.baseUrl,
      input.model,
      inputTokens,
      outputTokens,
      input.units ?? null,
      usageSource,
      cost,
      price?.currency ?? null,
      price ? JSON.stringify(price) : null,
      status,
    ],
  );
}
export async function measuredModel(
  db: Database,
  provider: ChatProvider,
  messages: { role: string; content: string }[],
  context: Pick<UsageInput, 'workspaceId' | 'accountId' | 'jobId' | 'callKey' | 'title'>,
  signal?: AbortSignal,
  test = false,
) {
  let result: Awaited<ReturnType<typeof callModel>>;
  try {
    result = await callModel(provider, messages, signal, test);
  } catch (error) {
    await recordUsage(db, { ...context, capability: 'text', ...provider, status: 'unknown' }).catch(() => {});
    throw error;
  }
  await recordUsage(db, {
    ...context,
    capability: 'text',
    ...provider,
    usage: result.usage,
    inputText: messages.map((message) => message.content).join('\n'),
    outputText: result.output,
  });
  return result;
}
