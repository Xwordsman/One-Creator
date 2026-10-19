import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

test('从首次初始化到人设、素材、创作、卡片、发布与恢复', async ({ page, context }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // Assertions and screenshots should see settled layouts rather than entrance animations.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /开启你的创作空间|欢迎回到创作空间/ })).toBeVisible();
  const setup = await page.getByRole('heading', { name: '开启你的创作空间' }).isVisible();
  if (setup) {
    await page.getByLabel('怎么称呼你').fill('创作体验');
    await page.getByLabel('工作空间名称').fill('我的内容实验室');
  }
  await page.getByLabel('登录账号').fill('creator-test');
  await page.locator('input[name="password"]').fill('Creator-Test-2026!');
  await page.locator('input[name="password"]').press('Enter');
  await expect(page.getByRole('heading', { name: /把灵感，\s*写成自己的作品。/ })).toBeVisible();

  await page.getByRole('link', { name: '账号与人设', exact: true }).click();
  await page.getByRole('button', { name: '创作人设', exact: true }).click();
  await page.getByRole('button', { name: '创建人设', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('人设名称').fill('平实的技术实践者');
  await dialog.getByLabel('内容定位').fill('分享自己验证过的 AI 工具与开发实践');
  await dialog.getByLabel('目标读者').fill('独立开发者和内容创作者');
  await dialog.getByLabel('表达风格').fill('平实、具体，用自己的经验说话');
  await dialog.getByRole('button', { name: '保存人设' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '复制人设 平实的技术实践者' }).click();
  await expect(page.getByRole('heading', { name: '平实的技术实践者 · 副本' })).toBeVisible();
  await page.getByRole('button', { name: '账号档案', exact: true }).click();
  for (const [platform, name, category] of [
    ['wechat', '一个人的技术周刊', '科技'],
    ['xiaohongshu', '日常灵感笔记', '生活'],
    ['toutiao', '工具与生活观察', '科技'],
  ]) {
    await page.getByRole('button', { name: '添加账号', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('select[name="platform"]').selectOption(platform);
    await dialog.getByLabel('账号名称').fill(name);
    await dialog.getByLabel('账号分类').fill(category);
    await dialog.getByLabel('绑定创作人设').selectOption({ label: '平实的技术实践者' });
    await dialog.getByRole('button', { name: '保存账号' }).click();
    await expect(dialog).toBeHidden();
  }
  await page.getByLabel('筛选平台').selectOption('xiaohongshu');
  await expect(page.locator('.account-card')).toHaveCount(1);
  await page.getByLabel('筛选平台').selectOption('');
  await page.getByLabel('筛选分类').selectOption('科技');
  await expect(page.locator('.account-card')).toHaveCount(2);
  await page.getByLabel('筛选分类').selectOption('');
  await page.getByRole('button', { name: '查看 一个人的技术周刊 的创作上下文' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('.capability-list li')).toHaveCount(6);
  await expect(dialog.getByText('待验证').first()).toBeVisible();
  await dialog.getByLabel('AppID').fill('wx1111111111111111');
  await dialog.getByLabel('AppSecret').fill('local-wechat-app-secret');
  await dialog.getByRole('button', { name: '保存并检查连接' }).click();
  await expect(dialog.locator('.connection-heading .badge')).toHaveText('已连接');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('link', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: '添加素材', exact: true }).click();
  dialog = page.getByRole('dialog');
  const importInput = dialog.locator('input[type="file"]');
  await importInput.setInputFiles({
    name: '我的写作笔记.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 导入的笔记\n\n先写下真实的问题。'),
  });
  await expect(dialog.getByLabel('正文或摘录')).toHaveValue(/先写下真实的问题/);
  await expect(dialog.getByLabel('素材标题')).toHaveValue('我的写作笔记');
  await importInput.setInputFiles({
    name: 'too-large.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(1024 * 1024 + 1, 97),
  });
  await expect(dialog.getByRole('alert')).toContainText('最多 1 MB');
  await expect(dialog.getByLabel('正文或摘录')).toHaveValue(/先写下真实的问题/);
  await dialog.getByLabel('素材标题').fill('一次真实的工具尝试');
  await dialog.getByLabel('正文或摘录').fill('先明确问题，再验证方法，最后记录结果。');
  await dialog.getByLabel('原始链接').fill('https://example.com/notes');
  await dialog.getByLabel('来源时间').fill('2026-09-30');
  await dialog.getByRole('button', { name: '保存素材' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByLabel('模型名称').fill('local-test-model');
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:4274/v1');
  await page.getByLabel('API Key').fill('isolated-test-key');
  await page.getByRole('button', { name: '保存模型配置' }).click();
  await expect(page.getByText('已配置', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试已保存配置' }).click();
  await expect(page.getByText(/local-test-model 连接成功/)).toBeVisible();

  await page.getByRole('link', { name: '灵感池', exact: true }).click();
  await page.getByRole('button', { name: '记录灵感', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('这个想法是什么').fill('让 AI 工具真正融入日常创作');
  await dialog.getByLabel('展开说说').fill('从一个小问题开始，用真实的实践记录积累素材。');
  await dialog.getByLabel('想发在哪个账号').selectOption({ label: '一个人的技术周刊' });
  await dialog.getByRole('checkbox', { name: /一次真实的工具尝试/ }).check();
  await dialog.getByRole('button', { name: '保存灵感' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '开始写作', exact: true }).first().click();
  await expect(page.getByLabel('文章标题')).toHaveValue('让 AI 工具真正融入日常创作');
  await expect(page.locator('.citation-item summary').first()).toContainText('一次真实的工具尝试');
  const masterUrl = page.url();
  await page.getByLabel('文章标题').fill('');
  await expect(page.getByLabel('文章正文')).toBeVisible();
  await page.getByLabel('文章标题').fill('让 AI 工具真正融入日常创作');
  await page.getByRole('button', { name: '选择引用资料' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: /一次真实的工具尝试/ }).check();
  await dialog.getByRole('button', { name: '引用所选素材' }).click();
  const citation = page.locator('.citation-item').first();
  await citation.locator('summary').click();
  await citation.getByLabel('已保存原文：一次真实的工具尝试').focus();
  await expect(citation.getByLabel('已保存原文：一次真实的工具尝试')).toBeFocused();
  // Chromium's read-only textarea supports Select All, but not caret movement with Shift+Arrow.
  await page.keyboard.press('Control+a');
  await citation.getByRole('button', { name: '引用选中片段' }).click();
  await expect(citation.locator('.excerpt-item blockquote')).toHaveText(
    '先明确问题，再验证方法，最后记录结果。',
  );
  await page.getByRole('button', { name: '生成大纲', exact: true }).click();
  await expect(page.getByRole('button', { name: '采用结果', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: '采用结果', exact: true }).click();
  await expect(page.getByLabel('文章大纲')).toHaveValue(/先明确自己的需求/);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  const body = page.getByLabel('文章正文');
  await body.fill(
    '## 好内容从实践开始\n\n先记录一个真实的问题，再试着完成一次小小的探索。\n\n' +
      '留下过程和结果，让工具为创作服务。'.repeat(24),
  );
  await page.getByRole('button', { name: '手动保存内容' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await body.focus();
  await page.keyboard.press('Control+End');
  for (let index = 0; index < 10; index++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByText('已选中 10 字符')).toBeVisible();
  await page.getByRole('button', { name: '扩写选中段落' }).click();
  await expect(page.getByRole('button', { name: '采用结果', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: '采用结果', exact: true }).click();
  await expect(body).toHaveValue(/^## 好内容从实践开始[\s\S]*本地测试模型的固定响应/);
  await page.getByRole('button', { name: '排版预览', exact: true }).click();
  await expect(page.locator('.article-preview h2').first()).toHaveText('好内容从实践开始');
  await page.getByRole('button', { name: '图文卡片', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('canvas').first()).toBeVisible();
  const cardsDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载全部卡片' }).click();
  expect((await cardsDownload).suggestedFilename()).toBe('one-creator-cards.zip');
  await dialog.getByRole('button', { name: '保存为稿件配图' }).click();
  await expect(page.getByText('卡片已作为图片附件保存到稿件')).toBeVisible({ timeout: 20000 });
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('button', { name: '裁剪附件 1 为封面', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('canvas')).toBeVisible();
  await dialog.getByRole('button', { name: '保存为封面' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '安排发布', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '创建发布计划' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: '发布日历', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.getByRole('button', { name: '保存到公众号草稿', exact: true }).click();
  await expect(page.locator('.publishing-list .badge').filter({ hasText: /^已存草稿$/ })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator('.draft-receipt')).toContainText('draft-wx1111111111111111');
  await page.screenshot({
    path: 'test-results/wechat-draft-receipt.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto(masterUrl);
  await expect(page.getByLabel('文章标题')).toBeVisible();
  await page.getByRole('button', { name: '创建平台版本', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.locator('select[name="accountId"]').selectOption({ label: '小红书 · 日常灵感笔记' });
  await dialog.getByRole('button', { name: '创建平台版本', exact: true }).click();
  await expect(page).not.toHaveURL(masterUrl);
  await expect(page.getByText('源自母稿第', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '平台改写', exact: true }).click();
  await expect(page.getByRole('button', { name: '采用结果', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: '采用结果', exact: true }).click();

  await page.getByRole('button', { name: '安排发布', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '创建发布计划' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: '发布日历', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.getByRole('button', { name: '回填发布', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('平台文章链接').fill('https://example.com/my-published-note');
  await dialog.getByRole('button', { name: '保存发布记录' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.publishing-list .badge').filter({ hasText: /^已发布$/ })).toBeVisible();
  const packageDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: /导出 .* 的发布包/ })
    .first()
    .click();
  expect((await packageDownload).suggestedFilename()).toContain('.zip');

  await page.getByRole('link', { name: '素材库', exact: true }).click();
  await expect(page.locator('.material-card').filter({ hasText: '一次真实的工具尝试' })).toContainText(
    '2026-09-30',
  );
  await page.getByRole('button', { name: '查看 一次真实的工具尝试 的引用位置' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('link', { name: /让 AI 工具真正融入日常创作/ }).first()).toBeVisible();
  await expect(dialog.getByText('灵感 · 1')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('button', { name: '归档素材 一次真实的工具尝试' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '归档这份素材？' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: /让 AI 工具真正融入日常创作/ }).first()).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();

  await page.goto(masterUrl);
  await expect(page.getByLabel('文章标题')).toBeVisible();
  const second = await context.newPage();
  await second.goto(masterUrl);
  await expect(second.getByLabel('文章正文')).toBeVisible();
  await page.getByLabel('文章正文').fill('第一标签页的新版本');
  await page.getByRole('button', { name: '手动保存内容' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await second.getByLabel('文章正文').fill('第二标签页的独立修改');
  await second.getByRole('button', { name: '手动保存内容' }).click();
  await expect(second.getByText('内容已在其他位置更新', { exact: false }).first()).toBeVisible();
  await expect(second.getByLabel('文章正文')).toHaveValue('第二标签页的独立修改');
  await second.close();
  await context.clearCookies();
  await page.getByLabel('文章正文').fill('登录过期时，这段尚未保存的内容不能丢失。');
  await page.getByRole('button', { name: '手动保存内容' }).click();
  await expect(page.getByRole('alert').first()).toContainText('登录已过期');
  await expect(page.getByLabel('文章正文')).toHaveValue('登录过期时，这段尚未保存的内容不能丢失。');
  const loginPage = await context.newPage();
  await loginPage.goto('/');
  await loginPage.getByLabel('登录账号').fill('creator-test');
  await loginPage.locator('input[name="password"]').fill('Creator-Test-2026!');
  await loginPage.getByRole('button', { name: '进入工作台' }).click();
  await expect(loginPage.getByRole('link', { name: '账号与人设', exact: true })).toBeVisible();
  await loginPage.close();
  await page.getByRole('button', { name: '手动保存内容' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await page.getByRole('button', { name: '查看历史版本' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^第 1 版/ }).click();
  await dialog.getByRole('button', { name: '恢复为新版本' }).click();
  await expect(page.getByText('历史内容已恢复为新版本')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('文章正文')).toHaveValue('');

  await page.getByRole('link', { name: '设置', exact: true }).click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载备份' }).click();
  const backup = unzipSync(await readFile((await (await backupDownload).path())!));
  expect(JSON.parse(strFromU8(backup['data.json'])).tables.documents.length).toBeGreaterThanOrEqual(2);
  expect(Object.keys(backup).some((name) => name.startsWith('assets/'))).toBe(true);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /把灵感，\s*写成自己的作品。/ })).toBeVisible();
  await expect(page.locator('.document-row').first()).toBeVisible();
  await page.screenshot({
    path: 'test-results/workspace-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Text inside links inherits its colour through a transition; wait for the dark foreground before capturing.
  for (const selector of ['.stat-card > strong', '.document-row-main > strong'])
    await expect(page.locator(selector).first()).toHaveCSS('color', 'rgb(229, 234, 225)');
  await page.screenshot({ path: 'test-results/workspace-dark.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '切换浅色主题' }).click();

  await page.setViewportSize({ width: 375, height: 812 });
  const fitsWidth = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await expect(page.getByRole('heading', { name: /把灵感，\s*写成自己的作品。/ })).toBeVisible();
  expect(await fitsWidth()).toBe(true);
  await page.goto(masterUrl);
  await expect(page.getByLabel('文章正文')).toBeVisible();
  expect(await fitsWidth()).toBe(true);
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: '每一次操作，都有记录' })).toBeVisible();
  await expect(page.locator('.job-row').first()).toBeVisible();
  await page.getByRole('button', { name: '素材导入', exact: true }).click();
  await expect(page.locator('.job-row')).toHaveCount(2);
  await expect(page.locator('.job-row').filter({ hasText: 'too-large.txt' })).toContainText('执行失败');
  await page.getByRole('button', { name: '平台草稿', exact: true }).click();
  await expect(page.locator('.job-row').filter({ hasText: '公众号草稿' })).toContainText('已完成');
  expect(await fitsWidth()).toBe(true);
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: '内容库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的内容，在这里生长' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  expect(await fitsWidth()).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test('创作资源、自动化结果、集成凭据、执行节点与运营页面', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The first test created the workspace in this preview instance.
  await page.goto('/');
  await page.getByLabel('登录账号').fill('creator-test');
  await page.locator('input[name="password"]').fill('Creator-Test-2026!');
  await page.locator('input[name="password"]').press('Enter');
  await expect(page.getByRole('heading', { name: /把灵感，\s*写成自己的作品。/ })).toBeVisible();

  // CRE-06: a preset with a declared variable; the hint explains the creativity parameter.
  await page.getByRole('link', { name: '创作资源与运营', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创作资源与运营' })).toBeVisible();
  await page.getByRole('button', { name: '新建写作预设' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^名称(\s*\*)?$/).fill('实测类正文');
  await dialog.getByLabel('提示词模板').fill('围绕 {{topic}} 写一篇有实测记录的文章。');
  await expect(dialog.getByText(/0 更稳妥、贴近素材/)).toBeVisible();
  await dialog.getByRole('button', { name: '添加变量' }).click();
  await dialog.getByLabel('变量名（英文字母）').fill('topic');
  await dialog.getByLabel('显示名称').fill('主题');
  await dialog.getByRole('button', { name: '保存写作预设' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.resource-card').filter({ hasText: '实测类正文' })).toContainText('v1');

  // FMT-05: a visual template with its own colours.
  await page.getByRole('button', { name: '视觉模板', exact: true }).click();
  await page.getByRole('button', { name: '新建视觉模板' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^名称(\s*\*)?$/).fill('深绿周刊');
  await dialog.getByLabel('强调色').fill('#2f6f4e');
  await dialog.getByLabel('字体').selectOption('noto');
  await dialog.getByLabel('画面比例').selectOption('1:1');
  await dialog.getByLabel('页脚').fill('一个人的技术周刊');
  await dialog.getByRole('button', { name: '保存视觉模板' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.visual-swatch')).toContainText('一个人的技术周刊');

  // The template drives the article preview, the card preset and the cover ratio of a document.
  await page.getByRole('link', { name: '内容库', exact: true }).click();
  await page
    .locator('.content-card')
    .filter({ hasText: '一个人的技术周刊' })
    .filter({ hasText: '让 AI 工具真正融入日常创作' })
    .first()
    .click();
  await page.getByLabel('视觉模板').selectOption({ label: '深绿周刊 · v1' });
  await page.getByRole('button', { name: '排版预览', exact: true }).click();
  await expect(page.locator('.preview-toolbar')).toContainText('深绿周刊 · v1', { timeout: 10000 });
  await page.getByRole('button', { name: '图文卡片', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('视觉主题')).toHaveValue('template');
  // The warning must match what this browser can actually render, so check the font independently.
  const notoMissing = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!;
    return ['monospace', 'serif', 'sans-serif'].every((base) => {
      context.font = `32px ${base}`;
      const fallback = context.measureText('创作有自己的节奏 mmmwwwlli').width;
      context.font = `32px "Noto Sans CJK SC", ${base}`;
      return context.measureText('创作有自己的节奏 mmmwwwlli').width === fallback;
    });
  });
  if (notoMissing) await expect(dialog.locator('.text-warning')).toContainText('Noto Sans CJK SC');
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  // The article was restored to an earlier revision without images in the first test; attach one to crop.
  await page
    .locator('label.file-button', { hasText: '添加图片附件' })
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'cover-source.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  await page.getByRole('button', { name: '裁剪附件 1 为封面', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('封面比例')).toHaveValue('1');
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('link', { name: '创作资源与运营', exact: true }).click();

  // ACC-05: style extraction runs through the preview model and stays a candidate until adopted.
  await page.getByRole('button', { name: '从样文提炼风格' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加参考素材' }).click();
  const material = dialog.locator('.schema-array-item select').first();
  await material.selectOption(
    (await material
      .locator('option')
      .filter({ hasText: '一次真实的工具尝试' })
      .first()
      .getAttribute('value')) ?? '',
  );
  await dialog.getByLabel('新建人设名称（未选人设时）').fill('从样文提炼的人设');
  await dialog.getByRole('button', { name: '开始样文风格提炼' }).click();
  await expect(page).toHaveURL(/\/studio\/tasks\//);
  await expect(page.locator('.badge').filter({ hasText: '已完成' })).toBeVisible();
  await expect(page.getByLabel('表达语气')).toHaveValue(/本地预览模型示例/);
  await page.getByRole('button', { name: '采用为人设新版本' }).click();
  await expect(page.getByRole('button', { name: '采用为人设新版本' })).toBeDisabled();

  // EXT-01 / PUB-09: credentials appear once; the node starts offline.
  await page.getByRole('link', { name: '成员与集成', exact: true }).click();
  await page.getByRole('button', { name: 'API 令牌', exact: true }).click();
  await page.getByRole('button', { name: '创建令牌' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^名称(\s*\*)?$/).fill('自动化脚本');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByLabel('新生成的凭据')).toHaveValue(/^oc_/);
  const token = await page.getByLabel('新生成的凭据').inputValue();
  await page.keyboard.press('Escape');
  // The list shows only a short prefix to tell tokens apart; the full value is never shown again.
  await expect(page.locator('.data-table')).toContainText('自动化脚本');
  await expect(page.locator('.data-table')).toContainText(token.slice(0, 12));
  await expect(page.locator('.data-table')).not.toContainText(token);
  await page.getByRole('button', { name: '执行节点', exact: true }).click();
  await page.getByRole('button', { name: '注册节点' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^名称(\s*\*)?$/).fill('家里的电脑');
  await dialog.getByRole('button', { name: '添加授权账号' }).click();
  await dialog.locator('.schema-array-item select').first().selectOption({ label: '日常灵感笔记' });
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByLabel('新生成的凭据')).toHaveValue(/^ocn_/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.data-table tr').filter({ hasText: '家里的电脑' })).toContainText('离线');

  // PUB-06: the account binds to the node; login is queued and can be cancelled while the node is offline.
  await page.getByRole('link', { name: '账号与人设', exact: true }).click();
  await page.getByRole('button', { name: '查看 日常灵感笔记 的创作上下文' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText('小红书图文 · 独立执行节点')).toBeVisible();
  await dialog.getByLabel('执行节点').selectOption({ label: '家里的电脑' });
  await dialog.getByRole('button', { name: '保存节点' }).click();
  await dialog.getByRole('button', { name: '扫码登录' }).click();
  await expect(dialog.getByText(/登录任务已排队/)).toBeVisible();
  await dialog.getByRole('button', { name: '取消登录' }).click();
  await expect(dialog.getByRole('button', { name: '扫码登录' })).toBeVisible();
  await expect(dialog.locator('.capability-list')).toContainText('登录任务已取消');
  await page.keyboard.press('Escape');

  // MAT-06: without a vector service, search falls back to keywords and says so.
  await page.getByRole('link', { name: '订阅与资料检索', exact: true }).click();
  await page.getByRole('button', { name: '语义检索', exact: true }).click();
  await page.getByLabel('想找什么资料').fill('验证方法');
  await page.getByRole('button', { name: '搜索资料' }).click();
  await expect(page.getByText(/关键词检索 · 请先在设置中配置「向量检索」服务/)).toBeVisible();
  await expect(page.locator('.result-list article').first()).toContainText('一次真实的工具尝试');

  // DAT-03 / SYS-06 / VID / SYS-07 pages render real empty or recorded states.
  await page.getByRole('link', { name: '表现与复盘', exact: true }).click();
  await expect(page.getByRole('heading', { name: '表现数据与内容复盘' })).toBeVisible();
  await page.getByRole('link', { name: '模型用量', exact: true }).click();
  await expect(page.locator('.data-table')).toContainText('local-test-model');
  await page.getByRole('link', { name: '媒体与视频', exact: true }).click();
  await expect(page.getByRole('heading', { name: '媒体与视频工作台' })).toBeVisible();
  await page.getByRole('link', { name: /站内通知/ }).click();
  await expect(page.getByRole('heading', { name: '站内通知' })).toBeVisible();
  await page.getByRole('link', { name: '发布日历', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('.publish-row').first()).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  // Report the elements that stick out, so a layout regression names its cause.
  const overflowing = () =>
    page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth
        ? []
        : [...document.querySelectorAll<HTMLElement>('main *')]
            .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
            .filter((element) => !element.parentElement?.closest('.data-table-wrap, .tabs'))
            .slice(0, 5)
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}.${element.className} ${Math.round(element.getBoundingClientRect().right)}px`,
            ),
    );
  for (const path of [
    '/studio',
    '/workspace?tab=nodes',
    '/discovery',
    '/analytics',
    '/usage',
    '/publishing',
  ]) {
    await page.goto(path);
    await expect(page.locator('.page-heading h1, h1').first()).toBeVisible();
    expect(await overflowing(), path).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/studio-mobile.png', fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test('媒体：配置服务、转写、生成脚本、真实 FFmpeg 合成视频，预览并调整片段后导出', async ({ page }) => {
  test.setTimeout(240000);
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Real media files made by the bundled FFmpeg: a 3-second clip with sound, and a voice-over track.
  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static') as string;
  const folder = await mkdtemp(path.resolve('.data/test-temp/e2e-media-'));
  const run = (args: string[]) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd: folder,
      windowsHide: true,
    });
  run([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x335544:s=320x240:r=25:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    'interview.mp4',
  ]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', 'voice.wav']);
  try {
    await page.goto('/');
    await page.getByLabel('登录账号').fill('creator-test');
    await page.locator('input[name="password"]').fill('Creator-Test-2026!');
    await page.locator('input[name="password"]').press('Enter');
    await expect(page.getByRole('heading', { name: /把灵感，\s*写成自己的作品。/ })).toBeVisible();

    // Media services are configured in the browser like a real deployment would be.
    await page.getByRole('link', { name: '设置', exact: true }).click();
    for (const [name, baseUrl, model, key, message] of [
      ['媒体转写', 'http://127.0.0.1:4274/v1', 'local-whisper', 'isolated-test-key', '模型列表可访问'],
      ['视频服务', 'http://127.0.0.1:4276/v1', 'ffmpeg', 'preview-media-service-token', '媒体服务可访问'],
    ]) {
      const row = page.locator('.capability-settings-list > div').filter({ hasText: name });
      await row.getByRole('button', { name: '配置' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel(/^服务基础地址/).fill(baseUrl);
      await dialog.getByLabel(/^模型 ID/).fill(model);
      await dialog.getByLabel(/^API Key/).fill(key);
      await dialog.getByRole('button', { name: '保存服务配置' }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText('已配置');
      await row.getByRole('button', { name: '配置' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '测试已保存服务' }).click();
      await expect(dialog.getByRole('status')).toContainText(message);
      await page.keyboard.press('Escape');
    }

    await page.getByRole('link', { name: '媒体与视频', exact: true }).click();
    await page
      .locator('label.file-button', { hasText: '上传音视频' })
      .locator('input[type="file"]')
      .setInputFiles([path.join(folder, 'interview.mp4'), path.join(folder, 'voice.wav')]);
    await expect(page.locator('.resource-card')).toHaveCount(2, { timeout: 20000 });
    const interview = page.locator('.resource-card').filter({ hasText: 'interview.mp4' });

    // VID-01: timed transcript from the uploaded video.
    await interview.getByRole('button', { name: '转写' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.locator('.info-note').first()).toContainText('local-whisper');
    await dialog.getByRole('button', { name: '开始媒体转写' }).click();
    await expect(page).toHaveURL(/\/studio\/tasks\//);
    await expect(page.locator('.badge').filter({ hasText: '已完成' })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.transcript-results')).toContainText('这是本地预览转写的第一句。');

    // Transcript → editable script → real synthesis with the uploaded voice-over (no speech service needed).
    await page.getByRole('link', { name: '编辑带时间的转写' }).click();
    await page
      .locator('.resource-card')
      .filter({ hasText: 'interview.mp4' })
      .getByRole('button', { name: '生成视频脚本' })
      .click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '开始生成视频脚本' }).click();
    await expect(page.locator('.badge').filter({ hasText: '已完成' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '保存为可编辑视频脚本' }).click();
    await expect(page.getByRole('button', { name: '保存为可编辑视频脚本' })).toBeDisabled();
    await page.goto('/studio?kind=video_script');
    await page.locator('.resource-card').first().getByRole('button', { name: '合成短视频' }).click();
    dialog = page.getByRole('dialog');
    const voice = dialog.getByLabel('配音文件（留空使用语音模型）');
    await voice.selectOption(
      (await voice.locator('option').filter({ hasText: 'voice.wav' }).first().getAttribute('value')) ?? '',
    );
    await dialog.getByRole('button', { name: '开始合成短视频' }).click();
    await expect(page.locator('.badge').filter({ hasText: '已完成' })).toBeVisible({ timeout: 150000 });
    await expect(page.locator('.result-panel video.media-preview')).toHaveCount(1);
    const rendered = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出视频、封面、字幕与清单' }).click();
    const renderedFiles = unzipSync(await readFile(await (await rendered).path()));
    expect(Object.keys(renderedFiles).sort()).toEqual([
      'copy.md',
      'cover.jpg',
      'manifest.json',
      'subtitles.srt',
      'video.mp4',
    ]);
    expect(strFromU8(renderedFiles['video.mp4'].subarray(4, 8))).toBe('ftyp');

    // VID-03: pick ranges against the playing source, preview them, then cut, export one clip and adjust.
    await page.getByRole('link', { name: '媒体与视频', exact: true }).click();
    await page
      .locator('.resource-card')
      .filter({ hasText: 'interview.mp4' })
      .getByRole('button', { name: '选择片段' })
      .click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/原视频 0:0[23]\.\d/)).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByRole('button', { name: '开始视频切片' })).toBeDisabled();
    await dialog.getByRole('button', { name: '从当前位置添加片段' }).click();
    await expect(dialog.getByLabel('片段 1 结束（秒）')).toHaveValue('3');
    await dialog.getByLabel('原视频预览').evaluate((element: HTMLVideoElement) => {
      element.currentTime = 0.5;
    });
    await expect
      .poll(() =>
        dialog.getByLabel('原视频预览').evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeGreaterThan(0.4);
    await dialog.getByRole('button', { name: '设为开始' }).click();
    await expect(dialog.getByLabel('片段 1 开始（秒）')).toHaveValue('0.5');
    await dialog.getByLabel('片段 1 结束（秒）').fill('9');
    await expect(dialog.locator('.clip-problem')).toContainText('超出原视频时长');
    await dialog.getByLabel('片段 1 结束（秒）').fill('2');
    await dialog.getByLabel('片段 1 名称').fill('开场');
    await dialog.getByRole('button', { name: '预览' }).click();
    await expect
      .poll(() => dialog.getByLabel('原视频预览').evaluate((element: HTMLVideoElement) => element.paused), {
        timeout: 10000,
      })
      .toBe(true);
    const position = await dialog
      .getByLabel('原视频预览')
      .evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(position).toBeGreaterThanOrEqual(1.9);
    expect(position).toBeLessThan(2.6);
    const transcriptSelect = dialog.getByLabel('参考转写');
    await transcriptSelect.selectOption(
      (await transcriptSelect
        .locator('option')
        .filter({ hasText: 'interview.mp4' })
        .first()
        .getAttribute('value')) ?? '',
    );
    await dialog.getByRole('button', { name: '开始视频切片' }).click();
    await expect(page.locator('.badge').filter({ hasText: '已完成' })).toBeVisible({ timeout: 90000 });
    await expect(page.locator('.result-panel')).toContainText('clip-0.mp4 · 原片 0.5–2 秒');
    const clip = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出此片段发布包' }).click();
    const clipFiles = unzipSync(await readFile(await (await clip).path()));
    expect(Object.keys(clipFiles).sort()).toEqual([
      'clip-0.mp4',
      'copy.md',
      'cover-0.jpg',
      'manifest.json',
      'subtitles-0.srt',
    ]);
    expect(strFromU8(clipFiles['copy.md'])).toContain('## 片段 1 · 开场');
    expect(strFromU8(clipFiles['subtitles-0.srt'])).toContain('这是本地预览转写的第一句。');
    await page.getByRole('button', { name: '调整片段重新切片' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('片段 1 开始（秒）')).toHaveValue('0.5');
    await expect(dialog.getByLabel('片段 1 名称')).toHaveValue('开场');
    await page.keyboard.press('Escape');
    expect(consoleErrors).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
