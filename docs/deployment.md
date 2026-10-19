# 部署、数据与恢复

> 当前对应 `0.1.0-alpha.1` 及之后实现的 v0.2 / v0.3 功能。本机已采用 Node.js + PGlite 验证；Docker、外部 PostgreSQL 与可选的媒体 / 执行节点镜像配置已提供，尚待在具备 Docker 的环境执行验收。

## 1. 本地开发

```sh
npm install
npm run dev
```

- Web：`http://localhost:5173`。
- API：`http://127.0.0.1:3001`，Web 开发服务器代理 `/api`。
- 数据：默认 `.data/local/postgres/`（嵌入式 PostgreSQL）与 `.data/local/assets/`。
- 首次运行在 `.data/local/encryption.key` 生成密钥；以后启动继续使用它。
- PGlite 只由一个应用进程访问，worker 在同进程执行。不能启动第二个进程读写同一嵌入式数据库。

可以参考根目录 `.env.example` 配置 `.env`。运行生产构建预览时，请设置与访问端口对应的 `APP_ORIGIN`：

```sh
npm run build
# 将 .env 中 APP_ORIGIN 改成 http://localhost:3001
npm start
```

如果端口被占用，启动会明确失败；请修改对应配置，不同时运行占用同一 API 端口的开发与构建预览进程。

## 2. Docker 配置

### 2.1 生成实例配置

```sh
node scripts/setup-docker.mjs
```

脚本以独占创建方式写入 `deploy/.env`，不会覆盖已存在的密钥。

如果宿主机只有 Docker、没有 Node.js，可以在项目根目录执行：

```sh
docker run --rm -v "${PWD}:/work" -w /work node:24-bookworm-slim node scripts/setup-docker.mjs
```

配置变量：

| 变量 | 含义 |
| --- | --- |
| `HOST_PORT` | 宿主机映射端口，默认 8080 |
| `APP_ORIGIN` | 浏览器实际访问来源，例如 `https://creator.example.com`，不带路径和结尾 `/` |
| `POSTGRES_PASSWORD` | 初始化生成的 PostgreSQL 密码 |
| `ENCRYPTION_KEY` | 64 位十六进制密钥，用于加密模型凭据；恢复时需要保留 |
| `COOKIE_SECURE` | HTTPS 部署设置为 `true`；本地 HTTP 使用 `false` |
| `INTEGRATION_ALLOWED_ORIGINS` | 可选。订阅、网页导入与 Webhook 默认只访问公网地址；自建的内网服务以逗号分隔的来源加入此处 |
| `MEDIA_SERVICE_TOKEN` | 可选媒体服务的访问令牌（至少 20 字符），初始化脚本已生成 |
| `EXECUTOR_TOKEN` | 可选执行节点的令牌，在「成员与集成 → 执行节点」注册后填写 |

服务器环境务必把 `APP_ORIGIN` 改成实际域名或主机地址。浏览器来源不一致时写入会被拒绝，而不是降级接受任意来源。

模型、图片、向量、转写、语音与媒体服务的地址由管理员在「设置」中填写，可以指向内网；它们不受 `INTEGRATION_ALLOWED_ORIGINS` 限制，只有管理员能修改。

### 2.2 启动

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

默认入口 `http://localhost:8080`。首次进入创建自己的工作台账号。

| 服务 | 职责 | 持久化 |
| --- | --- | --- |
| `app` | 静态 Web、业务 API、初始化与登录 | `creator-data` 素材卷 |
| `worker` | AI 与自动化任务、平台草稿 / 发布、定时调度、订阅刷新、Webhook 投递 | 同一 PostgreSQL 与素材卷 |
| `postgres` | 业务数据、修订、任务、会话 | `postgres-data` |
| `media`（可选） | FFmpeg 视频合成、字幕与切片 | `media-data` |
| `executor`（可选） | 浏览器执行节点，保存加密的平台登录会话 | `executor-data` |

数据库不映射到宿主机公网端口。应用以非 root 用户运行。`/api/health` 查询数据库后报告服务状态。

### 2.3 可选服务

视频合成与切片：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile media up -d --build
```

然后在「设置 → 图片、向量与媒体服务 → 视频服务」填写地址 `http://media:4100/v1`、模型 `ffmpeg`、API Key 为 `deploy/.env` 中的 `MEDIA_SERVICE_TOKEN`，再点击“测试已保存服务”。媒体镜像包含 FFmpeg 和 Noto 中文字体，基础镜像不包含。

浏览器执行节点（小红书、头条、知乎、百家号、B 站）：

1. 在「成员与集成 → 执行节点」注册节点，授权账号与平台，保存只显示一次的令牌。
2. 推荐在自己的电脑上运行：设置 `EXECUTOR_SERVER`（本实例地址）和 `EXECUTOR_TOKEN`，执行 `npm run executor`。也可把令牌写入 `deploy/.env` 后启动 `--profile executor`。
3. 在账号的创作上下文中选择节点并扫码登录；节点会在 Web 中显示登录画面。首次发布后请对照截图确认，平台改版可能需要校准选择器。

节点会话保存在节点数据目录并加密；复制或备份该目录等同于复制登录状态，请按密码管理。

### 2.4 查看日志与停止

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail 100 app worker
docker compose --env-file deploy/.env -f deploy/compose.yaml stop
docker compose --env-file deploy/.env -f deploy/compose.yaml start
```

`down` 保留命名卷；`down -v` 会删除数据卷，不作为常规停止命令。

### 2.5 HTTPS 反向代理

将实际域名代理到 `app:3001` 或宿主机映射端口；反向代理需允许单张图片 12 MB、音视频 128 MB 和正常下载超时。当前 API 使用 Cookie 会话和同源客户端头，不要求公开数据库或开放跨域。

## 3. 备份

### 网页备份

在「设置 → 数据备份」下载当前工作空间备份，包含：

- 账号、人设及历史修订。
- 灵感、素材、图片、文稿及历史版本。
- 模型配置的密文、任务与发布记录。

不包含会话 Cookie，也不包含加密密钥本身。需要另行保管 `ENCRYPTION_KEY` 或 `.data/local/encryption.key`。

当前 ZIP 导出支持合计不超过 150 MB 的素材；导出在内存完成。更大规模的实例应使用 PostgreSQL 备份和对应的文件卷快照，不能认为该 ZIP 接口适用于任意数据量。

### 命令行备份

开发实例先停止应用，再运行：

```sh
npm run backup -- export backups-2026-10-16.zip
```

Docker 实例可以导出到素材卷后复制出来：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec app node apps/api/dist/backup.mjs export /data/backup.zip
docker compose --env-file deploy/.env -f deploy/compose.yaml cp app:/data/backup.zip ./backup.zip
```

导出文件存在时命令拒绝覆盖。数据库内容在一致性快照中读取；资源对象是不可变文件。

备份记录数据库结构版本：来自更新程序的备份会被拒绝；较早的备份恢复后，新增字段使用默认值。

## 4. 恢复到空实例

恢复不会覆盖已经初始化的工作空间。使用相同的加密密钥，并确认目标数据库为空。

开发实例：

1. 停止应用，选择新的 `DATA_DIR`。
2. 在环境变量中配置原 `ENCRYPTION_KEY`，或将原 `encryption.key` 放到新数据目录。
3. 执行以下命令，再启动应用。

```sh
npm run backup -- restore backup.zip
```

Docker 新实例：配置原密钥，使用空的新项目卷，先启动 PostgreSQL。再运行一次恢复容器：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --build -v "${PWD}/backup.zip:/restore/backup.zip:ro" app node apps/api/dist/backup.mjs restore /restore/backup.zip
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d app worker
```

恢复会验证备份格式、密钥指纹、图片散列与大小。未完成的 AI、导入、图片处理恢复为失败待处理；可能已向平台写入的草稿或发布保持待核对，避免自动重放；已过时间的自动执行计划转为待处理，不会自行补发。平台临时令牌清空，连接需要重新检查。

出于安全考虑，恢复后：API 令牌全部撤销，Webhook 订阅停用，执行节点令牌作废（在执行节点页轮换后重新配置节点），浏览器登录标记为失效。原工作台账号仍有效，需要重新登录。

## 5. 升级与回退

- 升级前保留数据备份、文件、实例配置与当前代码版本。
- 已应用迁移的校验和不可更改；模型变化通过后续迁移处理。
- 更新代码后重建镜像，检查健康状态和核心页面。
- 启动时按顺序执行未应用的迁移（当前共 6 个），数据库结构版本新于程序时拒绝启动。旧结构升级已在 PGlite 上测试；PostgreSQL 容器的升级与回退尚未演练，不能据此宣称已验证完整升级回滚。
- 回退时使用对应版本代码和它的备份数据恢复；不能把旧代码直接连到任意更新后的数据库。

## 6. 当前验证边界

| 环境 / 能力 | 状态 |
| --- | --- |
| Windows、Node.js 24、本地 PGlite | 已执行 API、落盘重启、旧结构升级、命令行备份恢复演练、构建与性能基线 |
| 浏览器操作链路 | Playwright（Chrome）端到端场景通过，覆盖 1440 px 与 375 px，结果见进度表 |
| Compose / Linux 容器 / 外部 PostgreSQL | 配置已提供，当前机器无 Docker 命令，待验证 |
| 真实文本模型供应商 | 按用户实际密钥测试；自动测试使用本地 HTTP 模拟模型 |
| 公众号后台粘贴、官方草稿、正式发布与数据 | 通道、上传、重试、断线核对、发布查询与统计已通过模拟服务测试；待实际账号验收，见 [接入说明](wechat-drafts.md) |
| 浏览器执行节点 | 真实执行器进程与真实 Chromium 在本地模拟页面通过；真实平台后台与 `executor` 镜像未测 |
| 媒体服务 | 本机用 ffmpeg-static 真实合成与切片通过；`media` 镜像（系统 FFmpeg + 中文字体）未构建 |
| 图片 / 向量 / 转写 / 语音服务 | 协议用本地模拟服务验证；真实服务商待配置自己的密钥后测试 |
