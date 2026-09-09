# 来源连接器发布、停用与恢复 Runbook

- 适用范围：RSS / Atom 与 Public HTTP JSON；Blocked 连接器不得按本 Runbook 强行启用
- 控制对象：`connector_id + connector_version`、单一 source、单个 ingestion batch、live/backfill checkpoint
- 批准角色：connector rollout 与 batch quarantine 需要 admin；checkpoint cutover 需要两位不同 admin
- 默认原则：记录缺失即 disabled；不以保留审计替代停止错误内容参与主题与证据门禁

## 1. 发布前预检

1. 记录目标 commit SHA、镜像 digest、环境、操作者、变更单和 connector 版本。
2. 确认迁移已应用，且第二次执行输出“没有待应用的迁移”。
3. 读取 `GET /api/v1/source-connectors`，确认静态 `availability=available`，运行态 control 存在。
4. 确认 source Worker 在线且声明目标 `requiredCapability`；render/combined 开发身份不能作为生产证据。
5. 记录切换前来源数、queued/leased 数、checkpoint 版本和开放待办。

验证 SQL：

```sql
SELECT connector_id, connector_version, rollout_mode, version, reason,
       canary_enabled, canary_percent, canary_failure_rate_bps,
       canary_min_runs, canary_started_at, canary_stopped_at, updated_at
FROM source_connector_releases ORDER BY connector_id, connector_version;

SELECT platform, lifecycle_status, health_status, COUNT(*)
FROM source_configs GROUP BY platform, lifecycle_status, health_status
ORDER BY platform, lifecycle_status, health_status;

SELECT kind, status, COUNT(*) FROM jobs
WHERE kind = 'ingestion' GROUP BY kind, status ORDER BY status;
```

## 2. Shadow

通过来源控制台“连接器发布控制”切换为 `shadow`，或调用：

```http
PATCH /api/v1/source-connectors/{connectorId}/versions/{version}/control
Content-Type: application/json

{"rolloutMode":"shadow","expectedVersion":1,"reason":"change-ticket and observation owner"}
```

Shadow 运行必须满足：

- `ingestion_runs.shadow=1`；
- `accepted_count=0`，只保存有界的 fetched/rejected/request/byte 统计；
- 不新增 `articles`、`article_revisions`、`source_item_origins` 或 topic recompute job；
- 不推进 live/backfill checkpoint，不改变来源健康，不发业务通知；
- raw upload 转 `expired`，由删除租约回收。

观察至少覆盖计划定义的窗口。任何正式写入都视为发布阻断。

## 3. Canary 灰度

Canary 是 `rolloutMode=enabled` 下的独立开关，不是第四种 rollout mode。来源控制台点击“灰度”并输入来源比例、自动停止失败率和最小运行数，或调用：

```http
PATCH /api/v1/source-connectors/{connectorId}/versions/{version}/control
Content-Type: application/json

{
  "rolloutMode": "enabled",
  "expectedVersion": 2,
  "reason": "CHG-123 target canary",
  "canary": {
    "enabled": true,
    "percent": 10,
    "failureRateBps": 2000,
    "minRuns": 20
  }
}
```

配置保存在 `source_connector_releases`，默认关闭；默认参数是 10% 来源、20% 失败率（2000 bps）和 20 次最小样本，但目标环境必须在变更单中批准实际阈值。分桶以 `source_config_id + connector_id + connector_version` 确定性计算，桶号 0–99：桶号小于 `percent` 的来源正式运行，其余来源自动走 shadow。调整任一 canary 参数会开始新的观察窗口。

自动停止只统计本轮 `canary_started_at` 后、`shadow=0` 且进入 `succeeded/partial/failed/rights_blocked` 终态的运行；其中 `partial/failed/rights_blocked` 计为失败。达到 `minRuns` 且失败率大于等于阈值后，下一次 Scheduler tick 会调用与人工停用相同的 connector/version kill switch，而不是只关闭 UI 标志。

验证：

```sql
SELECT connector_id, connector_version, rollout_mode, canary_enabled,
       canary_percent, canary_failure_rate_bps, canary_min_runs,
       canary_started_at, canary_stopped_at, version
FROM source_connector_releases
WHERE connector_id = :connector_id AND connector_version = :version;

SELECT shadow, status, COUNT(*)
FROM ingestion_runs
WHERE connector_id = :connector_id
  AND connector_version = :version
  AND created_at >= :canary_started_at
GROUP BY shadow, status ORDER BY shadow, status;
```

验收必须同时抽查命中与未命中来源，证明未命中 run 的 job payload 和 `ingestion_runs.shadow` 均为 shadow，并证明 threshold stop 后 control 为 disabled、queued/retrying 被取消、leased 结果不能正式提交、来源进入 paused、待办和审计存在。当前仓库只有 PGlite/静态 UI 自动化证据，未完成这项目标环境演练。

要把 canary 提升为 100% 全量，点击“启用”或提交 `rolloutMode=enabled` 且 `canary.enabled=false`；不能直接改表。若评估阈值触发，先按紧急停用流程调查和恢复，不得自动重开。

## 4. 紧急停用

在来源控制台选择“停用”，原因必须包含事件或变更单号。停用事务会：

- 把 connector/version control 改为 `disabled`；
- 取消 queued/retrying ingestion jobs 与 queued ingestion runs；
- 暂停受影响来源并清空 `next_run_at`；
- 已租约运行不能继续提交，commit 会隔离结果并让 raw 进入删除队列；
- 产生去重的 `source_connector` 待办和审计事件。

验证：

```sql
SELECT rollout_mode, reason, updated_at FROM source_connector_releases
WHERE connector_id = :connector_id AND connector_version = :version;

SELECT id, status, quarantine_status, error_code FROM ingestion_runs
WHERE connector_id = :connector_id AND connector_version = :version
ORDER BY created_at DESC LIMIT 100;

SELECT id, enabled, lifecycle_status, health_status, last_error_code
FROM source_configs WHERE platform = :platform ORDER BY id;
```

不得直接把 paused 来源批量改回 enabled。

## 5. 恢复

1. 修复代码/配置后部署新 connector version；不要覆盖旧版本的控制记录。
2. 先将新版本设为 `shadow` 并完成观察。
3. 按第 3 节先做小比例 canary；确认观察窗口、命中/未命中和告警均符合预期后，再设为全量 `enabled` 且关闭 canary。
4. 对每个被暂停来源重新执行连接测试，核对预览与权利 grant/config 绑定，再逐项启用。
5. 立即采集一个来源，确认 checkpoint 单调推进、origin 正确、主题重算仅一条。
6. 关闭待办时附变更单、验证 SQL 和 run ID。

## 6. 已提交批次隔离

来源页“运行详情”提供：

- `hold`：tombstone 该 run 的 origin 并重算主题；raw 保留到原期限；
- `release`：仅在当前来源权利与 config grant 有效时恢复 origin 并重算；
- `discard`：不可恢复，origin 保持 tombstone，raw 立即进入删除队列。

三种操作都要求说明和 Idempotency-Key。不得用数据库直接改 `quarantine_status`，否则不会传播主题重算。

## 7. Checkpoint cutover

禁止直接修改 `checkpoint_json`。第一位 admin 调用 `POST /source-configs/{id}/checkpoint-cutovers` 保存 scope、before snapshot、before version、after snapshot 和原因；第二位不同 admin 调用对应 cutover 的 PATCH 批准或拒绝。

批准时只在以下条件全部成立才应用：source version 未变、对应 checkpoint version 未推进、没有 active run。应用后 source 与 checkpoint version 各自递增，原快照永久保留。

## 8. 失败与升级阈值

- 任何未授权正式写入、跨 source 原始载荷引用或 checkpoint 倒退：立即 disabled，按安全事件升级；
- Shadow 出现正式数据写入：停止发布并保留 run/SQL 证据；
- Canary 未命中来源出现正式写入、达到阈值后下一 Scheduler tick 未停用，或自动停用后仍可产生新正式 run：停止全部 source Worker，并按发布控制故障升级；
- kill switch 后仍可新租约或提交：停止全部 source Worker；
- raw 删除连续失败：保持 `expired/deleting` 可重试状态，检查对象存储，不手工标记 deleted；
- 无法证明外部平台已删除：只记录本地撤回/待办，不宣称外部删除成功。

## 9. 证据包

每次发布或恢复至少保存：commit SHA、migration checksums、CI URL、镜像 digest、目标环境、rollout audit ID、canary 参数与开始/停止时间、命中/未命中/阈值 run IDs、shadow/正式 run IDs、切换前后 SQL、待办处置、批准人、执行时间和观察截止时间。
