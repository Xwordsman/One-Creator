# 公众号草稿与结果核对

> 更新：2026-10-17。官方接口通道已经实现，并通过本地 HTTP 模拟服务验证；真实账号的权限、图片处理与后台排版仍待验收。

## 1. 连接自己的公众号

1. 在「账号与人设」添加微信公众号档案。
2. 打开账号卡片的「创作上下文」，在「公众号官方接口」中填写 AppID 和 AppSecret。
3. 在公众号后台开发配置中，把运行 One-Creator 的服务器**出口 IP**加入白名单。
4. 点击「保存并检查连接」。程序获取服务端访问令牌并查询草稿数量，显示检查结果与时间。

连接状态包括：未配置、待检查、已连接、凭据失效、权限不足、IP 白名单限制、连接不可用。连接成功表示令牌与草稿读取检查通过；保存草稿还取决于实际账号权限、图片和内容，失败信息会保留在任务中。

AppSecret 与临时令牌采用账号隔离的 AES-GCM 密文保存，不返回浏览器。更换 AppID 必须重新填写 AppSecret；有执行中或待核对的草稿时，需先处理任务才能更改或断开连接。一个空间内同一 AppID 只绑定一个账号档案。

## 2. 保存官方草稿

1. 在编辑器选择目标公众号，填写正文并设置封面。
2. 创建发布计划，冻结这次要发送的内容版本。
3. 前往「发布日历 → 列表」，点击「保存到公众号草稿」。入口只在账号连接检查通过时出现。
4. 在发布计划或任务中心查看阶段：准备上下文 → 上传正文图片 → 上传封面 → 提交草稿 → 已完成。
5. 成功后记录草稿 ID 和提交尝试时间，显示「已存草稿」。在公众号后台检查排版，正式发布后再回填链接与实际发布时间。

当前图文消息检查：标题不超过 32 字；正文图片为不超过 1 MB 的 PNG/JPEG；封面为不超过 10 MB 的 PNG/JPEG；转换后的正文 HTML 少于 2 万字符且小于 1 MB。普通外部图片链接不会被直接发送，请先上传到工作台再插入正文。原始文件保留，程序不会默默压缩或截断。

计划快照不会随之后编辑改变。若快照缺封面或超出限制，需要修改文稿并创建新的计划。

## 3. 失败、重试与断线

- **明确失败**：例如图片格式不符、权限不足或平台明确拒绝。修正条件后可以重试，形成独立的尝试记录；同一连接与同一快照已成功上传的图片、封面会复用。
- **可能已经写入**：提交时断线、超时、返回无法解析，或提交阶段的进程租约过期。进入「草稿待核对」，禁止直接重试、断开连接或回填发布结果。
- **查询核对**：点击「核对平台草稿」，扫描最近 100 条草稿，比较标题、完整正文和封面；只认领唯一的完全匹配项。也可填写草稿 ID，通过读取接口精确核对。
- **查询不到**：维持待核对。列表延迟、范围限制、平台修改 HTML 或人工编辑都可能导致无法匹配，不能据此认定没有写入。
- **人工确认未写入**：在公众号后台确认没有创建这篇草稿后，勾选对应说明并记录人工核对，才重新开放手动重试。

提交阶段不能取消请求，因为平台可能已接收；其他尚未提交的阶段可以取消。旧执行进程失去租约后的返回不能覆盖新状态。重复点击同一次保存请求不会创建重复任务；已记录草稿 ID 的计划不会再次提交。

## 4. 正式发布、结果查询与数据

- **正式发布**：草稿保存后，在发布日历点击「正式发布这份草稿」并勾选确认。正式发布不是群发，不会推送给全部粉丝；账号需具备发布接口权限，首次实际接收请求后能力才记为“可用”。
- **状态**：平台接收后为「已提交，待平台结果」并记录发布任务 ID；查询确认可见后才为「已发布」，记录文章 ID 和链接，来源标为“平台接口查询”。审核未通过、原创声明失败为「发布未通过」，可再次提交；发布后被删除或限制为「平台内容不可见」。
- **自动查询**：已提交的计划每分钟查询一次，最多一小时；之后可在日历中手动「查询发布结果」。
- **回执丢失**：提交时断线进入「待核对」，不能重发或取消。「查询发布结果」会在最近 100 篇已发布文章中比较标题、正文和封面，只认领唯一一致的文章；查不到时保持待核对。在公众号后台确认没有发布后，勾选说明才允许重新提交。
- **定时**：计划可选择“到时自动保存为草稿”或“到时自动保存草稿并正式发布”。后者先保存冻结版本为草稿，再发布这份草稿；错过时间超过 10 分钟默认转为待处理。
- **数据同步**：创建「同步公众号指标」任务，选择发表日期（北京时间昨日及以前，最多 31 天，接口不提供 2025-11-01 之前的数据）。只写入接口返回的阅读人数、点赞、评论、分享人数、收藏人数与阅读完成率；接口没有的指标保持缺失，不填零。统计时间标为统计日结束，不是取数时刻。权限不足只把“同步数据”标为不支持，不影响草稿和发布。

## 5. 备份和恢复

备份包含连接密文、上传检查点、发布快照、草稿 ID 与发布任务 ID，仍需另外保管实例加密密钥。恢复后清空临时令牌并要求重新检查连接；可能已写入的未完成草稿或发布保持待核对，已有发布任务 ID 的回到「已提交」继续查询，其余未完成任务变为失败待处理，均不会自动重放。

## 6. 接口与实现位置

| 功能 | 内部 API |
| --- | --- |
| 读取 / 保存 / 断开连接 | `GET / PUT / DELETE /api/accounts/:id/connection` |
| 重查连接 | `POST /api/accounts/:id/connection/check` |
| 账号能力声明 | `GET /api/accounts/:id/capabilities` |
| 保存官方草稿 | `POST /api/publishing/:id/wechat-draft`，需要 `Idempotency-Key` |
| 核对草稿 | `POST /api/publishing/:id/verify-draft`，传 `jobId` 和可选 `mediaId` |
| 记录人工确认未创建 | `POST /api/publishing/:id/confirm-no-draft`，传 `jobId` 与 `confirmed: true` |
| 正式发布 / 查询结果 | `POST /api/automation`，`kind` 为 `wechat_publish` 或 `wechat_verify`，`data.publishTaskId`；需要 `Idempotency-Key`，令牌需 `publish:write` |
| 确认没有发布 | `POST /api/publishing/:id/confirm-not-published`，传 `confirmed: true` |
| 同步指标 | `POST /api/automation`，`kind: wechat_metrics`，`data` 含 `from`、`to`、`publishTaskIds` |

适配器：`packages/server/src/platforms/`；草稿编排与检查点：`draft-jobs.ts`；正式发布与统计：`official-publishing.ts`；发布前规则：`publication-guard.ts`；租约与恢复：`task-state.ts`、`execution-leases.ts`；验证场景：`tests/channels.test.ts`、`tests/publication.test.ts`。

生产调用固定为 `https://api.weixin.qq.com`。本地测试通过程序内部配置替换为 loopback 模拟服务，普通环境变量和浏览器不能更改平台 API 地址。

## 7. 官方资料

- [获取稳定版 access_token](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html)
- [上传正文图片](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_uploadimage.html)
- [上传永久素材](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial.html)
- [新增草稿](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html)
- [获取草稿列表](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_batchget.html)
- [读取草稿](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_getdraft.html)
- [发布草稿](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_submit.html)、[查询发布状态](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_get.html)、[获取成功发布列表](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_batchget.html)
- [获取已发表文章详细指标](https://developers.weixin.qq.com/doc/service/api/wedata/news/api_getarticletotaldetail.html)

平台文档或权限发生变化时，以真实接口结果为准，并更新适配器和验收记录。
