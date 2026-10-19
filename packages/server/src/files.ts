import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Asset, ContentDocument } from '@one-creator/core';
import { renderHtmlDocument } from '@one-creator/rendering';
import type { Sql } from './database.js';
import { AppError } from './errors.js';
import { id, owned } from './records.js';
import { tokenHash } from './crypto.js';
import { createHash } from 'node:crypto';

export function assetPath(dataDir: string, key: string) {
  if (!/^[a-f\d-]{36}\.(png|jpg|webp|mp4|mp3|m4a|wav|srt|vtt)$/.test(key))
    throw new AppError(400, 'ASSET_PATH', '素材路径不合法');
  return path.join(dataDir, 'assets', key);
}
function detectImage(buffer: Buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { ext: 'png', mime: 'image/png' };
  if (buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { ext: 'jpg', mime: 'image/jpeg' };
  if (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return { ext: 'webp', mime: 'image/webp' };
  throw new AppError(400, 'IMAGE_FORMAT', '支持 PNG、JPEG 和 WebP 图片，请检查文件格式');
}
export async function storeAsset(
  sql: Sql,
  workspaceId: string,
  dataDir: string,
  filename: string,
  buffer: Buffer,
  options: { accountId?: string | null; createdBy?: string; metadata?: Record<string, unknown> } = {},
): Promise<Asset> {
  const format = detectImage(buffer);
  if (buffer.length > 12 * 1024 * 1024) throw new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 12 MB');
  return storeBinaryAsset(sql, workspaceId, dataDir, filename, buffer, format, options);
}
export async function storeMedia(
  sql: Sql,
  workspaceId: string,
  dataDir: string,
  filename: string,
  buffer: Buffer,
  options: { accountId?: string | null; createdBy?: string; metadata?: Record<string, unknown> } = {},
) {
  if (buffer.length > 128 * 1024 * 1024)
    throw new AppError(413, 'MEDIA_TOO_LARGE', '单个媒体文件不能超过 128 MB');
  let format: { ext: string; mime: string };
  if (buffer.subarray(4, 8).toString() === 'ftyp')
    format = filename.toLowerCase().endsWith('.m4a')
      ? { ext: 'm4a', mime: 'audio/mp4' }
      : { ext: 'mp4', mime: 'video/mp4' };
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE')
    format = { ext: 'wav', mime: 'audio/wav' };
  else if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 255 && (buffer[1] & 224) === 224))
    format = { ext: 'mp3', mime: 'audio/mpeg' };
  else format = detectImage(buffer);
  return storeBinaryAsset(sql, workspaceId, dataDir, filename, buffer, format, options);
}
export async function storeSubtitle(
  sql: Sql,
  workspaceId: string,
  dataDir: string,
  content: string,
  options: { accountId?: string | null; createdBy?: string; metadata?: Record<string, unknown> } = {},
) {
  if (content.length > 1000000) throw new AppError(400, 'SUBTITLE_TOO_LARGE', '字幕超过容量限制');
  return storeBinaryAsset(
    sql,
    workspaceId,
    dataDir,
    'subtitles.srt',
    Buffer.from(content, 'utf8'),
    { ext: 'srt', mime: 'application/x-subrip' },
    options,
  );
}
async function storeBinaryAsset(
  sql: Sql,
  workspaceId: string,
  dataDir: string,
  filename: string,
  buffer: Buffer,
  format: { ext: string; mime: string },
  options: { accountId?: string | null; createdBy?: string; metadata?: Record<string, unknown> },
): Promise<Asset> {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const [existing] = await sql.rows<Asset>(
    'SELECT * FROM assets WHERE "workspaceId"=$1 AND hash=$2 AND "accountId" IS NOT DISTINCT FROM $3',
    [workspaceId, hash, options.accountId ?? null],
  );
  if (existing) return { ...existing, duplicate: true };
  const assetId = id();
  const storageKey = `${assetId}.${format.ext}`;
  const target = assetPath(dataDir, storageKey);
  await writeFile(target, buffer, { mode: 0o600, flag: 'wx' });
  try {
    const [asset] = await sql.rows<Asset>(
      `INSERT INTO assets(id,"workspaceId",filename,"storageKey",mime,size,hash,"accountId","createdBy",metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
      [
        assetId,
        workspaceId,
        path
          .basename(filename)
          .replace(/[\x00-\x1f]/g, '')
          .slice(0, 200) || `image.${format.ext}`,
        storageKey,
        format.mime,
        buffer.length,
        hash,
        options.accountId ?? null,
        options.createdBy ?? null,
        JSON.stringify(options.metadata ?? {}),
      ],
    );
    if (asset) return asset;
    await unlink(target);
    return {
      ...(
        await sql.rows<Asset>(
          'SELECT * FROM assets WHERE "workspaceId"=$1 AND hash=$2 AND "accountId" IS NOT DISTINCT FROM $3',
          [workspaceId, hash, options.accountId ?? null],
        )
      )[0],
      duplicate: true,
    };
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
}
export async function exportDocument(
  sql: Sql,
  workspaceId: string,
  dataDir: string,
  document: ContentDocument,
) {
  const assets: Asset[] = [];
  const referenced = [...document.assetIds, ...(document.coverAssetId ? [document.coverAssetId] : [])];
  for (const match of document.body.matchAll(/\/api\/assets\/([a-f\d-]{36})/g)) referenced.push(match[1]);
  for (const assetId of new Set(referenced))
    assets.push(await owned<Asset>(sql, 'assets', workspaceId, assetId));
  const total = assets.reduce((size, asset) => size + asset.size, 0);
  if (total > 80 * 1024 * 1024)
    throw new AppError(400, 'EXPORT_TOO_LARGE', '单次导出图片合计超过 80 MB，请减少附件');
  let body = document.body;
  const files: Record<string, Uint8Array> = {};
  for (const asset of assets) {
    const exportPath = `images/${asset.storageKey}`;
    body = body.replaceAll(`/api/assets/${asset.id}`, exportPath);
    files[exportPath] = await readFile(assetPath(dataDir, asset.storageKey));
  }
  const attachments = document.assetIds.filter(
    (assetId) => !document.body.includes(`/api/assets/${assetId}`),
  );
  if (attachments.length)
    body +=
      '\n\n' +
      attachments
        .map((assetId) => {
          const asset = assets.find((item) => item.id === assetId)!;
          return `![配图](images/${asset.storageKey})`;
        })
        .join('\n\n');
  files['article.md'] = strToU8(`# ${document.title}\n\n${body}`);
  files['article.html'] = strToU8(renderHtmlDocument(document.title, body, document.context.visual));
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        format: 'one-creator-publish-package',
        version: 1,
        exportedAt: new Date().toISOString(),
        documentId: document.id,
        revision: document.revision,
        sourceId: document.sourceId,
        sourceRevision: document.sourceRevision,
        title: document.title,
        account: document.context.account,
        persona: document.context.persona,
        tags: document.tags,
        visual: document.context.visual ?? null,
        cover: document.coverAssetId
          ? `images/${assets.find((item) => item.id === document.coverAssetId)!.storageKey}`
          : null,
        imageOrder: document.assetIds.map(
          (assetId) => `images/${assets.find((item) => item.id === assetId)!.storageKey}`,
        ),
        citations: document.context.citations.map(({ id, title, url, author, revision, excerpts }) => ({
          id,
          title,
          url,
          author,
          revision,
          excerpts,
        })),
        contentHash: tokenHash(document.body),
        publication: '导出不是发布，请在平台完成发布后回填结果',
      },
      null,
      2,
    ),
  );
  return Buffer.from(zipSync(files, { level: 6 }));
}
