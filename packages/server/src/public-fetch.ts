import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from './errors.js';

export function publicAddress(ip: string): boolean {
  const normalized =
    net.isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase() : ip.toLowerCase();
  if (net.isIP(normalized) === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIP(normalized) === 6)
    return !(/^(::|fc|fd|fe[89ab]|ff)/i.test(normalized) || normalized === '::1');
  return false;
}
/** Pin the validated DNS answer for each redirect; imported pages and webhooks never reach private services. */
export async function fetchPublic(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    allowedOrigins?: string[];
  } = {},
  redirects = 0,
): Promise<{ url: string; status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new AppError(400, 'SOURCE_URL', '来源只支持无内嵌凭据的 HTTP(S) 地址');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !publicAddress(address) && !options.allowedOrigins?.includes(target.origin),
    )
  )
    throw new AppError(
      400,
      'SOURCE_ADDRESS',
      '该来源不是可抓取的公网地址；自建内网服务可由管理员加入 INTEGRATION_ALLOWED_ORIGINS',
    );
  const selected = addresses[0];
  const timeout = options.timeoutMs ?? 20000;
  const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>(
    (resolve, reject) => {
      const request = (target.protocol === 'https:' ? https : http).request(
        target,
        {
          method: options.method ?? 'GET',
          headers: { 'User-Agent': 'One-Creator/0.1 (+self-hosted creator workbench)', ...options.headers },
          lookup: (_name, _lookupOptions, callback) => {
            const cb = callback as unknown as (...args: unknown[]) => void;
            if (typeof _lookupOptions === 'object' && _lookupOptions.all) cb(null, [selected]);
            else cb(null, selected.address, selected.family);
          },
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > (options.maxBytes ?? 4 * 1024 * 1024)) {
              request.destroy(new AppError(400, 'SOURCE_TOO_LARGE', '来源内容超过导入限制'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: response.headers,
              bytes: Buffer.concat(chunks),
            }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      if (options.body) request.write(options.body);
      request.end();
    },
  );
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    if (redirects >= 4) throw new AppError(400, 'SOURCE_REDIRECT', '来源重定向过多');
    if (options.method && options.method !== 'GET') return { url, ...result };
    return fetchPublic(new URL(result.headers.location, target).href, options, redirects + 1);
  }
  return { url: target.href, ...result };
}
