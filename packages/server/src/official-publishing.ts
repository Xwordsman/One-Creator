import type { PublishTask, WorkerJob } from '@one-creator/core';
import type { AutomationContext } from './automation-types.js';
import { findConnection } from './connections.js';
import { wechatClient, recordWechatCapability, WechatError } from './platforms/wechat.js';
import { owned } from './records.js';
import { AppError, conflict } from './errors.js';
import { recordMetric } from './metrics.js';

async function publicationState(
  context: AutomationContext,
  task: PublishTask,
  state: Partial<PublishTask>,
  progress: Record<string, unknown>,
) {
  await context.db.transaction(async (sql) => {
    await owned(sql, 'publish_tasks', context.job.workspaceId, task.id, true);
    const allowed = await sql.rows(
      `UPDATE automation_jobs SET progress=$1 WHERE id=$2 AND "leaseToken"=$3 AND status='running' AND "leaseUntil">now() RETURNING id`,
      [JSON.stringify({ ...context.job.progress, ...progress }), context.job.id, context.leaseToken],
    );
    if (!allowed.length) throw new AppError(409, 'LEASE_LOST', '执行权已过期，返回结果不能覆盖当前状态');
    const entries = Object.entries(state).filter(([, value]) => value !== undefined);
    if (entries.length)
      await sql.rows(
        `UPDATE publish_tasks SET ${entries.map(([key], index) => `"${key}"=$${index + 2}`).join(',')},"updatedAt"=now() WHERE id=$1`,
        [
          task.id,
          ...entries.map(([, value]) =>
            value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
          ),
        ],
      );
  });
  context.job.progress = { ...context.job.progress, ...progress };
}
interface PublishedItem {
  article_id: string;
  update_time?: number;
  content?: {
    news_item?: {
      title: string;
      content: string;
      thumb_media_id: string;
      url?: string;
      is_deleted?: boolean;
    }[];
  };
}
async function draftPayload(context: AutomationContext, taskId: string) {
  const [draftJob] = await context.db.rows<WorkerJob>(
    `SELECT * FROM jobs WHERE "publishTaskId"=$1 AND kind='wechat_draft' AND status='succeeded' ORDER BY attempt DESC LIMIT 1`,
    [taskId],
  );
  return draftJob?.progress.payload ?? null;
}
const sameArticle = (
  article: { title: string; content: string; thumb_media_id: string },
  expected: { title: string; content: string; thumb_media_id: string },
) =>
  article.title === expected.title &&
  article.thumb_media_id === expected.thumb_media_id &&
  article.content.replace(/\r\n/g, '\n').trim() === expected.content.replace(/\r\n/g, '\n').trim();
async function resolvePending(context: AutomationContext, taskId: string, result: Record<string, unknown>) {
  await context.db.rows(
    `UPDATE automation_jobs SET status='succeeded',stage='done',error='',"finishedAt"=now(),result=$1 WHERE "publishTaskId"=$2 AND id<>$3 AND kind='wechat_publish' AND status='needs_verification'`,
    [JSON.stringify({ ...result, verifiedBy: context.job.id }), taskId, context.job.id],
  );
}
/** Without a publish ID only the successful-publication list can prove a write; absence never proves failure. */
async function reconcilePublished(
  context: AutomationContext,
  task: PublishTask,
  client: ReturnType<typeof wechatClient>,
) {
  const expected = await draftPayload(context, task.id);
  if (!expected) throw conflict('缺少草稿提交快照，请在公众号后台人工核对');
  await context.report('verifying', { ...context.job.progress, mode: 'published_list' });
  const after = Date.parse(task.submittedAt ?? task.updatedAt) / 1000 - 120,
    candidates: PublishedItem[] = [];
  for (let offset = 0; offset < 100; offset += 20) {
    const page = await client.call<{ item?: PublishedItem[]; total_count?: number }>(
      '/cgi-bin/freepublish/batchget',
      () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, count: 20, no_content: 0 }),
      }),
    );
    if (!Array.isArray(page.item)) throw new WechatError(null, '公众号未返回已发布列表，请稍后再核对');
    for (const item of page.item) {
      const articles = item.content?.news_item ?? [];
      if ((item.update_time ?? 0) >= after && articles.length === 1 && sameArticle(articles[0], expected))
        candidates.push(item);
    }
    if (page.item.length < 20 || (page.total_count !== undefined && offset + 20 >= page.total_count)) break;
  }
  if (candidates.length !== 1)
    return {
      state: task.status,
      found: false,
      message: candidates.length
        ? '找到多篇一致内容，请在公众号后台确认后手工记录发布结果'
        : '最近 100 篇已发布内容中没有一致的文章；平台可能仍在处理，结果保持待核对',
    };
  const [item] = candidates,
    article = item.content!.news_item![0];
  const state: Partial<PublishTask> = {
    status: article.is_deleted ? 'platform_unavailable' : 'published',
    operation: 'publish',
    platformArticleId: item.article_id,
    url: article.url && /^https?:\/\//.test(article.url) ? article.url : undefined,
    resultSource: 'platform_api',
    publicationCheckedAt: new Date().toISOString(),
    platformResult: {
      source: 'freepublish/batchget',
      articleId: item.article_id,
      updateTime: item.update_time ?? null,
      description: '已在成功发布列表中找到唯一一致的文章',
    },
  };
  await publicationState(context, task, state, { articleId: item.article_id });
  await resolvePending(context, task.id, { state: state.status, articleId: item.article_id, url: state.url });
  return {
    state: state.status,
    found: true,
    articleId: item.article_id,
    url: state.url,
    message: '已在成功发布列表中找到唯一一致的文章',
    notice: '列表接口未提供发布任务 ID，实际发布时间以平台为准。',
  };
}
export async function officialPublish(context: AutomationContext) {
  const task = await owned<PublishTask>(
    context.db,
    'publish_tasks',
    context.job.workspaceId,
    String(context.input.data.publishTaskId),
  );
  const connection = await findConnection(context.db, context.job.workspaceId, task.accountId);
  if (!connection || (task.channelAppId && task.channelAppId !== connection.appId))
    throw new AppError(400, 'PUBLICATION_CONNECTION', '发布计划与当前公众号连接不一致');
  const client = wechatClient(context.db, context.config, connection, context.signal);
  const queryOnly = context.job.kind === 'wechat_verify' || !!context.input.data.queryOnly;
  // A definite platform failure allows a fresh submission of the same draft; the old ID stays in platformResult.
  const retryAfterFailure = !queryOnly && task.status === 'publish_failed';
  let publishId = retryAfterFailure
    ? null
    : (task.publishId ??
      (typeof context.input.data.publishId === 'string' ? context.input.data.publishId : null));
  const manualBinding = !!publishId && !task.publishId;
  if (!publishId) {
    if (queryOnly || task.status === 'verification_required')
      return reconcilePublished(context, task, client);
    if (!['draft_saved', 'publish_failed'].includes(task.status) || !task.platformDraftId)
      throw new AppError(400, 'DRAFT_REQUIRED', '请先保存官方草稿，再选择这份草稿正式发布');
    if (!context.input.account?.active) throw new AppError(400, 'ACCOUNT_DISABLED', '账号已停用');
    await client.token();
    await context.report('publishing', {
      ...context.job.progress,
      mediaId: task.platformDraftId,
      appId: connection.appId,
    });
    await publicationState(
      context,
      task,
      { status: 'submitting', operation: 'publish', submittedAt: new Date().toISOString() },
      { sent: true },
    );
    const response = await client.call<{ publish_id?: string | number; msg_data_id?: string | number }>(
      '/cgi-bin/freepublish/submit',
      () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: task.platformDraftId }),
      }),
    );
    if (!response.publish_id) throw new WechatError(null, '平台未返回发布任务 ID，需要核对是否已提交');
    publishId = String(response.publish_id);
    await publicationState(
      context,
      task,
      {
        status: 'submitted',
        publishId,
        msgDataId: response.msg_data_id !== undefined ? String(response.msg_data_id) : null,
      },
      { publishId },
    );
    await recordWechatCapability(
      context.db,
      connection,
      'publish',
      'supported',
      '已实际接收正式发布请求；最终结果仍通过发布状态接口确认',
    );
  }
  await context.report('verifying', { ...context.job.progress, publishId });
  const result = await client.call<{
    publish_status: number;
    article_id?: string;
    article_detail?: { item?: { idx: number; article_url: string }[] };
    fail_idx?: number[];
  }>('/cgi-bin/freepublish/get', () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publish_id: publishId }),
  }));
  if (!Number.isInteger(result.publish_status) || result.publish_status < 0 || result.publish_status > 6)
    throw new WechatError(null, '平台返回了未知发布状态，请稍后重新查询');
  const url =
    result.article_detail?.item?.find((item) => item.idx === 1)?.article_url ??
    result.article_detail?.item?.[0]?.article_url;
  if (manualBinding) {
    if (result.publish_status !== 0 || !result.article_id)
      throw conflict('手工提供的任务尚不能核对为这篇已发布内容');
    const article = await client.call<{
      news_item?: { title: string; content: string; thumb_media_id: string }[];
    }>('/cgi-bin/freepublish/getarticle', () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article_id: result.article_id }),
    }));
    const expected = await draftPayload(context, task.id);
    if (!expected || article.news_item?.length !== 1 || !sameArticle(article.news_item[0], expected))
      throw conflict('这个发布任务的正文或封面与快照不一致，不能认领');
  }
  const descriptions = [
    '平台已确认发布',
    '平台正在处理，尚未确认发布',
    '原创声明审核失败',
    '平台发布失败',
    '平台审核未通过',
    '发布后已被用户删除',
    '发布后已被平台限制',
  ];
  const state: Partial<PublishTask> = {
    operation: 'publish',
    publishId,
    platformResult: { ...result, description: descriptions[result.publish_status] },
    publicationCheckedAt: new Date().toISOString(),
  };
  if (result.publish_status === 0) {
    if (!result.article_id || !url || !/^https?:\/\//.test(url))
      throw new WechatError(null, '成功状态缺少文章 ID 或链接，请重新核对');
    Object.assign(state, {
      status: 'published',
      platformArticleId: result.article_id,
      url,
      resultSource: 'platform_api',
    });
  } else if (result.publish_status === 1) state.status = 'submitted';
  else state.status = result.publish_status >= 5 ? 'platform_unavailable' : 'publish_failed';
  await publicationState(context, task, state, { publishId, platformState: result.publish_status });
  if (manualBinding || queryOnly)
    await resolvePending(context, task.id, { state: state.status, publishId, url });
  return {
    state: state.status,
    publishId,
    articleId: result.article_id ?? null,
    url: url ?? null,
    message: descriptions[result.publish_status],
    notice: '查询确认时间不冒充实际发布时间；平台未返回具体发布时间时保持未知，可由作者补录。',
  };
}
export async function officialMetrics(context: AutomationContext) {
  if (!context.job.accountId || context.input.account?.platform !== 'wechat')
    throw new AppError(400, 'ACCOUNT_REQUIRED', '请选择一个公众号账号');
  const connection = await findConnection(context.db, context.job.workspaceId, context.job.accountId);
  if (!connection) throw new AppError(400, 'CONNECTION_REQUIRED', '请先配置公众号连接');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const from = String(context.input.data.from || yesterday),
    to = String(context.input.data.to || from),
    first = Date.parse(`${from}T00:00:00Z`),
    last = Date.parse(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    last < first ||
    last - first > 30 * 86400000 ||
    from < '2025-11-01' ||
    to > yesterday
  )
    throw new AppError(
      400,
      'METRIC_RANGE',
      '请选择北京时间昨日及以前的发表日期，最多 31 天；接口不提供 2025-11-01 之前的数据',
    );
  const publications = await context.db.rows<PublishTask>(
    'SELECT * FROM publish_tasks WHERE "workspaceId"=$1 AND "accountId"=$2 AND status=\'published\'',
    [context.job.workspaceId, context.job.accountId],
  );
  const selected = context.input.data.publishTaskIds as string[];
  const targets = selected.length ? publications.filter((task) => selected.includes(task.id)) : publications;
  const client = wechatClient(context.db, context.config, connection, context.signal);
  const records = (context.job.progress.records ?? []) as {
    id: string;
    publishTaskId: string;
    statDate: string;
  }[];
  const days = (context.job.progress.days ?? []) as string[];
  let delayed: boolean | null = false;
  for (let day = first; day <= last; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (days.includes(date)) continue;
    await context.report('verifying', { ...context.job.progress, days, records, date });
    const response = await client.call<{
      list?: { msgid: string; content_url?: string; detail_list?: Record<string, unknown>[] }[];
      is_delay?: boolean | string;
    }>('/datacube/getarticletotaldetail', () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ begin_date: date, end_date: date }),
    }));
    if (!Array.isArray(response.list)) throw new WechatError(null, '统计接口未返回有效列表');
    if (response.is_delay === true || response.is_delay === 'true') delayed = true;
    else if (response.is_delay === undefined) delayed = null;
    for (const article of response.list) {
      const task = targets.find(
        (task) =>
          (task.msgDataId && article.msgid === `${task.msgDataId}_1`) ||
          (article.content_url && task.url === article.content_url),
      );
      if (!task) continue;
      for (const detail of article.detail_list ?? []) {
        const statDate = String(detail.stat_date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(statDate) || statDate > yesterday) continue;
        const number = (key: string) =>
          typeof detail[key] === 'number' && Number.isFinite(detail[key]) ? (detail[key] as number) : null;
        const result = await context.db.transaction((sql) =>
          recordMetric(
            sql,
            context.job.workspaceId,
            {
              publishTaskId: task.id,
              capturedAt: `${statDate}T23:59:59+08:00`,
              basis: 'cumulative',
              values: {
                views: number('read_user'),
                likes: number('like_user'),
                comments: number('comment_count'),
                shares: number('share_user'),
                favorites: number('collection_user'),
                followers: null,
                completionRate:
                  number('read_finish_rate') === null ? null : number('read_finish_rate')! * 100,
              },
            },
            'wechat',
          ),
        );
        await context.db.rows('UPDATE metric_snapshots SET definition=$1 WHERE id=$2', [
          JSON.stringify({
            interface: 'datacube/getarticletotaldetail',
            statDate,
            fetchedAt: new Date().toISOString(),
            delayed,
            views: '阅读人数 read_user',
            likes: '拇指赞人数 like_user',
            shares: '分享人数 share_user',
            favorites: '收藏人数 collection_user',
            completionRate: '平台阅读完成率 × 100；capturedAt 标记统计日结束，不是取数时刻',
          }),
          result.snapshot.id,
        ]);
        if (!records.some((row) => row.id === result.snapshot.id))
          records.push({ id: result.snapshot.id, publishTaskId: task.id, statDate });
      }
    }
    days.push(date);
    await context.report('verifying', { ...context.job.progress, days, records });
  }
  await recordWechatCapability(
    context.db,
    connection,
    'metrics',
    'supported',
    '官方已发表文章详细指标接口可访问；数据范围和延迟以每次返回为准',
  );
  return {
    records,
    missing: targets
      .filter((task) => !records.some((row) => row.publishTaskId === task.id))
      .map((task) => ({
        id: task.id,
        title: task.snapshot.title,
        reason: '本次发表日期范围内未返回对应数据，未填入零或模拟值',
      })),
    scope: { publicationFrom: from, publicationTo: to, timeZone: 'Asia/Shanghai', delayed },
    notice: '阅读人数、分享人数等口径不能与其他平台的播放次数直接相加。',
  };
}
