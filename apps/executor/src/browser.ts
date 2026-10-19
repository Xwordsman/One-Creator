import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  browserProfiles,
  type BrowserPlatform,
  type ContentDocument,
  allowedBrowserUrl,
} from '@one-creator/core';
import { renderArticle } from '@one-creator/rendering';
import { encryptSecret, decryptSecret } from '@one-creator/server/crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface BrowserJob {
  id: string;
  kind: 'browser_login' | 'browser_publish' | 'browser_verify';
  leaseToken: string;
  account: { id: string; name: string; platform: BrowserPlatform; handle: string };
  selectors: Record<string, string>;
  document: ContentDocument | null;
  assets: { id: string; filename: string; mime: string; size: number }[];
  submittedAt: string | null;
  resetSession: boolean;
}
export interface BrowserResult {
  state: 'connected' | 'failed' | 'submitted' | 'published' | 'uncertain' | 'not_found';
  identity?: string;
  url?: string;
  message?: string;
  receipt?: Record<string, unknown>;
}
export interface BrowserClient {
  heartbeat: (stage: string, progress?: Record<string, unknown>) => Promise<void>;
  screenshot: (bytes: Buffer) => Promise<void>;
  asset: (assetId: string) => Promise<Buffer>;
  commands: () => Promise<
    { id: string; kind: string; x?: number; y?: number; text?: string; key?: string }[]
  >;
  ack: (ids: string[]) => Promise<void>;
}
export interface BrowserConfig {
  dataDir: string;
  encryptionKey: string;
  executablePath?: string;
  headless?: boolean;
  loginTimeoutMs?: number;
  testProfile?: Partial<Record<BrowserPlatform, Record<string, string>>>;
}
async function first(page: Page, selector: string) {
  const candidates = page.locator(selector);
  for (let i = 0; i < (await candidates.count()); i++) {
    const candidate = candidates.nth(i);
    if (await candidate.isVisible()) return candidate;
  }
  return null;
}
function identities(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  const result: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'user_id',
        'userId',
        'uid',
        'mid',
        'media_id',
        'mediaId',
        'url_token',
        'red_id',
        'creator_id',
      ].includes(key) &&
      (typeof item === 'string' || typeof item === 'number')
    )
      result.push(String(item));
    else if (['data', 'user', 'user_info', 'userInfo', 'account', 'media', 'info'].includes(key))
      result.push(...identities(item, depth + 1));
  }
  return result;
}
async function browserIdentity(
  page: Page,
  context: BrowserContext,
  platform: BrowserPlatform,
  selector: string,
  observed: Set<string>,
  expected: string,
) {
  if (platform === 'bilibili') {
    const uid = (await context.cookies()).find((cookie) => cookie.name === 'DedeUserID')?.value;
    if (uid) return uid;
  }
  const candidates = new Set<string>();
  for (const element of await page.locator(selector).all()) {
    for (const attribute of ['data-user-id', 'data-uid', 'data-id']) {
      const value = await element.getAttribute(attribute);
      if (value) candidates.add(value);
    }
    const href = await element.getAttribute('href');
    if (href) {
      const match = href.match(/(?:user\/profile|c\/user\/token|people|space\.bilibili\.com)\/([^/?#]+)/);
      if (match) candidates.add(match[1]);
    }
    const text = (await element.textContent())?.trim();
    const match = text?.match(
      /(?:小红书号|用户ID|用户 ID|UID|账号ID|账号 ID|作者ID)\s*[:：]?\s*([A-Za-z0-9_-]+)/,
    );
    if (match) candidates.add(match[1]);
  }
  const values = observed.size ? observed : candidates;
  if (expected && values.has(expected)) return expected;
  return values.size === 1 ? [...values][0] : '';
}
export async function runBrowserJob(
  job: BrowserJob,
  config: BrowserConfig,
  client: BrowserClient,
  signal: AbortSignal,
): Promise<BrowserResult> {
  const base = browserProfiles[job.account.platform];
  if (!base) throw new Error('Unsupported browser platform');
  const profile = { ...base, ...job.selectors, ...config.testProfile?.[job.account.platform] };
  const scope = `${job.account.platform}:${job.account.id}`;
  const profilesDir = path.join(config.dataDir, 'profiles'),
    workDir = path.join(config.dataDir, 'jobs', job.id);
  await mkdir(profilesDir, { recursive: true });
  const statePath = path.join(profilesDir, `${scope.replace(':', '-')}.enc`);
  let state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  if (job.resetSession && job.kind === 'browser_login') await rm(statePath, { force: true });
  try {
    state = JSON.parse(decryptSecret(await readFile(statePath, 'utf8'), config.encryptionKey, scope));
  } catch {
    if (job.kind !== 'browser_login')
      return {
        state: 'failed',
        message: '本节点没有可用会话，请重新扫码登录',
        receipt: { connectionState: 'expired' },
      };
  }
  // Downloaded media lives here only while the job runs; the finally block removes it.
  await mkdir(workDir, { recursive: true });
  const browser = await chromium.launch({
    headless: config.headless ?? true,
    executablePath: config.executablePath,
  });
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  let identity = '',
    stage = 'preparing';
  const observed = new Set<string>();
  page.on('response', (response) => {
    try {
      const url = new URL(response.url());
      if (
        (base.hosts as readonly string[]).includes(url.hostname) &&
        /(selfinfo|galaxy\/user\/info|user\/profile|api\/v4\/me|account\/info|x\/web-interface\/nav)/i.test(
          url.pathname,
        )
      )
        void response
          .json()
          .then((data) => {
            const values = identities(data);
            if (values.length) {
              observed.clear();
              for (const value of values) observed.add(value);
            }
          })
          .catch(() => {});
    } catch {}
  });
  const stop = () => {
    void context.close().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  const heartbeat = async (next: string, progress: Record<string, unknown> = {}) => {
    stage = next;
    signal.throwIfAborted();
    await client.heartbeat(next, progress);
  };
  const screen = async () => {
    await client.screenshot(await page.screenshot({ type: 'png', fullPage: false }));
  };
  try {
    if (job.kind === 'browser_login') {
      await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const started = Date.now();
      let lastFrame = '',
        lastUpload = 0;
      while (Date.now() - started < (config.loginTimeoutMs ?? 8 * 60000)) {
        await heartbeat('waiting_user', {
          message: '请扫描二维码或完成页面中的登录验证',
          expiresAt: new Date(started + (config.loginTimeoutMs ?? 8 * 60000)).toISOString(),
        });
        identity = await browserIdentity(
          page,
          context,
          job.account.platform,
          profile.identity,
          observed,
          job.account.handle,
        );
        if (identity) {
          if (job.account.handle && identity !== job.account.handle) {
            await screen();
            return {
              state: 'failed',
              identity,
              message: '当前登录账号与档案 ID 不一致',
              receipt: { connectionState: 'mismatch' },
            };
          }
          const saved = encryptSecret(
            JSON.stringify(await context.storageState()),
            config.encryptionKey,
            scope,
          );
          const temp = `${statePath}.${randomUUID()}.tmp`;
          await writeFile(temp, saved, { mode: 0o600 });
          await rename(temp, statePath);
          await screen();
          return {
            state: 'connected',
            identity,
            message: job.account.handle ? '已核对账号身份并保存加密会话' : '已识别账号，请在工作台确认绑定',
          };
        }
        // Upload only changed frames, plus a periodic refresh, so a waiting QR page does not flood the server.
        const frame = await page.screenshot({ type: 'png', fullPage: false }),
          digest = createHash('sha256').update(frame).digest('hex');
        if (digest !== lastFrame || Date.now() - lastUpload > 15000) {
          await client.screenshot(frame);
          lastFrame = digest;
          lastUpload = Date.now();
        }
        const commands = await client.commands();
        for (const command of commands) {
          if (command.kind === 'click') await page.mouse.click(command.x!, command.y!);
          else if (command.kind === 'type') await page.keyboard.insertText(command.text ?? '');
          else if (command.kind === 'key') await page.keyboard.press(command.key!);
          await client.ack([command.id]);
        }
        await delay(2000, undefined, { signal });
      }
      return {
        state: 'failed',
        message: '登录等待超时，请重新发起扫码',
        receipt: { connectionState: 'expired' },
      };
    }
    await page.goto(job.kind === 'browser_verify' ? profile.listUrl : profile.publishUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      identity = await browserIdentity(
        page,
        context,
        job.account.platform,
        profile.identity,
        observed,
        job.account.handle,
      );
      if (identity) break;
      await heartbeat('preparing');
      await delay(1000, undefined, { signal });
    }
    if (!job.account.handle || identity !== job.account.handle) {
      await screen();
      return {
        state: 'failed',
        identity,
        message: '无法核对当前登录账号，请重新扫码或校准身份选择器',
        receipt: { connectionState: identity ? 'mismatch' : 'expired' },
      };
    }
    const document = job.document!;
    if (job.kind === 'browser_publish') {
      await heartbeat('uploading');
      const imageIds = [
        ...new Set(
          [
            document.coverAssetId,
            ...document.assetIds,
            ...job.assets.filter((asset) => asset.mime.startsWith('image/')).map((asset) => asset.id),
          ].filter(Boolean),
        ),
      ] as string[];
      const input = page.locator(profile.upload).first();
      const uploadIds =
        job.account.platform === 'bilibili'
          ? ([document.videoAssetId].filter(Boolean) as string[])
          : imageIds;
      if (job.account.platform === 'bilibili' && !uploadIds.length) throw new Error('VIDEO_REQUIRED');
      const files = [];
      for (const assetId of uploadIds) {
        const asset = job.assets.find((asset) => asset.id === assetId)!;
        if (!asset) throw new Error('ASSET_NOT_BOUND');
        const target = path.join(
          workDir,
          `${asset.id}${path.extname(asset.filename).replace(/[^.a-zA-Z0-9]/g, '')}`,
        );
        await writeFile(target, await client.asset(assetId));
        files.push(target);
      }
      if (files.length) {
        if (!(await input.count())) throw new Error('UPLOAD_SELECTOR');
        const multiple = await input.getAttribute('multiple');
        if (files.length > 1 && multiple === null) {
          for (const file of files) {
            await input.setInputFiles(file);
            await delay(700, undefined, { signal });
          }
        } else await input.setInputFiles(files);
      }
      const title = await first(page, profile.title);
      if (!title) throw new Error('TITLE_SELECTOR');
      await title.fill(document.title);
      const editor = await first(page, profile.editor);
      if (!editor) throw new Error('EDITOR_SELECTOR');
      const body = document.body.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
      const tag = await editor.evaluate((element) => element.tagName.toLowerCase());
      if (tag === 'textarea' || tag === 'input' || job.account.platform === 'xiaohongshu')
        await editor.fill(body);
      else
        await editor.evaluate(
          (element, html) => {
            element.innerHTML = html;
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          },
          renderArticle(body, document.context.visual),
        );
      if (profile.coverUpload && document.coverAssetId) {
        const cover = job.assets.find((asset) => asset.id === document.coverAssetId)!;
        const target = path.join(workDir, `cover${path.extname(cover.filename)}`);
        await writeFile(target, await client.asset(cover.id));
        const input = page.locator(profile.coverUpload).first();
        if (!(await input.count())) throw new Error('COVER_SELECTOR');
        await input.setInputFiles(target);
      }
      await heartbeat('filling');
      const uploadStart = Date.now();
      while (Date.now() - uploadStart < 15 * 60000) {
        const uploading = await page
          .getByText(/上传中|正在上传|转码中/)
          .first()
          .isVisible()
          .catch(() => false);
        if (!uploading) break;
        await heartbeat('uploading');
        await delay(1500, undefined, { signal });
      }
      if (
        await page
          .getByText(/上传失败|格式不支持/)
          .first()
          .isVisible()
          .catch(() => false)
      )
        throw new Error('UPLOAD_FAILED');
      identity = await browserIdentity(
        page,
        context,
        job.account.platform,
        profile.identity,
        observed,
        job.account.handle,
      );
      if (identity !== job.account.handle) throw new Error('IDENTITY_CHANGED');
      await screen();
      let publish = await first(page, profile.publish);
      if (!publish)
        publish = await page
          .getByRole('button', {
            name: job.account.platform === 'bilibili' ? '立即投稿' : '发布',
            exact: true,
          })
          .first();
      if (!(await publish.isVisible())) throw new Error('PUBLISH_SELECTOR');
      // Once this durable fence succeeds there is exactly one click attempt; failures after it are uncertain.
      await heartbeat('publishing', { identity, selectorVersion: '2026-10-17' });
      await publish.click({ timeout: 20000 });
      for (let attempt = 0; attempt < 15; attempt++) {
        await heartbeat('verifying', { identity });
        if (
          await page
            .getByText(/发布成功|投稿成功|提交成功|审核中/)
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          await screen();
          return {
            state: 'submitted',
            identity,
            message: '页面显示已提交，尚未核对为正式发布',
            receipt: { pageUrl: page.url(), selectorVersion: '2026-10-17' },
          };
        }
        await delay(1000, undefined, { signal });
      }
      await screen();
      return { state: 'uncertain', identity, message: '点击提交后未取得可核验回执，请在工作台核对' };
    }
    await heartbeat('verifying', { identity });
    const candidates = [];
    for (const row of await page.locator(profile.item).all()) {
      const text = await row.innerText();
      if (!text.includes(document.title) || !/已发布/.test(text) || /审核中|发布中|未发布/.test(text))
        continue;
      const link = row.locator(profile.itemLink).first();
      if (!(await link.count())) continue;
      const href = await link.getAttribute('href');
      if (!href) continue;
      const url = new URL(href, page.url()).href;
      if (!config.testProfile && !allowedBrowserUrl(job.account.platform, url)) continue;
      // Prefer exact row title metadata. Ambiguous matching leaves the original result unverified.
      const exactTitle =
        (await row.getAttribute('data-title')) ??
        (await row
          .locator(job.selectors.itemTitle ?? '[data-testid="article-title"], .title, h3, h2')
          .first()
          .textContent({ timeout: 2000 })
          .catch(() => null));
      if (exactTitle?.trim() !== document.title) continue;
      const time =
        (await row.getAttribute('data-published-at')) ??
        (await row
          .locator(job.selectors.itemTime ?? 'time, .publish-time, .time')
          .first()
          .getAttribute('datetime', { timeout: 2000 })
          .catch(() => null));
      if (
        job.submittedAt &&
        (!time ||
          !Number.isFinite(Date.parse(time)) ||
          Date.parse(time) < Date.parse(job.submittedAt) - 60000)
      )
        continue;
      const article = await context.newPage();
      try {
        await article.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const content = await article
          .locator(
            job.selectors.articleBody ??
              '[data-testid="article-body"], .note-text, .Post-RichTextContainer, .article-content, .desc-info',
          )
          .first()
          .textContent({ timeout: 5000 });
        const normalize = (value: string) =>
          value.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s#*_`>]/g, '');
        const expected = normalize(document.body);
        if (!content || !normalize(content).includes(expected)) continue;
      } catch {
        continue;
      } finally {
        await article.close();
      }
      candidates.push(url);
    }
    await screen();
    if (candidates.length === 1)
      return {
        state: 'published',
        identity,
        url: candidates[0],
        message: '内容管理页有唯一已发布条目',
        receipt: { pageUrl: page.url(), title: document.title, selectorVersion: '2026-10-17' },
      };
    return { state: 'not_found', identity, message: '没有唯一可核验的已发布条目，不能把查询不到当作未提交' };
  } catch {
    try {
      await screen();
    } catch {}
    return {
      state:
        ['publishing', 'verifying'].includes(stage) && job.kind === 'browser_publish'
          ? 'uncertain'
          : 'failed',
      identity: identity || undefined,
      message: `浏览器任务在 ${stage} 阶段未完成，请检查截图、登录状态和选择器`,
    };
  } finally {
    signal.removeEventListener('abort', stop);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  }
}
