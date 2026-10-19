# 开源项目调研与能力对比

> 整理日期：2026-10-16。基础资料来自前序会话的分方向调研；本次补充复核了部分关键仓库与微信官方文档。
> 下表记录来源中的功能描述，不等同于本地部署或真实账号验收。

## 1. 调研口径

- **本次复核**：2026-10-16 重新读取了对应仓库主页、README 或条款页面；各条目注明具体范围。
- **前序记录**：来自前序调研，保留仓库链接供接入前复核。
- **未确认**：没有充分证据，不能据此承诺能力。
- 仓库主页描述、公开源码、商店版、商业版可能不同，必须按准备使用的版本判断。
- Star 和提交次数变化较快，本基线不将其用作成熟度或选型结论。
- 所有候选组件尚未在 One-Creator 中集成；采用前需锁定版本或提交、检查许可和实际接口。

## 2. 整体观察

目前已经有接近全链路工作台的项目，例如 AiToEarn 和 Easel；海外有成熟的自托管排期产品 Postiz。不能据此认定“完全没有同类产品”。

One-Creator 值得验证的组合是：**个人使用体验、多账号独立风格、国内图文适配、可自部署、可追溯的内容与发布记录**。这是产品取舍，并非已证明的市场空白。

现有形态主要有四种：

| 形态 | 样例 | 为什么采用这种形态 | 对本项目的启发 |
| --- | --- | --- | --- |
| Web + 自托管 | AiToEarn、Postiz、RedInk | 统一数据、任务和浏览器访问入口 | 作为当前主体方向 |
| 本地 Web / 桌面工作台 | Easel、Beav、AIWriteX | 易于使用本地文件、浏览器会话和媒体工具 | 媒体与浏览器能力可作为独立执行模块 |
| 浏览器扩展 | Wechatsync、MultiPost | 复用用户已登录的浏览器环境 | 参考平台适配方式；核心体验不依赖扩展 |
| CLI / MCP / API 服务 | social-auto-upload、xiaohongshu-mcp、文颜系列 | 易于接入脚本或 Agent | 作为可替换的能力组件 |

Docker 解决的是部署方式；是否能自动发布，仍取决于平台接口、账号权限、登录会话和执行环境。

## 3. 全链路与内容管理产品

| 编号 / 项目 | 形态与技术线索 | 功能与特色 | 与 One-Creator 的关系 | 许可及证据 |
| --- | --- | --- | --- | --- |
| R-01 [AiToEarn](https://github.com/yikart/AiToEarn) | Web、Docker Compose、Electron、MCP；Next.js / NestJS | AI 图文与视频、批量草稿、日历、多平台发布、互动、变现市场；README 列出公众号和小红书等渠道 | 参考完整工作台与模型/平台配置；商业变现不作为首版中心 | MIT；本次复核主页。Relay 被推荐用于借助其开发者凭据授权，并非所有部署都必须走中转 |
| R-02 [Postiz](https://github.com/gitroomhq/postiz-app) | Web、Docker；Next.js / NestJS / PostgreSQL / Temporal | 排期、重复内容、团队、数据、AI、API、Webhook、MCP | 参考任务、日历和多账号内容组织；README 平台清单未列出本项目关注的国内平台 | AGPL-3.0；本次复核主页。自托管需配置各平台应用与相关权限 |
| R-03 [Easel](https://github.com/ZJU-REAL/Easel) | 本地 Web + CLI；FastAPI / React / OpenClaw | 发现→策划→创作→发布→复盘；账号画像、长期记忆、素材、图文与视频；列出七个平台发布能力 | 重点参考画像、内容项目、母稿与多平台版本；整体体验需实测 | Apache-2.0；本次复核主页。当前快速开始使用安装脚本，未见现成 Docker 指引 |
| R-04 [Beav](https://github.com/Jamailar/Beav) | 桌面 + 采集扩展；Tauri / Rust | 素材与评论采集、账号空间、运营规划、长期偏好、视觉模板、口播工具 | 参考素材资产和分层偏好；公开源码与发行版的功能边界待复核 | 前序记录为带非商业限制的许可，需读取选定版本原文 |
| R-05 [AIWriteX](https://github.com/iniwap/AIWriteX) | 桌面 / CLI；Python、CrewAI | 热点、公众号采集、AI 写作、文风调节、排版、配图、发布 | 参考公众号链路与分步创作交互 | 本次复核 [NOTICE](https://github.com/iniwap/AIWriteX/blob/main/NOTICE)：包含分发及对第三方提供服务的限制声明；不是单凭 Apache 标识就可按标准宽松许可处理 |
| R-06 [Mixpost](https://github.com/inovector/mixpost) | 自托管 Laravel 产品 | 账号管理、内容版本、媒体、日历、模板、变量、标签组；具体 Lite / Pro 边界待核实 | 参考模板与日历设计 | 前序记录：公开 Lite 仓库标 MIT；不能把商业版能力直接计入开源版 |

### 3.1 重点项目应如何进一步评估

- AiToEarn：单独核对每个国内渠道的授权与发布实现，验证不使用 Relay 时的部署链路。
- Postiz：试用从草稿到日历的操作，评估其可靠调度思路，不预设一定引入 Temporal。
- Easel：实际建立两个不同定位的账号画像，评估编辑、归档、恢复和跨平台适配体验。
- Beav / AIWriteX：保留产品交互观察；代码采用需先解决具体许可条件。

## 4. 发布与执行工具

| 编号 / 项目 | 形态 | 功能与特色 | 接入或借鉴重点 | 许可及证据 |
| --- | --- | --- | --- | --- |
| R-07 [Wechatsync](https://github.com/wechatsync/Wechatsync) | 浏览器扩展、CLI、MCP | 多平台图文同步、图片转存、正文提取；默认草稿；利用浏览器登录态调用平台 Web 接口 | 内容适配器、图片映射、草稿结果；不作为主体形态 | 前序记录：GPL-3.0 |
| R-08 [MultiPost](https://github.com/leaperone/MultiPost-Extension) | 浏览器扩展及对外调用接口 | 文章、图文、视频分发；公众号、头条等适配目录较多 | 不同内容类型的发布字段；确认公开源码与商店版差异 | 前序记录：公开部分 Apache-2.0，部分 Agent 模块未公开 |
| R-09 [social-auto-upload](https://github.com/dreammis/social-auto-upload) | Python CLI / Skill | 多平台视频上传、部分图文、账号登录态、定时参数 | 适配器实现与媒体上传；历史 Web 版不代表当前推荐部署方式 | 前序记录：MIT；当前主线与旧版差异需复核 |
| R-10 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Docker / 二进制 / HTTP MCP；Go | 二维码登录、登录状态、图文/视频发布、定时参数、搜索、详情、评论 | 验证“容器浏览器 + Web 展示二维码”的路径；多账号需要额外隔离和调度 | Apache-2.0；本次复核主页及工具清单。README 明确有提交成功但页面未显示的排查场景 |
| R-11 [media-publisher](https://github.com/walter201230/media-publisher) | Python CLI | Markdown 输入、平台适配、无配图时生成卡片、上传器分层 | 参考统一内容输入与分平台转换 | 前序记录：未确认许可证，不作为已获许可的依赖 |
| R-12 [humanized-social-publisher](https://github.com/lincwang123-bot/humanized-social-publisher) | Python CLI / 本地面板 | 每账号独立浏览器目录、身份核对、队列、内容指纹、发布记录 | 参考防发错账号、重复任务识别和人工完成记录 | 前序记录：MIT，实际稳定性待验证 |
| R-13 [Prism](https://github.com/Laihiujin/Prism) | Web / 桌面 / CLI；FastAPI、Celery、Redis | 多账号、账号锁、异步发布看板、部分数据回收 | 参考同账号串行、不同账号并行的执行模型 | 前序记录：Apache-2.0；具体部署和平台范围待复核 |

### 4.1 发布方式对比

| 方式 | 适合的情况 | 工程约束 | 本项目位置 |
| --- | --- | --- | --- |
| 官方 API | 平台和实际账号具备相应权限 | 凭据、授权范围、额度、异步结果查询 | 优先评估，草稿与发布分别声明能力 |
| 容器浏览器执行 | 需通过创作者后台操作的渠道 | 会话持久化、扫码、验证码、页面变化、任务恢复 | 可选 browser worker，需逐平台实测 |
| 独立本地执行节点 | 登录需要本地交互或服务器执行不适用 | 节点在线状态、任务领取、账号绑定 | 后续候选，不要求浏览器扩展 |
| 浏览器扩展 | 复用常用浏览器会话 | 依赖浏览器在线，扩展权限与多 Profile 管理 | 调研参照，不是首版依赖 |
| 成品导出 + 手工回填 | 通道不存在、权限不足或用户想自行发布 | 不能自动确认平台结果 | 所有首批平台的基础交付路径 |

## 5. 写作、排版与图片工具

| 编号 / 项目 | 形态 / 核心功能 | 特色与借鉴 | 许可及证据 |
| --- | --- | --- | --- |
| R-14 [doocs/md](https://github.com/doocs/md) | Web / Docker；公众号 Markdown 排版、主题、图床、AI 助手 | 微信排版兼容、复制富文本、图片处理 | 前序记录：WTFPL；候选渲染组件，依赖与资源另核 |
| R-15 [wenyan-core](https://github.com/caol64/wenyan-core)、[wenyan-mcp](https://github.com/caol64/wenyan-mcp) | npm 核心库、MCP、CLI；Markdown 转 HTML、主题、公众号草稿 | 更适合评估按库接入，不必嵌入整个编辑器 | 前序记录：Apache-2.0；具体包 API、服务端能力需验证 |
| R-16 [RedInk](https://github.com/HisMax/RedInk) | Web / Docker；大纲→封面→多页图文→单页重绘 | 页面大纲可编辑、封面定调、单张重生成 | 本次复核 [LICENSE](https://github.com/HisMax/RedInk/blob/main/LICENSE)：CC BY-NC-SA 4.0，并有另行商业授权入口；功能来自前序调研 |
| R-17 [markdown-to-image](https://github.com/gcui-art/markdown-to-image) | React 组件 / 示例编辑器 | Markdown 卡片和海报导出 | 前序记录：Apache-2.0；是否采用取决于前端选型 |
| R-18 [XHS-TextCard](https://github.com/geekfoxcharlie/XHS-TextCard) | 浏览器 Canvas 卡片生成 | 模板、分页、纯前端导出 | 前序记录：MIT；候选分页与渲染实现 |
| R-19 [baoyu-skills](https://github.com/JimLiu/baoyu-skills) | 创作技能集合 | 卡片风格 × 信息布局、封面、信息图、文章插图 | 前序记录：MIT；可评估提示词与模板，执行脚本逐项判断依赖 |

## 6. 热点、素材与语言辅助

| 编号 / 项目 | 功能与特色 | 对应价值 | 许可及证据 |
| --- | --- | --- | --- |
| R-20 [newsnow](https://github.com/newsnext/newsnow) | 多源热榜、缓存、阅读入口 | 热点数据源和展示组织 | 前序记录：MIT；原仓库地址有迁移，维护状态需复核 |
| R-21 [DailyHotApi](https://github.com/imsyy/DailyHotApi) | 热榜 JSON / RSS、缓存、Docker | 可作为热点服务候选 | 前序记录：MIT；每个数据源独立验证可用性 |
| R-22 [TrendRadar](https://github.com/sansan0/TrendRadar) | 热榜和 RSS、关键词规则、增量推送、AI 简报 | 关键词订阅、每日选题简报 | 前序记录：GPL-3.0 |
| R-23 [wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter) | 公众号文章导出、格式与图片保留、筛选 | 历史内容和参考素材导入 | 前序记录：MIT；登录和部分数据字段依赖实际平台会话 |
| R-24 [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 多平台内容与评论采集 | 用于了解素材采集场景和字段 | 前序记录为非商业学习许可；接入范围及原文待复核 |
| R-25 [Humanizer-zh](https://github.com/op7418/Humanizer-zh) | 中文语言习惯检查与改写规则 | 可解释的语言修改建议 | 前序记录：MIT；不把它当作者身份识别器或过检测保证 |
| R-26 [writing-dna-skill](https://github.com/larashero3-dotcom/writing-dna-skill) | 从样文提炼语言、结构、视角与视觉偏好 | 可编辑、可版本化的账号风格档案 | 前序记录：MIT；样文数量建议不转成产品硬性门槛 |
| R-27 [ai-trend-publish](https://github.com/liyown/ai-trend-publish) | 热点清洗、去重、证据补全、创作计划、微信草稿 | 选题反馈与分步任务记录 | 前序记录：MIT |
| R-28 [AI-Media2Doc](https://github.com/hanshuaikang/AI-Media2Doc) | 音视频转笔记、图文等 | 视频转写进入内容素材库 | 前序记录：MIT，具体接口与运行方式待确认 |
| R-29 [pycorrector](https://github.com/shibing624/pycorrector) | 中文纠错工具包，提供多种模型路径 | 语言辅助的可选组件 | 前序记录：Apache-2.0；模型权重许可及资源需求需分别判断 |

## 7. 视频扩展候选

| 编号 / 项目 | 形态与功能 | 接入思路 | 许可及证据 |
| --- | --- | --- | --- |
| R-30 [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | WebUI / API / Docker；脚本、素材、配音、字幕、合成 | 独立任务服务，生成结果回到素材库 | 前序记录：MIT；需验证选定版本 API 与外部素材服务 |
| R-31 [AutoClip](https://github.com/zhouxiaoka/autoclip) | Web / 桌面 / Docker；长视频高光切片、封面、发布包 | 切片任务与产物清单集成 | 前序记录：MIT；同名项目较多，以此仓库为候选 |
| R-32 [NarratoAI](https://github.com/linyqh/NarratoAI) | Streamlit；解说、混剪、配音、剪映草稿 | 先评估是否有稳定任务 API | 前序记录：MIT；任务接口未确认 |
| R-33 [Pixelle-Video](https://github.com/ATH-MaaS/Pixelle-Video) | WebUI / Docker；AI 图片或视频、配音、模板化合成 | 独立媒体 worker，依赖按配置启用 | 前序记录：Apache-2.0；仓库有迁移 |
| R-34 [FunClip](https://github.com/modelscope/FunClip) | Gradio / CLI；中文转写、说话人、按文本裁剪 | 转写和精剪能力组件 | 前序记录：代码 MIT，模型和媒体资源分别核验 |

## 8. 首批平台官方能力记录

### 8.1 微信公众号

本次直接读取：

- [发布能力说明](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html)
- [新增草稿接口](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add)

已确认的文档事实：

1. `draft/add` 和 `freepublish/*` 是不同能力；草稿保存不等于发布。
2. 发布能力页面写明：**2025 年 7 月起，个人主体账号、企业主体未认证账号及不支持认证的账号被回收所列发布接口的调用权限**。
3. 新增草稿页将公众号、服务号列为适用类型，并说明支持第三方平台代调用；这不足以替代具体账号的权限验证。
4. 草稿正文图片需要使用指定上传接口产生的 URL，图文封面需要永久素材 ID。

待验证：实际账号能否取得凭据、IP 白名单配置、上传素材、写入草稿、读取草稿；发布能力另外验证。当前公众号和服务号文档已拆分，不能把一个产品的权限表直接套用到另一个。

前序资料还记录了 [服务端 API 调用说明](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/) 中的 IP 白名单要求。工程上应以“请求出口满足当前接口规则”描述，不把“拥有固定 IP”误写成接口本身唯一允许的部署形态。

### 8.2 小红书

前序调研未找到面向普通个人创作者、普遍可申请的服务端笔记发布 API。以下入口属于不同业务，不应混用：

- [电商开放平台](https://open.xiaohongshu.com/)：商品、订单等商业接口。
- [分享开放平台](https://agora.xiaohongshu.com/doc)：客户端分享流程，接入状态需复核。
- [聚光](https://ad.xiaohongshu.com/)：广告投放相关能力。

社区 xiaohongshu-mcp 提供浏览器执行方案；“社区可自动操作”不代表“个人账号已有官方 API”。本项目按浏览器候选通道实测，不能承诺任意账号和服务器环境都能工作。

### 8.3 今日头条

前序调研未确认可普遍使用的头条文章、微头条服务端发布 API。[抖音开放平台的头条视频方案](https://open.douyin.com/platform/resource/docs/ability/content-management/toutiao-publish-solution)不能据此推导出图文发布能力。

本项目首阶段支持内容适配和导出，后续单独验证创作者后台的图文发布路径。

### 8.4 后续平台线索

| 平台 | 前序调研结论 | 官方入口 / 接入前待核内容 |
| --- | --- | --- |
| 抖音 | 有内容发布能力，需申请应用权限和用户授权 | [开放平台](https://open.douyin.com/)；开发者类型、内容类型、授权范围 |
| B 站 | 有投稿与文章相关能力，接入有资质要求 | [开放平台](https://open.bilibili.com/)；入驻主体、应用权限、用户授权 |
| 知乎 | 发现数据开放入口，通用写入能力未确认 | [开发者文档](https://developer.zhihu.com/docs) |
| 百家号 | 有开发者接口线索，当前门槛与可用性未确认 | [官方文档](https://baijiahao.baidu.com/docs/) |
| 微博 | 分享接口与历史发布接口需要区分 | [statuses/share](https://open.weibo.com/wiki/2/statuses/share) |
| 视频号 | 未确认短视频投稿的通用开放接口 | [视频号 API](https://developers.weixin.qq.com/doc/channels/api/channels/) |

“未找到 / 未确认”是调研结果，不等于证明接口不存在。

## 9. 从调研到需求的对应关系

| 产品能力 | 主要参考 | One-Creator 需求 |
| --- | --- | --- |
| 账号画像与分层偏好 | Easel、Beav、writing-dna-skill | `ACC-02`、`ACC-03`、`ACC-05`、`ACC-06` |
| 素材积累与出处 | Beav、wechat-article-exporter、ai-trend-publish | `MAT-01`～`MAT-06` |
| 可编辑的分步创作 | Easel、AIWriteX、ai-trend-publish | `CRE-01`～`CRE-07` |
| 微信排版 | doocs/md、文颜 | `FMT-01` |
| 卡片与配图 | RedInk、XHS-TextCard、baoyu-skills | `FMT-02`～`FMT-05` |
| 平台版本与排期 | Postiz、Mixpost、Wechatsync | `CRE-05`、`PUB-01`～`PUB-04` |
| 账号隔离、任务去重与结果核验 | humanized-social-publisher、Prism、xiaohongshu-mcp | `ACC-04`、`PUB-06`～`PUB-09` |
| 数据反馈创作 | Easel、Postiz | `DAT-01`～`DAT-04` |
| 独立视频能力 | MoneyPrinterTurbo、AutoClip、FunClip | `VID-01`～`VID-03` |

## 10. 复用方式与许可证记录

目前只形成候选清单，没有选定或复制任何第三方实现。

- MIT、Apache-2.0 等允许广泛复用，但仍需履行相应版权、许可、修改说明及适用的 NOTICE 保留义务。
- GPL / AGPL 也是允许商业使用的开源许可证。能否纳入项目，取决于项目最终许可证、修改与分发方式、作品关系及网络服务方式；不是一律不能使用。
- 单独放入容器或通过 HTTP 调用，不自动免除许可证义务。
- 非商业、限制分发或限制服务提供的条款，应与标准开源许可区分；不能只看 GitHub 标签作结论。
- 模型权重、字体、模板、图标、音乐和第三方 API 服务各有自己的条件，不能从代码许可证推导它们的许可。

选定依赖时，记录：仓库 / 包名、版本或提交、用途、接入方式、许可文件、资源依赖、验证结果。记录入口为 [决策与 POC](decisions.md)。
