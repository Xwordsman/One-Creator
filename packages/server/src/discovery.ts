import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { materialSchema, type Feed, type Material } from '@one-creator/core';
import type { Database, Sql } from './database.js';
import type { AppConfig } from './config.js';
import { fetchPublic } from './public-fetch.js';
import { id, insert, owned } from './records.js';
import { tokenHash } from './crypto.js';
import { AppError } from './errors.js';

export function extractArticle(html: string, url: string) {
  const { document } = parseHTML(html);
  const base = document.createElement('base');
  base.href = url;
  document.head.appendChild(base);
  const result = new Readability(document as unknown as Document, { keepClasses: false }).parse();
  const body = result?.textContent?.trim() ?? '';
  const title = result?.title?.trim() ?? '';
  if (body.length < 20 || !title)
    throw new AppError(400, 'EXTRACTION_EMPTY', '没有提取到足够的文章正文，可在素材库手工补录');
  if (body.length > 100000)
    throw new AppError(400, 'EXTRACTION_TOO_LARGE', '正文超过 100,000 字符，请分段导入');
  return { title, body, url, author: result?.byline?.trim() ?? '' };
}
export async function importArticle(db: Sql, ws: string, accountId: string | null, article: unknown) {
  const input = materialSchema.parse({ ...(article as object), accountId, kind: 'text' });
  const normalizedUrl = input.url ? new URL(input.url) : null;
  if (normalizedUrl) normalizedUrl.hash = '';
  const importHash = tokenHash(normalizedUrl?.href ?? input.body.trim());
  // Same address, or the same text reached through another address, reuses the existing material.
  const existing = await db.rows<Material>(
    'SELECT * FROM materials WHERE "workspaceId"=$1 AND "accountId" IS NOT DISTINCT FROM $2 AND ("importHash"=$3 OR ($4<>\'\' AND url=$4) OR btrim(body)=$5) ORDER BY "createdAt" LIMIT 1',
    [ws, accountId, importHash, normalizedUrl?.href ?? '', input.body.trim()],
  );
  if (existing.length) return { status: 'reused', materialId: existing[0].id, title: existing[0].title };
  const [created] = await db.rows<Material>(
    `INSERT INTO materials(id,"workspaceId","accountId",title,body,url,author,tags,kind,archived,"sourceDate","importHash") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'text',false,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
    [
      id(),
      ws,
      accountId,
      input.title,
      input.body,
      normalizedUrl?.href ?? '',
      input.author,
      JSON.stringify(input.tags),
      input.sourceDate,
      importHash,
    ],
  );
  if (created) return { status: 'created', materialId: created.id, title: created.title };
  const [duplicate] = await db.rows<Material>(
    'SELECT * FROM materials WHERE "workspaceId"=$1 AND "accountId" IS NOT DISTINCT FROM $2 AND "importHash"=$3',
    [ws, accountId, importHash],
  );
  return { status: 'reused', materialId: duplicate.id, title: duplicate.title };
}
export async function importBatch(
  db: Database,
  config: AppConfig,
  ws: string,
  accountId: string | null,
  input: { urls?: string[]; articles?: unknown[] },
  previous: Record<string, unknown>,
  report: (stage: string, progress: Record<string, unknown>) => Promise<void>,
  signal: AbortSignal,
) {
  const entries = [
    ...(input.urls ?? []).map((url) => ({ url })),
    ...(input.articles ?? []).map((article) => ({ article })),
  ];
  const results = (previous.results ?? []) as {
    index: number;
    status: string;
    error?: string;
    materialId?: string;
    title?: string;
  }[];
  for (const [index, entry] of entries.entries()) {
    if (results.some((result) => result.index === index && ['created', 'reused'].includes(result.status)))
      continue;
    await report('importing', {
      results,
      total: entries.length,
      done: results.filter((result) => result.status !== 'failed').length,
    });
    try {
      let article: unknown;
      if ('url' in entry) {
        const response = await fetchPublic(entry.url, { allowedOrigins: config.integrationOrigins, signal });
        if (response.status !== 200)
          throw new AppError(400, 'SOURCE_HTTP', `来源返回 HTTP ${response.status}`);
        article = extractArticle(response.bytes.toString('utf8'), response.url);
      } else article = entry.article;
      signal.throwIfAborted();
      await report('importing', { results, total: entries.length, done: index });
      const saved = await importArticle(db, ws, accountId, article);
      const old = results.findIndex((result) => result.index === index);
      if (old >= 0) results.splice(old, 1);
      results.push({ index, ...saved });
    } catch (error) {
      if (signal.aborted) throw error;
      const old = results.findIndex((result) => result.index === index);
      if (old >= 0) results.splice(old, 1);
      results.push({
        index,
        status: 'failed',
        error: error instanceof AppError ? error.message : '内容格式或读取失败，请检查标题、正文和来源地址',
      });
    }
    await report('importing', { results, total: entries.length, done: index + 1 });
  }
  return {
    results,
    created: results.filter((row) => row.status === 'created').length,
    reused: results.filter((row) => row.status === 'reused').length,
    failed: results.filter((row) => row.status === 'failed').length,
  };
}
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? (value as Record<string, unknown>[])
    : value && typeof value === 'object'
      ? [value as Record<string, unknown>]
      : [];
const string = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? [(value as Record<string, unknown>)['#text'], (value as Record<string, unknown>)['#cdata']]
          .flat()
          .filter((part) => typeof part === 'string')
          .join('')
      : '';
function plain(html: string) {
  return parseHTML(`<html><body>${html}</body></html>`).document.body.textContent ?? '';
}
// Only the predefined XML entities and character references are decoded; DOCTYPE entities are never expanded. CDATA stays raw.
const xmlEntities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (value: string) =>
  value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-fA-F]+);/g, (match, name: string) => {
    if (name[0] !== '#') return xmlEntities[name];
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
export function parseFeed(kind: Feed['kind'], text: string, sourceUrl: string) {
  let values: { title: string; url: string; body: string; publishedAt: string | null }[];
  if (kind === 'json_feed') {
    const feed = JSON.parse(text);
    if (!Array.isArray(feed.items)) throw new AppError(400, 'FEED_FORMAT', 'JSON Feed 缺少 items 数组');
    values = feed.items.map((item: Record<string, unknown>) => ({
      title: string(item.title),
      url: string(item.url ?? item.external_url),
      body: string(item.content_text) || plain(string(item.content_html ?? item.summary)),
      publishedAt: string(item.date_published) || null,
    }));
  } else {
    // Bare ampersands are tolerated because many feeds emit them; broken or unclosed tags are not.
    if (
      XMLValidator.validate(text.replace(/&(?!(?:[a-zA-Z][\w.-]*|#\d+|#x[\da-fA-F]+);)/g, '&amp;')) !== true
    )
      throw new AppError(400, 'FEED_FORMAT', '来源不是有效 RSS / Atom 文档');
    const xml = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      processEntities: false,
      parseTagValue: false,
      cdataPropName: '#cdata',
      tagValueProcessor: (_name, value) => decodeXml(value),
      attributeValueProcessor: (_name, value) => decodeXml(value),
    }).parse(text);
    const records = list(xml.rss?.channel?.item ?? xml.feed?.entry ?? xml.RDF?.item);
    if (!xml.rss && !xml.feed && !xml.RDF)
      throw new AppError(400, 'FEED_FORMAT', '来源不是有效 RSS / Atom 文档');
    // RSS guid is a permalink unless isPermaLink="false"; it keeps linkless items addressable.
    const guid = (entry: Record<string, unknown>) => {
      const value = entry.guid as Record<string, unknown> | string | undefined;
      if (!value) return '';
      if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : '';
      return value['@_isPermaLink'] === 'false' ? '' : string(value['#text']);
    };
    values = records.map((entry) => {
      const links = list(entry.link);
      const link =
        (typeof entry.link === 'string'
          ? entry.link
          : string(
              links.find((link) => link['@_rel'] === 'alternate')?.['@_href'] ?? links[0]?.['@_href'],
            )) || guid(entry);
      return {
        title: string(entry.title),
        url: link,
        body: plain(string(entry.encoded ?? entry.content ?? entry.description ?? entry.summary)),
        publishedAt: string(entry.pubDate ?? entry.published ?? entry.updated ?? entry.date) || null,
      };
    });
  }
  return values.flatMap((entry) => {
    try {
      if (!entry.url.trim()) return [];
      const url = new URL(entry.url, sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !entry.title) return [];
      url.hash = '';
      const time = entry.publishedAt ? Date.parse(entry.publishedAt) : NaN;
      return [
        {
          ...entry,
          url: url.href,
          body: entry.body.slice(0, 20000),
          publishedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
        },
      ];
    } catch {
      return [];
    }
  });
}
export async function refreshFeed(
  db: Database,
  config: AppConfig,
  ws: string,
  feedId: string,
  signal: AbortSignal,
) {
  const feed = await owned<Feed>(db, 'feeds', ws, feedId);
  if (!feed.enabled) return { skipped: true, reason: '来源已停用' };
  try {
    const response = await fetchPublic(feed.url, { allowedOrigins: config.integrationOrigins, signal });
    if (response.status !== 200) throw new AppError(400, 'FEED_HTTP', `来源返回 HTTP ${response.status}`);
    const entries = parseFeed(feed.kind, response.bytes.toString('utf8'), response.url);
    let added = 0,
      updated = 0,
      unchanged = 0,
      filtered = 0;
    for (const entry of entries.slice(0, 200)) {
      signal.throwIfAborted();
      const combined = `${entry.title}\n${entry.body}`.toLowerCase();
      if (
        (feed.include.length && !feed.include.some((word) => combined.includes(word.toLowerCase()))) ||
        feed.exclude.some((word) => combined.includes(word.toLowerCase()))
      ) {
        filtered++;
        continue;
      }
      const key = tokenHash(entry.url);
      const [existing] = await db.rows<{ id: string }>(
        'SELECT id FROM feed_entries WHERE "feedId"=$1 AND "externalKey"=$2',
        [feed.id, key],
      );
      // Unchanged entries keep their row and fetch time; only real changes are written.
      const written = await db.rows(
        `INSERT INTO feed_entries(id,"workspaceId","accountId","feedId","externalKey",title,url,body,"publishedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT("feedId","externalKey") DO UPDATE SET title=excluded.title,body=excluded.body,"publishedAt"=excluded."publishedAt","fetchedAt"=now()
      WHERE (feed_entries.title,feed_entries.body,feed_entries."publishedAt") IS DISTINCT FROM (excluded.title,excluded.body,excluded."publishedAt") RETURNING id`,
        [id(), ws, feed.accountId, feed.id, key, entry.title, entry.url, entry.body, entry.publishedAt],
      );
      if (!existing) added++;
      else if (written.length) updated++;
      else unchanged++;
    }
    await db.rows(
      'UPDATE feeds SET "lastFetchedAt"=now(),error=\'\',"nextAt"=now()+("intervalMinutes"::text||\' minutes\')::interval WHERE id=$1 AND revision=$2',
      [feed.id, feed.revision],
    );
    return {
      feedId,
      added,
      updated,
      unchanged,
      filtered,
      scanned: Math.min(entries.length, 200),
      limited: entries.length > 200,
    };
  } catch (error) {
    await db.rows(
      'UPDATE feeds SET error=$1,"lastFetchedAt"=now(),"nextAt"=now()+interval \'15 minutes\' WHERE id=$2 AND revision=$3',
      [error instanceof AppError ? error.message : '无法读取来源，历史条目仍然保留', feed.id, feed.revision],
    );
    throw error;
  }
}
