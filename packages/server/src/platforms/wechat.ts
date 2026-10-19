import { readFile } from 'node:fs/promises';
import type { Asset, DraftPayload } from '@one-creator/core';
import { escapeHtml, renderArticle } from '@one-creator/rendering';
import type { Database } from '../database.js';
import type { AppConfig } from '../config.js';
import {
  credentialScope,
  findConnection,
  recordConnectionCheck,
  type ConnectionRecord,
} from '../connections.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { AppError, conflict } from '../errors.js';
import { assetPath } from '../files.js';
import { owned } from '../records.js';
import type { DraftAdapter, DraftContext, DraftMatch } from './types.js';

export class WechatError extends AppError {
  constructor(
    public errcode: number | null,
    message: string,
    public connectionStatus?: ConnectionRecord['status'],
  ) {
    super(502, 'WECHAT_ERROR', message);
  }
  /** Only a documented rejection establishes that a mutating request did not succeed. */
  get definitive() {
    return this.errcode !== null && this.errcode !== -1;
  }
}
export async function recordWechatCapability(
  db: Database,
  connection: ConnectionRecord,
  feature: 'publish' | 'metrics',
  status: 'supported' | 'unsupported' | 'unknown',
  reason: string,
) {
  await db.rows(
    'UPDATE account_connections SET capabilities=jsonb_set(capabilities,ARRAY[$1::text],$2::jsonb,true) WHERE id=$3 AND revision=$4',
    [
      feature,
      JSON.stringify({ status, reason, checkedAt: new Date().toISOString() }),
      connection.id,
      connection.revision,
    ],
  );
}
function apiError(code: number): WechatError {
  if ([40013, 40125, 40001, 40002, 40014, 42001, 41001].includes(code))
    return new WechatError(
      code,
      `公众号凭据无效或过期，请检查 AppID / AppSecret（${code}）`,
      'credentials_invalid',
    );
  if ([40164, 89503].includes(code))
    return new WechatError(
      code,
      `服务器出口 IP 未获准，请在公众号开发配置中核对 IP 白名单（${code}）`,
      'network_restricted',
    );
  if ([48001, 48002, 48004, 50001, 50002].includes(code))
    return new WechatError(
      code,
      `这个账号没有接口权限，请检查认证状态与草稿接口权限（${code}）`,
      'permission_denied',
    );
  if ([45009, 45011, 45047].includes(code))
    return new WechatError(code, `公众号接口调用频次受限，请稍后手动重试（${code}）`);
  if ([40004, 40005, 40006, 40007, 41005, 45001].includes(code))
    return new WechatError(code, `平台拒绝图片素材，请核对格式、大小与素材有效期（${code}）`);
  if ([45002, 45003, 45004, 45110].includes(code))
    return new WechatError(code, `内容字段超过平台限制，请缩短标题或正文（${code}）`);
  return new WechatError(code, `公众号接口返回错误 ${code}，请核对平台配置与任务内容`);
}
function apiBase(config: AppConfig) {
  return config.wechatApiBase ?? 'https://api.weixin.qq.com';
}

async function requestJson<T>(
  config: AppConfig,
  pathname: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase(config)}${pathname}`, {
      ...init,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(config.wechatTimeoutMs ?? 45000)])
        : AbortSignal.timeout(config.wechatTimeoutMs ?? 45000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WechatError(null, `公众号服务返回 HTTP ${response.status}，本次结果需要核对`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new WechatError(null, '公众号服务未返回结果');
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new WechatError(null, '公众号返回内容过大，请到平台核对');
      }
      parts.push(part.value);
    }
    let data: T & { errcode?: number };
    try {
      data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new WechatError(null, '公众号返回格式异常，请核对操作结果');
    }
    if (!data || typeof data !== 'object') throw new WechatError(null, '公众号返回格式异常');
    if (typeof data.errcode === 'number' && data.errcode !== 0) throw apiError(data.errcode);
    return data;
  } catch (error) {
    if (error instanceof WechatError) throw error;
    throw new WechatError(
      null,
      signal?.aborted
        ? '公众号请求已中断，请核对任务结果'
        : '无法连接公众号服务或响应超时，请检查网络后核对结果',
    );
  }
}
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function wechatClient(
  db: Database,
  config: AppConfig,
  connection: ConnectionRecord,
  signal?: AbortSignal,
) {
  async function token(force = false) {
    const current = await findConnection(db, connection.workspaceId, connection.accountId);
    if (!current || current.id !== connection.id || current.revision !== connection.revision)
      throw conflict('账号连接已变化，请使用新的连接重建任务');
    if (
      !force &&
      current.tokenCipher &&
      current.tokenExpiresAt &&
      Date.parse(current.tokenExpiresAt) > Date.now() + 120000
    )
      return decryptSecret(current.tokenCipher, config.encryptionKey, `${credentialScope(current)}:token`);
    const data = await requestJson<{ access_token?: string; expires_in?: number }>(
      config,
      '/cgi-bin/stable_token',
      json({
        grant_type: 'client_credential',
        appid: current.appId,
        secret: decryptSecret(current.secretCipher, config.encryptionKey, credentialScope(current)),
        force_refresh: force,
      }),
      signal,
    );
    if (!data.access_token || typeof data.access_token !== 'string')
      throw new WechatError(null, '公众号未返回访问凭据');
    const expires = new Date(
      Date.now() + Math.min(7200, Math.max(60, Number(data.expires_in) || 7200)) * 1000,
    ).toISOString();
    const saved = await db.rows(
      'UPDATE account_connections SET "tokenCipher"=$1,"tokenExpiresAt"=$2 WHERE id=$3 AND revision=$4 RETURNING id',
      [
        encryptSecret(data.access_token, config.encryptionKey, `${credentialScope(current)}:token`),
        expires,
        current.id,
        current.revision,
      ],
    );
    if (!saved.length) throw conflict('账号连接已变化，请重建任务');
    return data.access_token;
  }
  async function call<T>(pathname: string, init: () => RequestInit = () => ({})): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const accessToken = await token(attempt > 0);
        return await requestJson<T>(
          config,
          `${pathname}${pathname.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`,
          init(),
          signal,
        );
      } catch (error) {
        // Explicit token rejection means the platform did not execute this request; one refresh is safe.
        if (
          attempt === 0 &&
          error instanceof WechatError &&
          [40001, 40014, 42001].includes(error.errcode ?? 0)
        )
          continue;
        if (error instanceof WechatError && error.connectionStatus) {
          const feature = pathname.includes('/freepublish/')
            ? 'publish'
            : pathname.startsWith('/datacube/')
              ? 'metrics'
              : 'draft';
          if (error.connectionStatus === 'permission_denied' && feature !== 'draft')
            await recordWechatCapability(db, connection, feature, 'unsupported', error.message);
          else await recordConnectionCheck(db, connection, error.connectionStatus, error.message);
        }
        throw error;
      }
    }
    throw new WechatError(null, '公众号访问凭据无法刷新');
  }
  return { token, call };
}

async function check(db: Database, config: AppConfig, connection: ConnectionRecord) {
  try {
    await wechatClient(db, config, connection).call('/cgi-bin/draft/count');
    await recordConnectionCheck(db, connection, 'connected');
  } catch (error) {
    await recordConnectionCheck(
      db,
      connection,
      error instanceof WechatError ? (error.connectionStatus ?? 'unavailable') : 'unavailable',
      error instanceof AppError ? error.message : '连接检查失败，请重新配置',
    );
  }
}
const form = (bytes: Buffer, asset: Asset) => () => {
  const data = new FormData();
  data.set('media', new Blob([new Uint8Array(bytes)], { type: asset.mime }), asset.filename);
  return { method: 'POST', body: data };
};

async function prepare(context: DraftContext): Promise<DraftPayload> {
  const { db, config, connection, job, signal, report } = context;
  const document = job.input.document;
  if (!document.coverAssetId) throw new AppError(400, 'COVER_REQUIRED', '请先设置封面，再建立新的发布计划');
  if ([...document.title].length > 32)
    throw new AppError(400, 'WECHAT_TITLE', '公众号草稿标题不能超过 32 字，请修改后建立新的发布计划');
  let body = document.body;
  for (const assetId of document.assetIds)
    if (assetId !== document.coverAssetId && !body.includes(`/api/assets/${assetId}`))
      body += `\n\n![配图](/api/assets/${assetId})`;
  let content = renderArticle(body, document.context.visual);
  const assetIds: string[] = [];
  for (const [, source] of content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
    const match = /^\/api\/assets\/([a-f\d-]{36})$/.exec(source);
    if (!match)
      throw new AppError(
        400,
        'WECHAT_IMAGE_SOURCE',
        '正文含外部图片，请先上传为本地附件后插入，公众号不会保留外部图片',
      );
    if (!assetIds.includes(match[1])) assetIds.push(match[1]);
  }
  // Validate all files before the first remote upload.
  const assets = await Promise.all(
    assetIds.map((assetId) => owned<Asset>(db, 'assets', job.workspaceId, assetId)),
  );
  for (const asset of assets)
    if (!['image/png', 'image/jpeg'].includes(asset.mime) || asset.size > 1024 * 1024)
      throw new AppError(
        400,
        'WECHAT_IMAGE',
        `正文图片「${asset.filename}」须为不超过 1 MB 的 PNG/JPEG，请压缩后重新安排发布`,
      );
  const cover = await owned<Asset>(db, 'assets', job.workspaceId, document.coverAssetId);
  if (!['image/png', 'image/jpeg'].includes(cover.mime) || cover.size > 10 * 1024 * 1024)
    throw new AppError(400, 'WECHAT_COVER', '封面须为不超过 10 MB 的 PNG/JPEG');
  if (content.length >= 20000)
    throw new AppError(400, 'WECHAT_CONTENT', '排版后的 HTML 超过公众号 2 万字符限制，请缩短正文或简化排版');
  const client = wechatClient(db, config, connection, signal);
  const progress = { ...job.progress, images: { ...job.progress.images }, total: assets.length, done: 0 };
  for (const [index, asset] of assets.entries()) {
    await report('uploading_images', { ...progress, done: index });
    if (!progress.images[asset.id]) {
      const data = await client.call<{ url?: string }>(
        '/cgi-bin/media/uploadimg',
        form(await readFile(assetPath(config.dataDir, asset.storageKey)), asset),
      );
      if (!data.url || !/^https?:\/\//.test(data.url))
        throw new WechatError(null, '公众号未返回有效图片地址');
      progress.images[asset.id] = data.url;
    }
    progress.done = index + 1;
    await report('uploading_images', progress);
    content = content.replaceAll(`/api/assets/${asset.id}`, escapeHtml(progress.images[asset.id]));
  }
  await report('uploading_cover', progress);
  if (progress.coverAssetId !== cover.id || !progress.coverMediaId) {
    const data = await client.call<{ media_id?: string }>(
      '/cgi-bin/material/add_material?type=image',
      form(await readFile(assetPath(config.dataDir, cover.storageKey)), cover),
    );
    if (!data.media_id) throw new WechatError(null, '公众号未返回封面素材 ID');
    progress.coverMediaId = data.media_id;
    progress.coverAssetId = cover.id;
    await report('uploading_cover', progress);
  }
  if (content.length >= 20000 || Buffer.byteLength(content, 'utf8') >= 1024 * 1024)
    throw new AppError(400, 'WECHAT_CONTENT', '图片地址替换后的 HTML 超出公众号限制，请缩短内容再建立新计划');
  const payload: DraftPayload = {
    article_type: 'news',
    title: document.title,
    content,
    thumb_media_id: progress.coverMediaId!,
  };
  await client.token();
  await report('uploading_cover', { ...progress, payload });
  return payload;
}
async function submit(context: DraftContext, payload: DraftPayload) {
  const { db, config, connection, signal } = context;
  const result = await wechatClient(db, config, connection, signal).call<{ media_id?: string }>(
    '/cgi-bin/draft/add',
    () => json({ articles: [payload] }),
  );
  if (!result.media_id || typeof result.media_id !== 'string')
    throw new WechatError(null, '公众号未返回草稿 ID，请核对平台草稿箱');
  return result.media_id;
}

interface DraftItem {
  media_id: string;
  update_time?: number;
  content: { news_item: DraftPayload[] };
}
const normalizedHtml = (value: string) => value.replace(/\r\n/g, '\n').trim();
function matches(item: DraftItem, payload: DraftPayload) {
  const articles = item.content?.news_item;
  return (
    articles?.length === 1 &&
    articles[0].title === payload.title &&
    articles[0].thumb_media_id === payload.thumb_media_id &&
    normalizedHtml(articles[0].content) === normalizedHtml(payload.content)
  );
}
async function reconcile(
  context: DraftContext,
  payload: DraftPayload,
  mediaId?: string,
): Promise<DraftMatch> {
  const client = wechatClient(context.db, context.config, context.connection, context.signal);
  if (mediaId) {
    const result = await client.call<{ news_item: DraftPayload[] }>('/cgi-bin/draft/get', () =>
      json({ media_id: mediaId }),
    );
    if (!matches({ media_id: mediaId, content: result }, payload))
      throw conflict('该草稿的标题、正文或封面与发布快照不一致，不能自动认领');
    return { mediaId, message: '已读取并核对这个草稿的正文与封面' };
  }
  const candidates: string[] = [];
  const after = Date.parse(context.job.progress.submittedAt ?? context.job.createdAt) / 1000 - 60;
  // A bounded scan can prove a unique match; absence is never proof that the write failed.
  for (let offset = 0; offset < 100; offset += 20) {
    const page = await client.call<{ item?: DraftItem[]; total_count?: number }>(
      '/cgi-bin/draft/batchget',
      () => json({ offset, count: 20, no_content: 0 }),
    );
    if (!Array.isArray(page.item)) throw new WechatError(null, '公众号未返回草稿列表，请稍后再核对');
    for (const item of page.item)
      if ((item.update_time ?? 0) >= after && matches(item, payload)) candidates.push(item.media_id);
    if (page.item.length < 20 || (page.total_count !== undefined && offset + 20 >= page.total_count)) break;
  }
  return candidates.length === 1
    ? { mediaId: candidates[0], message: '已找到并核对唯一匹配的草稿' }
    : {
        mediaId: null,
        message: candidates.length
          ? '发现多个一致的草稿，请在平台核对后输入明确的草稿 ID'
          : '最近 100 条草稿中未找到完全匹配项，结果仍未确定；请稍后查询或到平台核对',
      };
}
export const wechatAdapter: DraftAdapter = {
  platform: 'wechat',
  method: 'wechat_api',
  check,
  prepare,
  submit,
  reconcile,
};
