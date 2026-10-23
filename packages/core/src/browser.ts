export const browserProfiles = {
  xiaohongshu: {
    name: '小红书图文',
    hosts: ['creator.xiaohongshu.com', 'www.xiaohongshu.com', 'edith.xiaohongshu.com'],
    loginUrl: 'https://creator.xiaohongshu.com/',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    listUrl: 'https://creator.xiaohongshu.com/manage',
    title: 'input[placeholder*="标题"], [data-testid="title"]',
    editor: '.tiptap, [contenteditable="true"], [data-testid="editor"]',
    upload: 'input[type="file"][accept*="image"], input[type="file"]',
    coverUpload: '',
    publish: 'button.publishBtn, .publish-button, [data-testid="publish"]',
    identity: 'a[href*="/user/profile/"], [data-user-id], .user-id',
    item: '.note-item, .content-item, [data-testid="published-row"]',
    itemLink: 'a[href*="/explore/"], a[href*="/discovery/item/"], [data-testid="article-link"]',
  },
  toutiao: {
    name: '头条文章',
    hosts: ['mp.toutiao.com', 'www.toutiao.com'],
    loginUrl: 'https://mp.toutiao.com/profile_v4/',
    publishUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    listUrl: 'https://mp.toutiao.com/profile_v4/graphic/content-manage',
    title: 'input[placeholder*="标题"], textarea[placeholder*="标题"], [data-testid="title"]',
    editor: '.ProseMirror, .ql-editor, [contenteditable="true"], [data-testid="editor"]',
    upload: 'input[type="file"][accept*="image"], input[type="file"]',
    coverUpload: '.cover-upload input[type="file"], [data-testid="cover-upload"]',
    publish: 'button.publish-btn, [data-testid="publish"]',
    identity: 'a[href*="/c/user/"], [data-user-id], .account-id',
    item: '.article-item, .content-item, [data-testid="published-row"]',
    itemLink: 'a[href*="toutiao.com/article/"], [data-testid="article-link"]',
  },
  zhihu: {
    name: '知乎专栏文章',
    hosts: ['www.zhihu.com', 'zhuanlan.zhihu.com'],
    loginUrl: 'https://www.zhihu.com/signin',
    publishUrl: 'https://zhuanlan.zhihu.com/write',
    listUrl: 'https://www.zhihu.com/creator/content-management/all',
    title: 'textarea[placeholder*="标题"], input[placeholder*="标题"], [data-testid="title"]',
    editor: '.public-DraftEditor-content, [contenteditable="true"], [data-testid="editor"]',
    upload: 'input[type="file"][accept*="image"], input[type="file"]',
    coverUpload: '',
    publish: '.PublishPanel-triggerButton, [data-testid="publish"]',
    identity: 'a[href*="/people/"], [data-user-id]',
    item: '.ContentItem, .content-item, [data-testid="published-row"]',
    itemLink: 'a[href*="zhuanlan.zhihu.com/p/"], [data-testid="article-link"]',
  },
  baijiahao: {
    name: '百家号图文',
    hosts: ['baijiahao.baidu.com', 'passport.baidu.com'],
    loginUrl: 'https://baijiahao.baidu.com/',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    listUrl: 'https://baijiahao.baidu.com/builder/rc/content',
    title: 'input[placeholder*="标题"], textarea[placeholder*="标题"], [data-testid="title"]',
    editor: '.ql-editor, [contenteditable="true"], [data-testid="editor"]',
    upload: 'input[type="file"][accept*="image"], input[type="file"]',
    coverUpload: '.cover-upload input[type="file"], [data-testid="cover-upload"]',
    publish: '.publish-btn, [data-testid="publish"]',
    identity: '[data-user-id], .user-id, .author-id',
    item: '.article-item, .content-item, [data-testid="published-row"]',
    itemLink: 'a[href*="baijiahao.baidu.com/s"], [data-testid="article-link"]',
  },
  bilibili: {
    name: 'B 站视频',
    hosts: [
      'member.bilibili.com',
      'www.bilibili.com',
      'passport.bilibili.com',
      'space.bilibili.com',
      'api.bilibili.com',
    ],
    loginUrl: 'https://passport.bilibili.com/login',
    publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    listUrl: 'https://member.bilibili.com/platform/upload-manager/video',
    title: 'input[placeholder*="标题"], .video-title input, [data-testid="title"]',
    editor: '[contenteditable="true"], textarea[placeholder*="简介"], [data-testid="editor"]',
    upload: 'input[type="file"][accept*="video"], input[type="file"]',
    coverUpload: '.cover-upload input[type="file"], [data-testid="cover-upload"]',
    publish: '.submit-add, [data-testid="publish"]',
    identity: 'a[href*="space.bilibili.com/"], [data-user-id]',
    item: '.video-item, .content-item, [data-testid="published-row"]',
    itemLink: 'a[href*="bilibili.com/video/"], [data-testid="article-link"]',
  },
} as const;
export type BrowserPlatform = keyof typeof browserProfiles;
export interface ExecutionNode {
  id: string;
  name: string;
  prefix: string;
  accountIds: string[];
  platforms: BrowserPlatform[];
  active: boolean;
  lastSeenAt: string | null;
  agentVersion: string;
  reported: Record<string, unknown>;
}
export interface BrowserConnection {
  id: string;
  accountId: string;
  nodeId: string;
  platform: BrowserPlatform;
  status:
    | 'unconfigured'
    | 'waiting_user'
    | 'waiting_confirmation'
    | 'connected'
    | 'expired'
    | 'mismatch'
    | 'disabled';
  identity: string;
  checkedAt: string | null;
  error: string;
  screenshotAssetId: string | null;
  selectors: Record<string, string>;
  nodeOnline?: boolean;
}
export function allowedBrowserUrl(platform: BrowserPlatform, value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (browserProfiles[platform].hosts as readonly string[]).includes(url.hostname)
    );
  } catch {
    return false;
  }
}
