# 来源依法删除 Runbook

- 适用范围：来源原始载荷、独占规范化正文、由其派生的项目/媒体对象，以及已发布内容的外部撤回
- 当前交付级别：本地实现与开发 PostgreSQL 已验证；尚未经过生产 legal 审批、真实 YouTube 撤回演练或多 Worker 强杀验收
- 不适用：普通停用、归档、可逆权利撤回；这些操作不得冒充依法删除

## 1. 不变量

1. `legal hold` 优先于删除。active hold 会把删除请求设为 `blocked`，递增 source 的 hold epoch，并取消排队、重试中或已领取的外部撤回作业；解除必须由建立者之外的管理员给出审计原因。
2. 对象存储删除失败时，规范化正文和派生数据库记录不得先删。对象项有租约、次数、脱敏错误和可重试状态。
3. 已发布内容必须等发布 Worker 成功回执。创建撤回作业、打开事件或写待办都不等于外部内容已删除。
4. 共享文章只删除目标来源的 origin；只要还有其他 active origin，规范化文章、修订和主题链接继续保留。
5. 回执不保存 Secret、正文或原始 object key。object key 删除成功后清空，只保留 key hash、结果摘要和不可逆 receipt hash。
6. 保留 `source_deletion_requests`、`source_deletion_items` 摘要、legal hold、权利事实和审计事件作为最小证明；来源配置、locator、checkpoint、连接会话/预览和凭据绑定会被清理或脱敏。

## 2. 状态

| 状态 | 含义 | 操作 |
| --- | --- | --- |
| `pending` | 等待 Scheduler 初始化、删除对象或重试 | 确认 scheduler 与对象存储可用 |
| `blocked` | 存在 active legal hold | 不得绕过；由法律/管理员确认后解除 hold |
| `deleting` | 已由清理器领取短租约 | 等待；租约过期后可由下一轮恢复 |
| `awaiting_external` | 本地对象已删除，等待平台撤回回执 | 检查 render Worker、发布凭据和对应 publish job |
| `failed` | 对象或外部删除失败 | 修复存储/平台原因；对象失败由后续 tick 自动重试，外部 dead letter 需处置后重新发起受控作业 |
| `completed` | 对象、外部撤回和数据库清理全部完成 | 核对 `receipt_hash` 与 audit，不再尝试恢复内容 |

## 3. 创建与查询

来源控制台的“依法删除”要求填写依据并二次输入来源名称。API 等价操作：

```http
POST /api/v1/source-configs/{sourceId}/content-withdrawals
Idempotency-Key: legal-delete:{sourceId}:{request-id}
Content-Type: application/json

{"expectedVersion": 3, "mode": "legal_delete", "reason": "工单/请求依据"}
```

返回 `202` 只表示请求已登记。通过以下只读接口检查状态和最终回执：

```http
GET /api/v1/source-configs/{sourceId}/content-withdrawals
```

只有 `status=completed` 且 `receipt_hash` 非空才能对外表述为系统删除完成。外部平台是否完成由对应 `external_publish` item 的 `confirmed` 回执支持。

## 4. Legal hold

创建：

```http
POST /api/v1/source-configs/{sourceId}/legal-holds
Content-Type: application/json

{"reason": "至少 10 字的保全原因", "authorityRef": "case-or-order-reference"}
```

解除：

```http
POST /api/v1/source-configs/{sourceId}/legal-holds/{holdId}/release
Content-Type: application/json

{"reason": "至少 10 字的解除依据"}
```

解除 hold 会让 blocked 请求回到 `pending`，把被取消的外部撤回作业更新到当前 hold epoch 后重新排队；Worker 必须获得新 lease，并在调用平台前通过 `/api/v1/worker/legal-deletion-withdrawals/{jobId}/authorize` 再次复核。不要直接改数据库状态或重用旧 lease。

## 5. 执行与排障

- Scheduler 每轮 cleanup 最多按剩余外部 API 预算处理一批对象。可启动 `npm run scheduler`，或由管理员调用一次 `/api/v1/scheduler/run`。
- `OBJECT_DELETE_FAILED`：验证 S3/R2 权限、endpoint 和对象锁策略；修复后下一轮会重试。
- `EXTERNAL_DELETE_FAILED`：检查 render Worker 与频道凭据；修复后由管理员调用 `POST /api/v1/source-configs/{sourceId}/content-withdrawals/{requestId}/retry` 并填写原因。dead-letter 不会被数据库清理器自动循环或伪装为成功。
- `PUBLISH_RECORD_MISSING` / `EXTERNAL_ID_MISSING`：缺少证明链，必须人工调查，不得把 item 改成 `confirmed`。
- 请求长时间 `awaiting_external`：检查 `jobs.payload_json.deletionRequestId` 对应作业是否 queued/leased/retrying/dead_letter，以及 render Worker 是否在线。
- 请求 `blocked`：先查询 legal hold 历史；没有正式解除依据时停止处置。

## 6. 验收证据

每次生产演练至少保存：请求 ID、source ID、迁移版本、对象项数量、外部 publish job ID、Worker 回执、最终 receipt hash、审计事件、执行时间、环境和批准人。不得保存 Secret、正文、完整来源响应或原 object key。

当前自动化回归覆盖：hold/解除、对象删除失败重试、共享文章保留、外部回执前阻断最终清理、回执不含 object key。生产 Accepted 仍需真实对象存储、真实已授权平台撤回和多实例故障注入。
