# 开发指南

> 对应首个实现切片 `0.1.0-alpha.1`。

## 1. 工程选择

- npm workspaces 单仓库，前后端 TypeScript。
- 前端 React 19、Vite 8、Tailwind CSS 4；Radix Dialog、TanStack Query、React Router。
- 后端 Fastify 5，Zod 校验输入；共享类型位于 `packages/core`。
- PostgreSQL 为生产数据库；PGlite 用于无需安装数据库的本地开发与隔离验证，使用同一 SQL 结构。
- 任务状态保存在数据库；开发模式内联 worker，生产模式独立 worker。
- Markdown 为可编辑源稿，公众号样式 HTML 与卡片图片为派生输出。

选择依据与先前提议的调整见 [决策记录](decisions.md)。

## 2. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `apps/web/src/pages` | 工作台、账号、人设、灵感、素材、编辑器、日历、任务与设置 |
| `apps/web/src/components` | 基础交互、布局、卡片工具、封面裁剪 |
| `apps/web/src/lib` | API 调用、查询、串行自动保存与并发编辑保护 |
| `apps/api/src` | HTTP 入口、会话及分领域路由 |
| `apps/worker/src` | 独立后台执行入口（AI、自动化、发布队列、调度、订阅、Webhook） |
| `apps/media-service/src` | 可选 FFmpeg 媒体服务：`/v1/jobs` 合成 / 切片、按请求编号去重、产物下载 |
| `apps/executor/src` | 可选浏览器执行节点：轮询领取、心跳、截图、远程登录指令、加密会话、结果回报 |
| `packages/core/src` | 公共类型、输入 schema、平台描述与基础检查；`studio.ts` 为创作资源与自动化任务 schema，`browser.ts` 为浏览器平台默认地址与选择器 |
| `packages/server/src` | SQL、版本保存、模型调用、任务、加密、资源与备份 |
| `packages/server/src/automation*.ts` | 通用自动化任务：创建（幂等、检查点续接）、执行器、AI 处理、采用流程 |
| `packages/server/src/publication-guard.ts`、`scheduler.ts`、`execution-leases.ts` | 发布前规则、定时派发与查询、账号执行租约 |
| `packages/server/src/nodes.ts`、`official-publishing.ts` | 执行节点协议、浏览器连接与能力；公众号正式发布与统计 |
| `packages/server/src/platforms` | 平台适配器契约、公众号官方接口、能力声明 |
| `packages/rendering/src` | Markdown 渲染、HTML 导出、卡片换行分页 |
| `tests` | API/数据边界测试与渲染测试 |
| `tests/e2e` | 实际浏览器端到端场景 |

## 3. 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动 API 与 Web 开发服务器 |
| `npm run check` | TypeScript 严格类型检查 |
| `npm test` | API、数据一致性和领域测试 |
| `npm run build` | 构建 Web、API、worker 和备份入口 |
| `npm start` | 启动已构建应用，默认 3001 端口 |
| `npm run worker` | 独立 worker；需要 PostgreSQL `DATABASE_URL` |
| `npm run media` | 本地启动媒体服务（默认 4100，需要 `MEDIA_SERVICE_TOKEN`），开发时使用 ffmpeg-static |
| `npm run executor` | 启动浏览器执行节点（需要 `EXECUTOR_SERVER`、`EXECUTOR_TOKEN`；`BROWSER_HEADLESS=false` 显示浏览器） |
| `npm run test:e2e` | 使用隔离的 4273（应用）/4274（模型与转写）/4275（公众号）/4276（真实 FFmpeg 媒体服务）验证浏览器流程 |
| `npm run format`、`npm run format:check` | Prettier 格式化 / 检查代码 |
| `npm run benchmark` | 在隔离的嵌入式实例写入示例数据，记录常用请求耗时与内存 |
| `node --import tsx scripts/preview.ts` | 4173 隔离预览、4174 模拟模型与转写、4175 模拟公众号、4176 媒体服务（令牌 `preview-media-service-token`）；重启清空预览数据 |
| `npm run setup:docker` | 创建 Docker 实例配置 |
| `npm run backup -- export <path>` | 导出备份；嵌入式数据库需先停止应用 |

首次运行浏览器测试前执行 `npx playwright install chromium`。也可设置 `E2E_CHANNEL=chrome` 使用本机 Chrome。

每次端到端测试创建独立数据目录。模拟模型在测试脚本中明确返回固定结果，用于核对协议、任务和版本流程，不是生产 AI 功能的替代实现。

推送到 GitHub 后，Actions 按 `.github/workflows/ci.yml` 在 Ubuntu / Node.js 24 上并行运行两组任务：类型检查、格式检查、单元测试与构建；安装 Chromium 后运行浏览器端到端流程。失败时保留 Playwright 报告与截图，可在仓库的 Actions 页面下载。

## 4. 当前 HTTP 入口

`/api/v1/*` 与 `/api/*` 等价；对外集成使用 `/api/v1` 与 Bearer 访问令牌，`GET /api/v1/openapi.json` 为接口文档，`POST /api/mcp` 为 MCP（JSON-RPC）。下表为工作台主要入口。

| 入口 | 作用 |
| --- | --- |
| `GET /api/health` | 数据库健康检查 |
| `GET /api/auth/bootstrap` | 初始化状态与当前会话 |
| `POST /api/auth/setup` | 仅允许一次的工作台初始化 |
| `POST /api/auth/login`、`logout` | Cookie 登录 / 退出 |
| `/api/accounts`、`/api/personas` | 建档、编辑、按平台 / 分类筛选（`/api/accounts/categories`）；人设修订、账号上下文与能力声明 |
| `/api/accounts/:id/connection`、`connection/check` | 公众号凭据保存、隔离加密、检查与断开；需要配置修订号 |
| `/api/ideas`、`/api/materials`、`/api/assets` | 灵感（可关联素材）、素材与引用位置、图片上传（重复文件返回 200 与 `duplicate`）与鉴权读取 |
| `/api/documents` | 母稿与平台版本、编辑、修订恢复、字段校验（含规则核对日期）、发布包导出 |
| `/api/jobs` | AI / 公众号后台任务、阶段、取消、重试、结果；编辑器使用 `type=ai` 筛选 |
| `/api/tasks`、`/api/activities` | 统一任务列表；浏览器导入 / 图片处理的进度与心跳，服务端导出记录 |
| `/api/publishing` | 冻结版本、排期、人工回填、快照导出；`wechat-draft`、`verify-draft`、`confirm-no-draft` 处理官方草稿 |
| `/api/settings/model`、`model/test` | 模型配置和连通性测试 |
| `/api/settings/backup` | 当前空间备份 |
| `/api/dashboard` | 当前空间真实数量与近期内容 |
| `/api/settings/providers/:capability` | 图片、向量、转写、语音、视频服务配置与测试 |
| `/api/studio/items`、`/api/studio/catalog` | 创作资源（预设、工作流、系列、视觉模板、词典、评论、合作、转写、视频脚本等）及其 JSON Schema |
| `/api/automation`、`/api/automation/catalog` | 自动化任务创建 / 查询 / 重试 / 取消 / 采用（`/:id/apply`）；视频发布包导出 |
| `/api/feeds`、`/api/feed-entries`、`/api/materials/search` | 订阅与刷新、订阅内容、语义 / 关键词检索 |
| `/api/metrics`、`/api/analytics` | 指标快照、CSV 导入导出、看板汇总 |
| `/api/members`、`/api/tokens`、`/api/webhooks`、`/api/usage`、`/api/model-prices`、`/api/notifications` | 成员、访问令牌、Webhook、用量与价格、站内通知 |
| `/api/nodes`、`/api/accounts/:id/browser-connection`、`browser-login` | 执行节点注册 / 轮换 / 撤销，浏览器连接与扫码登录 |
| `/api/executor/*` | 执行节点协议：`poll`、`jobs/:id/heartbeat`、`screenshot`、`commands`、`assets/:assetId`、`result`；使用节点令牌与实例 ID |
| `/api/publishing/:id/confirm-not-published` | 作者确认平台上没有发布后，允许重新提交 |

- 写入请求需要 `X-Creator-Client: web`，浏览器 Origin 应与 `APP_ORIGIN` 一致。
- 凭据在服务器保存，普通响应不返回明文或完整加密字段。
- 编辑文稿 / 人设 / 素材使用 `expectedRevision`。
- AI 与发布计划创建使用 `Idempotency-Key`，重投相同意图保留同一个键。
- 列表使用 `limit`、`offset`，筛选同时作用于列表与数量。
- 业务数据查询始终带工作空间范围；相关资源 ID 也需要验证归属。

## 5. 对后续代码的约束

### 内容与引用

修订不可变；恢复历史建立新修订。派生版本指向母稿的明确版本。引用保存当时的素材内容与修订，不依赖外部链接永远可用。

`excerpts` 关联具体素材与原文片段，引用快照记录是否还能在原文中找到。模型优先接收可验证的摘录；新增的未知来源 URL 在结果和任务中标记待核实。这是出处辅助检查，不是全文事实核验。

### 生成任务

模型输出保存为候选，不直接覆盖当前人工稿。采用结果时再次核对输入修订。失败、取消和租约过期的任务不自动重放，用户可创建新的尝试。

后台 `jobs` 与浏览器 / 导出 `activities` 通过 `/api/tasks` 统一投影，均有类型、阶段、开始 / 结束时间和尝试关联。浏览器操作每 30 秒续期，页面离开超过 3 分钟后记为中断；回到原页面重做，而不是在服务端冒充继续执行本地 Canvas 或 FileReader。

### 发布

已接入公众号官方草稿通道；快照与正文编辑独立。计划状态区分 `submitting`、`draft_saved`、`verification_required` 和用户回填的 `published`，提交尝试时间与实际发布时间单独记录。完整流程见 [公众号草稿说明](wechat-drafts.md)。

所有平台写入前先持久化租约、阶段与精确请求快照；不确定结果只可查询认领或由用户明确核对后重试。令牌明确过期时可刷新一次，网络中断不得直接重发 `draft/add`。各次尝试只复用相同连接修订下的上传检查点。

正式发布与浏览器发布遵守同样规则：`publication-guard.ts` 统一检查（同一计划同时只有一个平台任务、待核对时只允许查询）；平台写入通过账号执行租约串行；进入 `publishing` 阶段之后的中断一律进入待核对。浏览器选择器写在 `packages/core/src/browser.ts`，平台改版时在这里或账号连接的覆盖项中调整，并用一条真实发布核验后再视为可用（`DEC-12`）。

### 数据库

SQL 迁移在 `packages/server/src/migrations.ts` 的 `migrations` 数组中按顺序执行，序号即结构版本。启动时应用未执行的迁移，并校验已执行迁移的 checksum；数据库版本新于程序时拒绝启动，备份同样记录结构版本。正式发布过的迁移不可改写：新增结构追加新迁移，并在 `tests/api.test.ts` 补充旧结构升级测试。

### 文档进度

开发前认领需求 ID。完成后写实现位置、验证结果和限制，再标 `DONE`。范围只有部分实现时保留 `DOING`；已实现但缺真实环境验收时使用 `VERIFY`。

## 6. UI 约定

- 界面使用中文，主色为森林绿，纸张式中性色承载正文；深浅主题通过 CSS 变量映射。
- 图标统一 Lucide；装饰纸张由 CSS 和 SVG 生成，无外部图片 / 字体网络依赖。
- 真实数据为空时展示空态，测试数据只出现在隔离预览 / 测试目录。
- 表单有明确标签、错误提示、加载反馈；长文修改支持自动保存、冲突比较和离开页面保护。
- 每个主要页面有 URL；375px 窄屏下保留可操作导航；遵循 `prefers-reduced-motion`。

具体 CSS 位于 `apps/web/src/styles.css`，共享表单位于 `components/ui.tsx`。
