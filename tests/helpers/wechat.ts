import { createServer, type ServerResponse } from 'node:http';
import type { DraftPayload } from '@one-creator/core';

export const mockAppId = 'wx1111111111111111';
export const mockAppSecret = 'local-wechat-app-secret';
export interface MockDraft {
  media_id: string;
  update_time: number;
  appId: string;
  content: { news_item: DraftPayload[] };
}
export interface MockPublication {
  publish_id: string;
  msg_data_id: string;
  article_id: string;
  appId: string;
  status: number;
  update_time: number;
  article: DraftPayload;
}
/** A protocol-level fake for tests only: no requests leave loopback. */
export function createWechatMock() {
  const state = {
    credentials: new Map([
      [mockAppId, mockAppSecret],
      ['wx2222222222222222', 'second-wechat-app-secret'],
    ]),
    tokenError: 0,
    countError: 0,
    imageError: 0,
    coverError: 0,
    draftError: 0,
    rejectNextToken: false,
    fault: 'none' as 'none' | 'before-write' | 'after-write',
    hiddenDrafts: false,
    tokenRequests: 0,
    imageRequests: 0,
    coverRequests: 0,
    draftRequests: 0,
    drafts: [] as MockDraft[],
    beforeResponse: null as (() => Promise<void>) | null,
    publishRequests: 0,
    publishError: 0,
    publishFault: 'none' as 'none' | 'after-write',
    /** Status returned by freepublish/get for new submissions: 0 published, 1 processing, 3 failed. */
    nextPublishStatus: 0,
    publications: [] as MockPublication[],
    metricsError: 0,
    metricRequests: [] as { begin_date: string; end_date: string }[],
  };
  const tokens = new Map<string, string>();
  const respond = (response: ServerResponse, data: unknown) => {
    if (!response.destroyed) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    }
  };
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part) => parts.push(Buffer.from(part)));
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url!, 'http://localhost');
        const raw = Buffer.concat(parts);
        const body = request.headers['content-type']?.includes('application/json')
          ? JSON.parse(raw.toString('utf8'))
          : {};
        const error = (errcode: number) =>
          respond(response, { errcode, errmsg: `fake rejection ${mockAppSecret} must never reach users` });
        if (url.pathname === '/cgi-bin/stable_token') {
          state.tokenRequests++;
          if (state.tokenError) {
            error(state.tokenError);
            return;
          }
          if (body.grant_type !== 'client_credential' || state.credentials.get(body.appid) !== body.secret) {
            error(40125);
            return;
          }
          const token = `mock-token-${body.appid}-${state.tokenRequests}`;
          tokens.set(token, body.appid);
          respond(response, { access_token: token, expires_in: 7200 });
          return;
        }
        const token = url.searchParams.get('access_token') ?? '';
        const appId = tokens.get(token);
        if (!appId || state.rejectNextToken) {
          state.rejectNextToken = false;
          error(42001);
          return;
        }
        if (url.pathname === '/cgi-bin/draft/count') {
          if (state.countError) error(state.countError);
          else
            respond(response, { total_count: state.drafts.filter((draft) => draft.appId === appId).length });
          return;
        }
        if (
          url.pathname === '/cgi-bin/media/uploadimg' ||
          url.pathname === '/cgi-bin/material/add_material'
        ) {
          if (
            !request.headers['content-type']?.includes('multipart/form-data') ||
            !raw.includes('name="media"')
          ) {
            error(41005);
            return;
          }
          if (url.pathname === '/cgi-bin/media/uploadimg') {
            state.imageRequests++;
            if (state.imageError) error(state.imageError);
            else respond(response, { url: `https://mmbiz.qpic.cn/mmbiz_png/local-${state.imageRequests}/0` });
          } else {
            state.coverRequests++;
            if (state.coverError) error(state.coverError);
            else respond(response, { media_id: `cover-${appId}-${state.coverRequests}` });
          }
          return;
        }
        if (url.pathname === '/cgi-bin/draft/add') {
          state.draftRequests++;
          if (state.draftError) {
            error(state.draftError);
            return;
          }
          if (state.fault === 'before-write') {
            response.destroy();
            return;
          }
          const mediaId = `draft-${appId}-${state.draftRequests}`;
          state.drafts.unshift({
            media_id: mediaId,
            appId,
            update_time: Math.floor(Date.now() / 1000),
            content: { news_item: body.articles },
          });
          await state.beforeResponse?.();
          if (state.fault === 'after-write') {
            response.destroy();
            return;
          }
          respond(response, { media_id: mediaId });
          return;
        }
        if (url.pathname === '/cgi-bin/draft/batchget') {
          const drafts = state.hiddenDrafts ? [] : state.drafts.filter((draft) => draft.appId === appId);
          respond(response, {
            total_count: drafts.length,
            item_count: Math.min(body.count, drafts.length),
            item: drafts.slice(body.offset, body.offset + body.count),
          });
          return;
        }
        if (url.pathname === '/cgi-bin/draft/get') {
          const draft = state.drafts.find((item) => item.media_id === body.media_id && item.appId === appId);
          if (!draft) error(46001);
          else respond(response, draft.content);
          return;
        }
        if (url.pathname === '/cgi-bin/freepublish/submit') {
          state.publishRequests++;
          if (state.publishError) {
            error(state.publishError);
            return;
          }
          const draft = state.drafts.find((item) => item.media_id === body.media_id && item.appId === appId);
          if (!draft) {
            error(53404);
            return;
          }
          const publication: MockPublication = {
            publish_id: `${2247483000 + state.publishRequests}`,
            msg_data_id: `${2247490000 + state.publishRequests}`,
            article_id: `article-${appId}-${state.publishRequests}`,
            appId,
            status: state.nextPublishStatus,
            update_time: Math.floor(Date.now() / 1000),
            article: draft.content.news_item[0],
          };
          state.publications.unshift(publication);
          if (state.publishFault === 'after-write') {
            response.destroy();
            return;
          }
          respond(response, {
            errcode: 0,
            errmsg: 'ok',
            publish_id: publication.publish_id,
            msg_data_id: publication.msg_data_id,
          });
          return;
        }
        if (url.pathname === '/cgi-bin/freepublish/get') {
          const item = state.publications.find(
            (entry) => entry.publish_id === String(body.publish_id) && entry.appId === appId,
          );
          if (!item) {
            error(53405);
            return;
          }
          respond(response, {
            publish_id: item.publish_id,
            publish_status: item.status,
            ...(item.status === 0
              ? {
                  article_id: item.article_id,
                  article_detail: {
                    count: 1,
                    item: [{ idx: 1, article_url: `https://mp.weixin.qq.com/s/${item.article_id}` }],
                  },
                }
              : {}),
            fail_idx: item.status >= 2 ? [1] : [],
          });
          return;
        }
        if (url.pathname === '/cgi-bin/freepublish/batchget') {
          const items = state.publications.filter((entry) => entry.appId === appId && entry.status === 0);
          respond(response, {
            total_count: items.length,
            item_count: Math.min(body.count, items.length),
            item: items.slice(body.offset, body.offset + body.count).map((entry) => ({
              article_id: entry.article_id,
              update_time: entry.update_time,
              content: {
                news_item: [
                  {
                    ...entry.article,
                    url: `https://mp.weixin.qq.com/s/${entry.article_id}`,
                    is_deleted: false,
                  },
                ],
              },
            })),
          });
          return;
        }
        if (url.pathname === '/cgi-bin/freepublish/getarticle') {
          const item = state.publications.find(
            (entry) => entry.article_id === body.article_id && entry.appId === appId,
          );
          if (!item) error(53600);
          else
            respond(response, {
              news_item: [{ ...item.article, url: `https://mp.weixin.qq.com/s/${item.article_id}` }],
            });
          return;
        }
        if (url.pathname === '/datacube/getarticletotaldetail') {
          state.metricRequests.push({ begin_date: body.begin_date, end_date: body.end_date });
          if (state.metricsError) {
            error(state.metricsError);
            return;
          }
          respond(response, {
            is_delay: false,
            list: state.publications
              .filter((entry) => entry.appId === appId && entry.status === 0)
              .map((entry) => ({
                msgid: `${entry.msg_data_id}_1`,
                title: entry.article.title,
                content_url: `https://mp.weixin.qq.com/s/${entry.article_id}`,
                detail_list: [
                  // read_finish_rate and collection_user are omitted on purpose: missing values must stay unknown.
                  {
                    stat_date: body.begin_date,
                    read_user: 120,
                    like_user: 8,
                    comment_count: 3,
                    share_user: 5,
                  },
                ],
              })),
          });
          return;
        }
        response.writeHead(404).end();
      })().catch(() => {
        if (!response.destroyed) response.writeHead(500).end();
      });
    });
  });
  return {
    server,
    state,
    listen: async (port = 0) => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
