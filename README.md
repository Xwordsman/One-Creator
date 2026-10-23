# One-Creator

[![CI](https://github.com/Xwordsman/One-Creator/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwordsman/One-Creator/actions/workflows/ci.yml)

**把灵感，写成自己的作品。**

One-Creator 是一个面向个人创作者、可自部署的 AI 自媒体工作台。围绕账号与人设，管理灵感、素材、母稿、多平台版本和发布记录。

当前版本：`0.1.0-alpha.1`，见 [发布说明](docs/releases/v0.1.0-alpha.1.md)。产品全景与实现状态见 [项目文档](docs/README.md) 和 [开发进度](docs/progress.md)。

## 当前可用

- 首次初始化、工作台登录、个人工作空间。
- 微信公众号、小红书、头条账号档案；同平台多账号，按平台与分类筛选；可版本化的创作人设与账号偏好。
- 灵感池（可关联素材）、文字 / 链接 / 图片素材、Markdown 导入、来源时间、引用位置、搜索与归档。
- 摘录级引用：从保存的原文中选取片段，保留引用快照；原文变化和模型新增的来源链接标记待核实。
- Markdown 写作、自动保存、修订比较、历史恢复与并发编辑冲突处理。
- 母稿派生为指定账号的平台版本，使用独立的内容与写作上下文。
- 自带 OpenAI Chat Completions 兼容模型：大纲、标题候选、开头备选、正文、平台改写，选中段落改写 / 扩写 / 缩写；后台任务、取消、手动重试、候选结果采用。
- 发布前字段检查：公众号依据草稿接口文档，头条与小红书为经验建议；只提示，不自动截断。
- 公众号风格 HTML 预览、富文本复制、图片附件；小红书文字卡片、分页、排序与图片导出；封面裁剪。
- 手动发布日历、冻结版本的发布包、平台链接和实际发布时间回填。
- 公众号 AppID / AppSecret 连接、权限与 IP 白名单检查；正文图片和封面上传、官方草稿保存、断线后的结果核对（真实账号待验收）。
- 统一任务中心：AI 生成、素材导入、卡片、裁剪、导出和平台草稿；显示执行阶段、历史尝试及失败恢复入口。
- 数据与图片备份、空实例恢复、深浅色主题及响应式页面。

此后实现的 v0.2 / v0.3 能力：

- 创作资源：写作预设（变量、适用步骤、参数说明）、多步骤工作流、栏目系列、视觉模板（颜色、字体、页脚、封面比例）、审校词典、对标观察。
- AI 辅助：样文风格提炼、按账号推荐选题、语言审校、事实辅助核对、候选版本比较、内容复盘、评论回复草稿；结果先作为候选，逐项采用，采用意见可形成偏好建议。
- 资料：RSS / Atom / JSON Feed 订阅、网页正文提取与历史文章批量导入、语义检索（向量服务不可用时回退关键词）。
- 图片与视频：AI 配图（参考图、单张重画）、音视频转写、视频脚本、配音合成短视频、长视频切片与发布包（可选 FFmpeg 媒体服务）。
- 发布：公众号正式发布与结果查询、浏览器执行节点（小红书、头条、知乎、百家号、B 站，Web 内扫码）、逐条选择的定时自动执行；结果不确定时先核对，不自动重发。
- 数据：手工 / CSV 指标、公众号指标同步、表现看板；合作与收益台账。
- 团队与开放：管理 / 编辑 / 只读成员与账号授权、站内通知、模型用量与费用、REST API（`/api/v1`、OpenAPI）、访问令牌、签名 Webhook、MCP。

公众号草稿成功不代表正式发文，正式发布也不是群发。日历默认只作计划，只有明确选择自动执行的计划才会到时执行。图文排版在平台内的最终效果、公众号真实权限、浏览器平台的真实页面和真实模型兼容性仍需用实际账号 / 服务验收；各项状态见 [开发进度](docs/progress.md)。

## 本地运行

需要 Node.js **22.12+（推荐 24）**，首次安装需要联网。

```sh
git clone https://github.com/Xwordsman/One-Creator.git
cd One-Creator
npm install
npm run dev
```

打开 **http://localhost:5173**，创建自己的工作台账号。默认使用 PGlite（嵌入式 PostgreSQL）和进程内 worker，数据保存在 `.data/local/`，不需要先安装数据库。

Windows PowerShell 若拦截 `npm.ps1`，使用 `npm.cmd install`、`npm.cmd run dev`。

在「设置 → 文本模型」填写自己的服务地址、模型 ID 和 API Key。未配置模型时，仍可手工编辑、排版、导出和记录发布。

公众号接入步骤见 [公众号草稿与结果核对](docs/wechat-drafts.md)：在账号的创作上下文中配置连接，建立带封面的发布计划，然后在日历列表点击「保存到公众号草稿」。

## Docker 自部署

在服务器上克隆仓库后，在仓库目录中执行：

```sh
node scripts/setup-docker.mjs
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

打开 **http://localhost:8080**。服务器部署先编辑 `deploy/.env`，将 `APP_ORIGIN` 设置为实际访问地址；使用 HTTPS 时设置 `COOKIE_SECURE=true`。

Compose 包含 Web/API、独立 worker、PostgreSQL 17，以及数据库 / 素材持久化卷。加密密钥与数据库密码由初始化脚本生成，不内置默认账号或密码。视频服务（`--profile media`）与浏览器执行节点（`--profile executor`，也可在自己电脑上用 `npm run executor` 运行）为可选项。

部署、升级、备份恢复和已验证环境详见 [部署说明](docs/deployment.md)。当前开发环境没有 Docker，容器构建与真实 PostgreSQL 启动尚待验证。

## 开发与验证

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

端到端测试会启动独立数据库、本地模拟模型和公众号接口，不使用 `.data/local`、真实模型密钥或真实平台账号；浏览器执行节点的测试只驱动本地模拟页面。测试验证的是操作链路与适配协议，不代表已通过真实账号验收。

更多命令、目录约定和接口入口见 [开发指南](docs/development.md)。

## 目录

```text
apps/
  web/            React 工作台
  api/            Fastify API、登录、业务路由、开放接口与 MCP
  worker/         独立任务执行入口（AI、自动化、调度、Webhook）
  media-service/  可选 FFmpeg 媒体服务
  executor/       可选浏览器执行节点
packages/
  core/       领域类型、输入校验、平台描述
  server/     数据库、版本、模型接入、任务、文件、备份
  rendering/  Markdown 排版与卡片分页
deploy/       Dockerfile、Compose
scripts/      构建、配置初始化、隔离预览
tests/        API / 领域验证、浏览器端到端场景
docs/         需求、方案、验收、进度和决策
```

## 技术与许可

TypeScript、React、Vite、Tailwind CSS、Radix UI、Fastify、PostgreSQL / PGlite。使用 npm workspaces 管理代码，基础部署无需 Redis、向量数据库或 GPU。

[MIT License](LICENSE)。第三方依赖、图标及资源沿用各自许可证。
