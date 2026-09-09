# 来源采集 SLO 策略

- 策略版本：`2026-09-09.v2`
- 状态：`In progress — 等待 Product/SRE 签字`
- 时间基准：UTC
- 可执行实现：`lib/source-slo.ts`
- 可重现报告：`npm run source-slo:report`

本文描述 `/api/v1/operations` 的 `sourceSlo.policy` 返回的策略。代码中的策略对象是计算口径的机器可读权威。观察开始后若修改版本、阈值、分类或边界，本轮观察作废并重新计时。

## 分母与分类

只有 `trigger=schedule` 的运行可进入运行成功率分母。`succeeded` 是成功，`partial` 与 `failed` 是 eligible failure。`rights_blocked`、`cancelled`、`queued` 和 `running` 单独报告，不进入该分母。manual 与 backfill 同样单列，永远不能提高定时运行可用率。

定时触发可用率使用独立分母：从监控开始时刻起应出现的 UTC cron occurrence，并排除最近五分钟宽限区。每个唯一 `scheduled_for` 只算一次，不因重试重复计数，避免已创建的成功运行掩盖漏掉的 scheduler tick。

HTTP 304 仍属于成功运行，但 Worker 会把它作为 `fetch_outcome=not_modified` 独立持久化并在来源/聚合窗口中单列；正常有内容响应记为 `modified`。升级前或旧 Worker 没有标记的运行记为 `unknown`，不会被伪装成零。`not_modified` 若同时携带内容、拒绝项或响应字节，提交端会 fail closed。

## 窗口、目标与缺数

- 成功与触发目标：7 天和 28 天窗口都为 `99%`。
- 最低 eligible 样本：7 天 10 个、28 天 30 个；适用于两种分母。
- Burn 告警：7 天至少 `2x` 且 28 天至少 `1x`。
- 新鲜度：P95 `finished_at - scheduled_for` 不超过观测到的中位采集周期加五分钟。
- 查询守卫：超过 500 个活跃来源、100,000 条选中运行、10,000 个排除窗口或 10,000 条预算降频 occurrence 时，`dataComplete=false`；所有受影响来源/切片均显示 `insufficient_data`，永不显示健康。
- 监控起点缺失或无效、cron 无效、低频样本不足、freshness 基线缺失时，对应指标显示不可用而不是零。
- 低频来源：28 天内预期触发少于 30 次时保持 `insufficient_data`，不得放宽成绿色；连接器验收另须真实连续覆盖至少两个预期更新周期。此规则可能把低频来源的验收拉长到 28 天以外，但不能以合成运行补齐。

迁移 `0025_source_slo_exclusions.sql` 持久化显式排除区间。管理员主动暂停必须填写原因，暂停动作开窗、重新启用关窗；未来 90 天内、最长 7 天的计划维护可通过 `/api/v1/source-configs/{sourceId}/slo-exclusions` 登记，并且只能在开始前取消。取消不删除原记录。只有未取消且时间命中的 `manual_pause/planned_maintenance` 会同时从 eligible run 与 expected cron occurrence 分母排除；权利阻断、认证失败、预算阻断或未登记停机不能借此美化 SLO。

### 预算软阈值自动降频

迁移 `0026_source_schedule_throttling.sql` 增加来源级 `schedulePriority`、自动降频开关、当前有效倍数/原因/恢复时间，以及逐 occurrence 的 `source_schedule_throttles` 审计表。系统不修改管理员配置的原始 cron；一次到期运行成功入队后，若月度预留支出达到软阈值，则按来源优先级计算下一次运行：

- 优先级 `80–100`：保持原频率；
- 优先级 `50–79`：周期放大为 `2x`；
- 优先级 `0–49`：周期放大为 `4x`；
- 管理员关闭自动降频、未配置月预算或尚未达到软阈值时：保持原频率。

被策略跳过的每个 cron 时点必须先以 `policyVersion`、预算快照、优先级、倍数和恢复时间持久化。SLO 只从 expected-trigger 分母扣除这些精确记录，并在 `budgetThrottled` 中单独报告；没有记录的 Scheduler 漏跑仍消耗错误预算。硬预算阻断、无 Worker、权利/认证故障都不是降频，不能生成该记录。来源页与运维页显示开关、优先级、当前倍数、已跳过次数和恢复条件。下一个 UTC 月度周期会自动重新评估；管理员调整预算/优先级或关闭策略后，来源重新启用时立即恢复调度评估，历史记录不可删除。

正式观察必须从 `0024`–`0026` 已部署且策略签字后的明确时刻开始；迁移前没有 fetch outcome、排除窗口或预算降频 occurrence 的历史数据只能标为 unknown，不能回填推测。

## 告警目标

违规会在 `/inbox` 创建去重的 critical `source_slo` 待办。如果配置了 `SIGNAL40_ATTENTION_WEBHOOK_URL` 及签名密钥，既有签名 webhook 会转发该待办。仓库不擅自选择生产值班厂商或接收人；目标环境路由与告警演练仍是验收要求。

## 批准记录

| 角色 | 批准人 | 决定 | 时间 | 适用 release/connector 集合 |
| --- | --- | --- | --- | --- |
| Product | 未指定 | Pending | — | — |
| SRE | 未指定 | Pending | — | — |

任一批准仍为 Pending 时，不得把任何观察窗口标为 Accepted。
