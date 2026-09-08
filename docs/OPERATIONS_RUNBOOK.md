# Signal 40 运行、故障与内容勘误手册

更新时间：2026-09-08

## 1. 值班入口与初始 SLO

- `/api/v1/health`：数据库可达性、活跃队列和 DLQ；外部探针每分钟检查。
- `/operations`：近 30 天采集、TTS、渲染、发布的成功/失败、重试、P50/P95、记录成本和待处置作业。
- 初始目标：控制面月可用性 99.9%；正式渲染 30 分钟完成率 98%；未核验声明和重复逻辑发布均为 0；重大事实错误目标为 0。
- 告警：健康接口 503 立即告警；`deadLetter > 0`、发布/渲染失败持续 5 分钟、渲染 P95 超过 30 分钟、月预算使用 80% 分别触发 P1/P2 告警。

生产告警发送器不保存在本仓库。部署时由托管监控读取上述接口，并把通知路由到团队实际值班系统。

## 2. 调度器与编排引擎

调度器是常驻进程（`npm run scheduler`，compose 里的 `scheduler` 服务），默认 30 秒一轮，
调用 `lib/orchestrator.ts` 跑一轮 tick：采集 → 选题质量评估 → 建项目 → 推进 → 作业编排 →
发布 → 指标回流 → 清理。每轮都写一行 `automation_runs`，`/automation` 与 `/operations` 直接读它。

需要手动补一轮时（工作量收得更紧，避免 HTTP 超时）：

```bash
curl -X POST "$SIGNAL40_CONTROL_URL/api/v1/scheduler/run" \
  -H "X-Worker-Token: $SCHEDULER_TOKEN"
```

Cron 使用 UTC 五字段格式。调度器扫描上次运行后的遗漏分钟，最多回看 7 天；`schedule:<source>:<minute>` 保证同一计划时间只入队一次。来源失败进入指数退避，达到最大次数进入 DLQ。

值班要点：

- **调度器没在跑**：`/settings/diagnostics` 的「调度器上次 tick」超过 5 分钟即判降级。先看 `scheduler` 容器日志，再确认 `DATABASE_URL` 与 `SIGNAL40_AUTOMATION_ACTOR_ID`。
- **服务账号缺失**：待办箱出现 `automation_actor_missing` 时，引擎一步都不会做。把 `SIGNAL40_AUTOMATION_ACTOR_ID` 指到 `team_members` 里一个 active 的 admin 成员再重启调度器。这是刻意的失败方向——自动化不允许凭空构造身份。
- **阶段熔断**：同一阶段连续失败 3 次即熔断 15 分钟，并写一条 `breaker_open` 待办。冷却结束后自动放行一次，成功即复位；不要靠反复重启调度器绕过它，先解决待办里记录的根因（通常是对象存储或 OpenAI 不可用）。
- **两个调度器实例**：选取本轮项目集合时用 `pg_try_advisory_xact_lock` 抢短锁，抢不到的那一轮记为 `skipped / another_tick_running`，属于正常现象。

## 2.1 Worker 在线状态

Worker 空闲轮询时每 15 秒上报一次心跳（`POST /api/v1/workers`），控制面按 90 秒判定离线，
超过 7 天没有心跳的行由 tick 清理。

- 界面点了「生成配音」却一直没动静：先看 `/operations` 或 `/settings/diagnostics` 的在线 Worker 数。项目页顶部会直接显示「入队的作业没有人会执行」，条件是该类型作业已排队超过 60 秒且没有在线 Worker 声明能处理它。
- 处置就是把 `render-worker` 服务拉起来（`docker compose up -d render-worker`）；作业还在队列里，Worker 一上线就会被领取，不需要重建。

## 3. Worker 启动与降级

```bash
docker run --rm --shm-size=1g \
  -e SIGNAL40_CONTROL_URL \
  -e SIGNAL40_WORKER_TOKEN \
  -e OPENAI_API_KEY \
  -e YOUTUBE_ACCESS_TOKEN \
  signal40-render-worker:<release>
```

- OpenAI 不可用：停止新建云端配音，保留已生成音轨；本地开发可用 `npm run voice:local`，不得把本地声音证据冒充生产授权。
- YouTube 不可用：使用 `package` 渠道生成待发布包，禁止绕过 G7 手工调用生产发布接口。
- Worker 过载：调低 `RENDER_CONCURRENCY_LIMIT`，高优先级先租约；预算由 `MONTHLY_RENDER_BUDGET_MICROS` 硬拒绝新渲染。
- 永久失败：管理员在 `/operations` 阅读错误后“确认并重放”；不要盲目循环重放。
- 自动 QC 未通过：Worker 仍然提交 QC 报告，但作业以 `dead_letter` 结束、项目落到 `FAILED`，并且不抽取封面。这是刻意设计——QC 失败是确定性结果，重试只会重复烧掉渲染成本。处置顺序是先看 QC 报告里失败的检查项，修正项目内容或素材，再把项目从 `FAILED` 转回 `RENDER_QUEUED` 重新排渲染。看到成片资产入库但作业失败属于预期，那份成片只用于人工诊断，G6 不会放行。
- 长渲染租约：Worker 每 120 秒调用 `/api/v1/jobs/{id}/heartbeat` 续约。日志里出现连续“续约失败 HTTP 409”说明租约已被其他 Worker 接管，应当检查是否有两个 Worker 用了同一个 `SIGNAL40_WORKER_ID`。
- 死信里出现“payload_json 无法解析”：说明该作业行的 payload 已损坏，控制面主动隔离它以免整个租约接口反复 500。核对来源数据后重建作业，不要直接改库里的 JSON。

## 3.1 待办箱与自动化暂停

`/inbox` 汇总所有需要人处理的事：门禁未过、自动 QC 失败、死信作业、证据冲突、
超预算或超限额、阶段熔断、被拒的自动放行、质量不达标的选题、指标到期未回流。
同一件事按去重键只产生一条；处理时必须写处置说明，处置记录进审计。
配了 `SIGNAL40_ATTENTION_WEBHOOK_URL` 时新条目会带 HMAC 签名推到外部（签名格式与入站 Webhook 一致）。

自动化会在这些情况下自动退出，并把原因写进 `content_projects.automation_paused_reason`：

- 任何人对项目做了编辑、审批、配置修改或手工建发布任务；
- 项目登记了未关闭的 `content_incidents`（勘误、下架、投诉）——事件与自动化互斥；
- 所属策略被删除。

恢复必须是人的显式动作：项目页的「恢复自动」按钮，或 `POST /api/v1/projects/{id}/automation`。
内容事件未关闭时恢复会被拒绝。

## 4. 内容勘误与下架

1. 在项目事件 API 登记 `fact_update`、`correction` 或 `complaint`，填写严重度和事实原因。
2. 重大/关键事件立即停止排期。已发布内容调用 `/api/v1/publish-jobs/{id}/withdraw`；系统登记撤回事件、把项目退回 `CHANGES_REQUESTED`，并为 YouTube 入队远端删除。
3. 修订研究快照，解决冲突，重新走 G3–G7。新发布任务通过 `correctionOfId` 关联旧版本。
4. 发布勘误说明并在内容事件中记录处置结果；由另一位编辑或发布者关闭事件。
5. 对重大事实错误做复盘：来源、声明、审批、模板、平台 ID 和所有哈希必须能从审计流复原。

## 5. Webhook 与密钥

- Secret 只进入托管 Secret；`.env.example` 只有空值或占位符。
- YouTube 回调需提供 `X-Signal-Event-Id`、Unix 秒 `X-Signal-Timestamp`、`X-Signal-Signature: sha256=<hex>`。
- 签名内容是 `<timestamp>.<raw-body>`，允许时差 5 分钟；事件 ID 唯一，重放返回既有结果。
- 轮换顺序：部署新 Secret、切换发送端、验证回调、撤销旧 Secret。轮换行为在外部 Secret 管理审计中保留。

## 6. 迁移后核对

`drizzle/0014` 与 `drizzle/0015` 会把历史 `evidence_links` 行回填到具体的 `article_revisions`。0014 按 URL 精确匹配，0015 补一轮忽略大小写与尾斜杠的匹配；查询参数差异仍然匹配不上，属于已知残留。每次在新环境应用迁移后统计未回填行数并记录到发布检查单：

```sql
SELECT COUNT(*) AS unmatched
FROM evidence_links
WHERE article_revision_id IS NULL;
```

数值不为 0 时不阻塞发布，但需要确认这些证据链接确实没有对应的本地文章修订（例如人工导入的外部来源），必要时补一轮按归一化 URL 的人工回填。

## 7. 备份与恢复

本地演练：

```bash
./scripts/backup-local.sh backups/drill
CONFIRM_RESTORE=isolated RESTORE_PERSIST_TO=/private/tmp/signal40-restore-drill ./scripts/restore-local.sh backups/drill
npm run drill:restore
```

`drill:restore` 会用 `pg_dump` 备份当前库，恢复到一个 `signal40_restore_` 前缀的隔离数据库，逐表比对行数，结束后自动删除该库，全程不修改源库。恢复脚本校验 SHA-256，并且要求同时设置 `CONFIRM_RESTORE=isolated` 和以 `signal40_restore_` 开头的 `RESTORE_TARGET_DB`——少设一个就拒绝执行，不可能误覆盖生产库。对象存储只做清单快照；真正的对象副本交给 R2 的版本控制与生命周期规则。生产库使用托管的时间点恢复。季度演练必须在隔离环境恢复数据库、核对对象清单，并从研究快照重新生成成片。

## 8. 内容发布渠道

G7 通过后进入发布环节。两个渠道的对外行为完全不同，选错渠道就是真的把内容发出去了。

### 共同前置：G7 的职责分离

`G7_PUBLISH_APPROVAL` 要求发布批准满足三个条件，缺一不可：

- 批准结论为 `approved`；
- `subject_hash` 等于当前成片的 `immutable_hash`（成片一变，旧批准立即失效）；
- **批准人不是研究批准人**（`publishApproval.actor_id !== researchApproval.actor_id`）。

同一个人既批研究又批发布会被门禁拒绝，这是硬约束，不要用同一个账号跑完全程。

### package 渠道（不对外，已端到端验证）

只把发布包清单写进对象存储，不联系任何外部平台。适合内部存档、人工分发和演练。

```bash
# 1) 项目先进入 PUBLISH_SCHEDULED，再建发布任务（顺序与配音/渲染相反）
curl -X POST "$API/api/v1/projects/$PROJECT/publish-jobs" \
  -H 'content-type: application/json' -H "x-signal-role: publisher" \
  -H 'idempotency-key: <唯一键>' \
  -d '{"channel":"package","title":"...","description":"...","tags":["财经"]}'

# 2) Worker 执行后，发布任务变为 published，清单写入 R2
npm run worker
```

**人工确认已分发**：`package` 渠道的项目不会自动变成 `PUBLISHED`——包产出了不等于内容发出去了。
拿到包并完成实际分发后，由发布人显式确认：

```bash
curl -X POST "$API/api/v1/projects/$PROJECT/transitions" \
  -H 'content-type: application/json' -H "x-signal-role: publisher" \
  -H 'if-match: "<当前版本>"' \
  -d '{"to":"PUBLISHED","note":"已从 R2 取出发布包并完成分发，渠道与范围：……"}'
```

说明至少 10 个字并写入审计，事后要能查出是谁、依据什么确认已分发。没有已完成的 `package` 发布任务时这条通道会被拒绝。

### youtube 渠道（真实上传，尚未验证）

**这条路径尚未做过端到端验证**，下面是代码约定，首次使用请在测试频道上做。

前置：

- `YOUTUBE_ACCESS_TOKEN`（OAuth 访问令牌，需要 `youtube.upload` 权限）；
- 成片资产版权状态为 `cleared`（G5 已保证）。

发布保险：**没有把 `SIGNAL40_ALLOW_PUBLIC_PUBLISH` 显式设成 `true` 之前，所有上传一律强制 `private`**，
即使请求里写了 `privacyStatus: "public"` 也会被改写。这是代码里的 fail-safe，不要为了图省事关掉它。

与 package 的差异：

- Worker 走断点续传上传，失败最多恢复 6 次；上传成功后如果带了封面资产会再传一次缩略图；
- 渠道回调会把项目直接推进到 `PUBLISHED`，**不需要**上面那步人工确认；
- 回调写入 `external_id` 与 `final_url`，下架时用它调用 YouTube 删除接口。

首次验证建议按这个顺序：先用测试频道的 token 跑一次，确认返回的 `privacyStatus` 是 `private`、
`external_id` 与 `final_url` 已落库，再决定是否开放 `SIGNAL40_ALLOW_PUBLIC_PUBLISH`。

### G8 与指标回流

`POST /api/v1/projects/{id}/metrics` 写入指标快照，要求项目已是 `PUBLISHED`/`MEASURED` 且发布任务已 `published`。
**写入成功会自动把项目推进到 `MEASURED`**，不需要再单独做一次状态转换（再转会被状态机以
`INVALID_TRANSITION` 拒绝，这是正常的）。指标字段为非负数，`completionRate` 与
`threeSecondRetentionRate` 取值 0–1。

## 9. 发布与回滚

1. 在目标 SHA 执行 `npm ci`、生产依赖审计、测试、100 场景回归、迁移、构建、Docker 真渲染。
2. 先做向后兼容迁移，再发布控制面与 Worker；金丝雀渲染通过后开放流量。
3. 应用/Worker 可回退上一镜像；已应用的迁移不回滚，采用新的前向修复迁移。
4. 发布后观察 30 分钟：健康、积压、失败、P95、成本、重复发布和内容事件。

## 10. 不可替代的人工责任

真实财经标注集、声音/素材权利、最终事实终审、渠道账号和 Remotion 商业许可必须由责任人确认。自动门禁只能阻止已知错误，不能代替财经编辑、法务或平台所有者。
