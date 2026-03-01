# Web 端视频下载工具 PRD（YouTube 场景，合规版）

## 0. 可行性结论（先看这节）
- 结论：技术上可行，商业上线“有条件可行”。
- 关键前提：产品必须明确为“仅处理用户拥有版权或已获授权的内容”，并具备可执行的合规与风控流程。
- 主要风险：若定位为“任意 YouTube 视频下载”，存在较高平台条款与版权合规风险，可能影响长期运营和支付、云资源稳定性。
- 上线门槛（Go/No-Go）：
1. 法务确认用户协议、隐私政策、侵权处理流程。
2. 完成版权投诉受理机制（邮箱/工单/SLA）。
3. 完成基础风控（限流、黑名单、审计日志）。
4. 完成安全基线（SSRF 防护、签名下载、权限校验）。

## 1. 文档信息
- 产品名称：VideoDownloader Web
- 文档版本：PRD v1.1（MVP）
- 创建日期：2026-02-27
- 目标上线：T+8 周（可调整）
- 面向市场：全球（首版英文，后续 i18n）

## 2. 背景与问题
用户在学习、归档、二次创作场景中，需要将“有权使用”的视频保存为本地文件，并完成基础格式转换（MP4/MP3）。

现有方案痛点：
- 工具质量不稳定，下载失败率高。
- 无可靠进度反馈与失败重试机制。
- 缺乏任务管理，历史记录不可追溯。
- 合规提醒和侵权处理链路缺失。

## 3. 目标与成功指标
### 3.1 产品目标
1. 提供从 URL 到文件下载的端到端闭环。
2. 提供异步任务处理，保证前端体验与后端稳定性。
3. 通过合规提示、审计和风控降低滥用风险。

### 3.2 核心 KPI（MVP 上线后 30 天）
1. 解析成功率 >= 95%
2. 任务完成成功率 >= 92%（去除用户主动取消）
3. 任务平均完成时长（<= 500MB）P95 <= 180 秒
4. 重试后恢复成功率 >= 35%
5. 投诉工单首次响应时间 <= 24 小时

## 4. 非目标（MVP 不做）
- 不支持绕过 DRM、付费墙、登录态受限内容。
- 不支持复杂剪辑（裁剪、拼接、字幕编辑、滤镜）。
- 不提供桌面客户端。
- 不承诺“任意链接都可下载”。

## 5. 用户角色
1. 匿名用户：可试用，低配额、低并发。
2. 注册用户：更高配额，可查看历史任务。
3. 管理员：查看审计日志、投诉工单、封禁策略。
4. 合规运营：处理投诉、执行下架和封禁。

## 6. 功能需求（MVP）
### 6.1 URL 解析
- 输入 YouTube URL，执行标准化（去追踪参数、统一短链）。
- 白名单校验：仅允许 `youtube.com` / `youtu.be`。
- 返回元数据：标题、时长、封面、可选格式、文件大小预估（若可得）。
- 失败返回规范错误码（如 `UNSUPPORTED_URL`、`VIDEO_UNAVAILABLE`）。

### 6.2 任务创建
- 用户选择输出类型：MP4 / MP3。
- 用户选择清晰度或音频码率（受源格式限制）。
- 提交前必须勾选“我确认已获授权”。
- 创建异步任务并返回 `taskId`。
- 支持幂等键（`Idempotency-Key`）避免重复任务。

### 6.3 任务管理
- 状态：`queued` / `downloading` / `transcoding` / `uploading` / `success` / `failed` / `canceled` / `expired`
- 前端可轮询或 WebSocket 获取进度。
- 支持失败重试（最多 2 次，指数退避）。
- 失败信息对用户可读，内部保留技术错误详情。

### 6.4 成品交付
- 成功后生成签名下载 URL。
- 下载链接默认 24 小时过期。
- 过期后状态变更为 `expired`。
- 文件自动清理（TTL Job）。

### 6.5 历史任务
- 展示最近 N 条任务（默认 30）。
- 支持按状态筛选和分页。
- 支持重新下载（链接有效时）或重新发起任务（链接过期时）。

### 6.6 合规与投诉
- 首页和创建任务处展示版权声明。
- 提供投诉入口（邮箱+表单）。
- 建立投诉处理 SLA：24 小时首次响应，72 小时处理结论。

## 7. 核心业务规则
1. 单文件上限：2GB（配置项）。
2. 匿名并发：1；注册并发：3。
3. 日配额：匿名 5 次；注册 30 次（配置项）。
4. 下载链接有效期：24 小时（配置项）。
5. 同一 URL + 同一参数在 10 分钟内命中已完成结果时可复用产物（降本）。

## 8. 任务状态机与错误码
### 8.1 状态流转
1. `queued` -> `downloading` -> `transcoding` -> `uploading` -> `success`
2. 任意运行中状态 -> `failed`（系统错误）
3. `queued`/`downloading`/`transcoding` -> `canceled`（用户取消）
4. `success` -> `expired`（链接和文件到期）

### 8.2 错误码（MVP）
- `UNSUPPORTED_URL`：链接不在白名单或格式错误
- `VIDEO_UNAVAILABLE`：源视频不可访问或被删除
- `FORMAT_NOT_AVAILABLE`：请求清晰度/编码不可得
- `QUOTA_EXCEEDED`：超配额
- `CONCURRENCY_LIMITED`：超并发
- `TRANSCODE_FAILED`：转码失败
- `STORAGE_UPLOAD_FAILED`：上传失败
- `INTERNAL_ERROR`：未知内部错误

## 9. API 设计（MVP）
### 9.1 `POST /api/v1/parse`
- 请求：`{ "url": "https://..." }`
- 响应：`{ "videoId": "...", "title": "...", "duration": 123, "thumbnail": "...", "formats": [] }`

### 9.2 `POST /api/v1/tasks`
- Header：`Idempotency-Key: <uuid>`
- 请求：`{ "url": "...", "outputType": "mp4|mp3", "quality": "720p", "audioBitrate": "192k", "rightsConfirmed": true }`
- 响应：`{ "taskId": "...", "status": "queued" }`

### 9.3 `GET /api/v1/tasks/:id`
- 响应：`{ "taskId": "...", "status": "...", "progress": 0, "errorCode": null, "downloadUrl": null, "expiresAt": null }`

### 9.4 `GET /api/v1/tasks`
- 查询参数：`status,page,pageSize`
- 响应：`{ "items": [], "page": 1, "pageSize": 20, "total": 100 }`

### 9.5 `POST /api/v1/tasks/:id/retry`
- 规则：仅 `failed` 可重试，且重试次数 <= 2。

### 9.6 `POST /api/v1/complaints`
- 请求：`{ "taskId": "...", "url": "...", "reason": "...", "contact": "..." }`
- 响应：`{ "ticketId": "...", "status": "open" }`

### 9.7 统一错误响应
- 错误结构：`{ "errorCode": "...", "message": "...", "requestId": "..." }`
- HTTP 状态码约定：
1. `400` 参数错误（含 `UNSUPPORTED_URL`）
2. `401/403` 鉴权或权限错误
3. `404` 任务不存在
4. `409` 幂等冲突或状态不允许（如非 `failed` 重试）
5. `429` 频率/配额限制
6. `500` 内部错误

## 10. 数据模型（核心）
### 10.1 `users`
- 字段：`id`, `email`, `role`, `status`, `quota_daily`, `created_at`, `updated_at`
- 索引：`email` 唯一索引

### 10.2 `download_tasks`
- 字段：`id`, `user_id`, `source_url`, `source_hash`, `platform`, `output_type`, `quality`, `audio_bitrate`
- 字段：`status`, `progress`, `error_code`, `error_message`, `retry_count`
- 字段：`output_object_key`, `file_size`, `expires_at`, `rights_confirmed_at`, `created_at`, `updated_at`
- 索引：`(user_id, created_at desc)`、`status`、`source_hash`

### 10.3 `task_events`
- 字段：`id`, `task_id`, `from_status`, `to_status`, `message`, `created_at`
- 用途：追踪状态变更与排障

### 10.4 `abuse_blocks`
- 字段：`id`, `subject_type(ip|user|ua)`, `subject_value`, `reason`, `expired_at`, `created_at`
- 用途：风控封禁

### 10.5 `complaint_tickets`
- 字段：`id`, `task_id`, `source_url`, `reason`, `contact`, `status`, `resolution`, `created_at`, `updated_at`
- 用途：侵权投诉流程管理

## 11. 技术架构（建议）
- 前端：Next.js
- API：NestJS
- 队列：Redis + BullMQ
- Worker：`yt-dlp` + `ffmpeg`
- 数据库：PostgreSQL
- 存储：S3/MinIO
- 网关：Nginx

链路：
1. 前端提交 URL 到 API。
2. API 校验规则并创建任务写入队列。
3. Worker 消费任务并分阶段更新进度。
4. 成品上传对象存储并回写下载地址。
5. 前端展示状态并触发下载。

## 12. 安全、合规与隐私
### 12.1 安全控制
- URL 白名单 + DNS 解析校验，阻断内网地址（防 SSRF）。
- 参数白名单，严禁拼接用户输入到 shell 命令。
- 鉴权（JWT）+ 限流（IP/用户双维度）。
- 签名下载链接、短期有效、最小权限访问。

### 12.2 合规控制
- 用户必须勾选授权确认并记录 `rights_confirmed_at`。
- 提供投诉入口与工单跟踪。
- 建立下架与封禁流程，留存操作审计。

### 12.3 数据保留
- 任务日志保留 90 天（配置项）。
- 下载文件默认 24 小时自动删除。
- 投诉工单和封禁记录保留 180 天（可按地区法规调整）。

## 13. 非功能需求（NFR）
1. 可用性：月可用性目标 99.9%。
2. 性能：
- `POST /parse` P95 < 1.5s（缓存命中）
- `GET /tasks/:id` P95 < 300ms
- 任务排队等待时长 P95 < 30s（常态负载）
3. 可观测性：
- 结构化日志（含 `taskId`, `userId`, `errorCode`）
- 指标：队列长度、失败率、平均耗时、存储占用
- 告警：失败率异常、队列堆积、对象存储写入失败
4. 可靠性：
- Worker 崩溃后任务可恢复（至少一次投递 + 幂等处理）
- 外部依赖不可用时降级并返回可读错误
- 灾备目标：RPO <= 15 分钟，RTO <= 30 分钟（MVP）

## 14. 埋点与分析
### 14.1 北极星指标
- 日成功下载任务数

### 14.2 漏斗指标
- URL 提交数 -> 解析成功数 -> 任务创建数 -> 下载成功数 -> 文件点击下载数

### 14.3 质量指标
- 失败率（按错误码）
- 重试成功率
- 平均完成时长（按文件大小分桶）

## 15. 验收标准（UAT）
1. 合法 URL 在 3 秒内返回基础元数据。
2. 创建任务后，状态可连续更新且刷新不丢失。
3. 成功任务可下载，过期任务返回明确错误。
4. 超配额、超并发、格式不可用均有明确错误码与文案。
5. 失败任务可重试并记录重试次数。
6. 投诉工单可创建、可追踪、可关闭。

## 16. 测试计划
1. 单元测试：URL 校验、状态机、错误码映射、配额计算。
2. 集成测试：API+队列+Worker+存储完整链路。
3. E2E 测试：用户从创建到下载全流程。
4. 压测：高并发创建任务、长任务堆积与恢复。
5. 安全测试：SSRF、命令注入、鉴权绕过、限流有效性。

## 17. 里程碑（8 周）
1. 第 1-2 周：解析服务、任务模型、状态机、基础 API。
2. 第 3-4 周：Worker 下载/转码、对象存储、重试策略。
3. 第 5-6 周：前端任务页、历史页、风控与限流。
4. 第 7 周：压测、安全测试、告警与仪表盘。
5. 第 8 周：灰度发布、投诉流程演练、上线与回滚预案。

## 18. 风险与应对
1. 平台策略变化导致成功率下降
- 应对：策略版本化、快速回滚、异常告警
2. 高峰时队列堆积
- 应对：Worker 自动扩缩容、优先级队列
3. 成本超预算（转码/存储/带宽）
- 应对：TTL 清理、缓存复用、体积上限策略
4. 版权投诉集中
- 应对：快速下架、黑名单、审计留痕

## 19. 待决策事项（上线前必须定稿）
1. 是否开放匿名下载（建议仅登录用户）。
2. 文件保留时长默认值（24h 或 12h）。
3. 是否启用 WebSocket（MVP 建议先轮询，V1.1 再启用）。
4. 投诉受理渠道优先级（邮箱优先还是表单优先）。
5. 是否引入 YouTube OAuth 做频道归属校验（建议作为 V1.1 优先项）。

