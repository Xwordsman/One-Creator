import { createHmac } from 'node:crypto';
import type { Database } from './database.js';
import type { AppConfig } from './config.js';
import { decryptSecret } from './crypto.js';
import { id } from './records.js';
import { fetchPublic } from './public-fetch.js';
import { AppError } from './errors.js';

export function webhookSignature(secret: string, timestamp: string, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export async function deliverWebhooks(db: Database, config: AppConfig, signal?: AbortSignal) {
  await db.exec(`INSERT INTO webhook_deliveries(id,"workspaceId","subscriptionId","eventId")
    SELECT gen_random_uuid(),s."workspaceId",s.id,e.id FROM webhook_subscriptions s JOIN workspace_events e ON e."workspaceId"=s."workspaceId"
    WHERE s.enabled=true AND e."createdAt">=s."createdAt" AND (s.events ? e.kind OR s.events ? (split_part(e.kind,'.',1)||'.*'))
    AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d."subscriptionId"=s.id AND d."eventId"=e.id)
    ORDER BY e."createdAt" LIMIT 100 ON CONFLICT DO NOTHING;
    UPDATE webhook_deliveries SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,error='投递进程已中断，使用相同事件 ID 重投',"leaseToken"=NULL,"leaseUntil"=NULL WHERE status='running' AND "leaseUntil"<now();`);
  const claimed = await db.transaction(async (sql) => {
    const [delivery] = await sql.rows<{
      id: string;
      workspaceId: string;
      subscriptionId: string;
      eventId: string;
      attempts: number;
    }>(
      `SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d."subscriptionId" WHERE d.status='queued' AND d."nextAt"<=now() AND s.enabled=true ORDER BY d."createdAt" LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
    );
    if (!delivery) return null;
    const leaseToken = id();
    await sql.rows(
      `UPDATE webhook_deliveries SET status='running',attempts=attempts+1,"leaseToken"=$1,"leaseUntil"=now()+interval '1 minute' WHERE id=$2`,
      [leaseToken, delivery.id],
    );
    return { ...delivery, attempts: delivery.attempts + 1, leaseToken };
  });
  if (!claimed) return;
  const [subscription] = await db.rows<{ url: string; secretCipher: string; enabled: boolean }>(
    'SELECT url,"secretCipher",enabled FROM webhook_subscriptions WHERE id=$1',
    [claimed.subscriptionId],
  );
  const [event] = await db.rows<{ id: string; kind: string; payload: unknown; createdAt: string }>(
    'SELECT id,kind,payload,"createdAt" FROM workspace_events WHERE id=$1',
    [claimed.eventId],
  );
  const body = JSON.stringify({
    id: event.id,
    type: event.kind,
    createdAt: event.createdAt,
    data: event.payload,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  let statusCode: number | null = null,
    error = '',
    blocked = false;
  try {
    if (!subscription.enabled) throw new Error('订阅已停用');
    const secret = decryptSecret(
      subscription.secretCipher,
      config.encryptionKey,
      `${claimed.workspaceId}:webhook:${claimed.subscriptionId}`,
    );
    const response = await fetchPublic(subscription.url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-OneCreator-Event-Id': event.id,
        'X-OneCreator-Timestamp': timestamp,
        'X-OneCreator-Signature': `sha256=${webhookSignature(secret, timestamp, body)}`,
      },
      allowedOrigins: config.integrationOrigins,
      maxBytes: 64000,
      timeoutMs: 15000,
      signal,
    });
    statusCode = response.status;
    if (statusCode < 200 || statusCode >= 300) error = `接收端返回 HTTP ${statusCode}`;
  } catch (caught) {
    error = signal?.aborted
      ? '投递被中断，将按相同事件 ID 重试'
      : caught instanceof AppError && caught.status === 400
        ? caught.message
        : '无法完成投递，请检查接收地址与网络';
    blocked = !signal?.aborted && caught instanceof AppError && caught.status === 400;
  }
  // An address rejected by the network policy will not become valid on retry.
  const retry =
    !!error &&
    !blocked &&
    claimed.attempts < 5 &&
    !(statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429);
  await db.rows(
    `UPDATE webhook_deliveries SET status=$1,"responseCode"=$2,error=$3,"nextAt"=now()+($4::text||' seconds')::interval,"finishedAt"=CASE WHEN $1='queued' THEN NULL ELSE now() END,"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$5 AND "leaseToken"=$6 AND "leaseUntil">now()`,
    [
      error ? (retry ? 'queued' : 'failed') : 'succeeded',
      statusCode,
      error,
      Math.min(3600, 30 * 2 ** claimed.attempts),
      claimed.id,
      claimed.leaseToken,
    ],
  );
}
