# Signal 40 代码审查报告

日期：2026-09-08
范围：`lib/`、`app/api/`、`render-worker/`、`scripts/`、`video/`、`db/schema.ts`、`drizzle/` 迁移、`test/`
方法：四个并行子审查（域逻辑 / API 与鉴权 / Worker 与脚本 / Schema 与测试），关键发现已在主线人工复核源码确认。未复核的条目在文中注明。

## 总体结论

代码库整体质量较高：状态机与门禁契约清晰、审计写入完整、鉴权本地/生产分离明确、SSRF 与幂等有基础防护。未发现鉴权绕过或 SQL 注入。主要问题集中在：Worker 对 QC 失败的处理语义、幂等入队的并发竞态、以及若干防御性解析缺失。共 2 项高优先级、9 项中优先级、若干低优先级建议。

## 高优先级

### H1. Worker 渲染作业不检查 QC 结果，失败成片仍入库（已复核）

`render-worker/worker.ts` 的 `workRender`：`final` 渲染跑完 `runQc` 后，无论 `qc.status` 是否为 `passed`，都继续上传成片和封面（且 `x-rights-status: cleared`）、提交 QC 报告并把作业标记成功返回。

- 发布并不会因此绕过：`lib/control-plane.ts:571` 的 G6 门禁要求最新 `qc_reports.status === 'passed'` 且人工 QC 批准哈希绑定当前快照，所以 QC 失败仍会拦住 `QC_APPROVED`。
- 但后果是：QC 失败的成片作为 `render-output` 资产入库、作业状态显示成功，运维与工作台看到的信号是误导的；封面抽帧等后续开销也白做。

建议：`runQc` 结果非 `passed` 时，仍提交 QC 报告，但让作业以失败结束（或返回值中显式携带 `qcFailed`），避免"作业成功=成片可用"的错觉。

### H2. `enqueueJob` / `enqueueIngestionRun` 幂等检查与插入之间存在竞态（已复核）

`lib/control-plane.ts` 两处均为先 `SELECT ... WHERE idempotency_key = ?`、未命中再 `INSERT`。`idx_jobs_idempotency (kind, idempotency_key)` 唯一索引保证不会产生重复作业，但并发的同键请求中第二个会直接触发 UNIQUE 约束异常，向调用方抛出未处理错误（500），违背"相同键重放第一次结果"的幂等契约。

建议：捕获约束冲突后重新 `SELECT` 并按 `created: false` 返回既有作业；或改用 `INSERT OR IGNORE` + 回读。

## 中优先级

### M1. `lib/domain.ts` 本地 `stableHash` 是 32 位 FNV-1a，话题 ID 有碰撞风险（已复核）

`lib/domain.ts:117` 定义了模块内 `stableHash(value: string)`（FNV-1a，32 位），仅用于生成 `topic_<hash>` ID，与 `lib/hash.ts` 导出的 SHA-256 版 `stableHash` 同名但算法不同。功能上不冲突（模块局部函数），但：32 位哈希在数万级话题量下碰撞概率不可忽略，碰撞会把不同话题簇合并到同一 ID；同名也容易在后续维护中引发误用。建议改用 `hash.ts` 的 SHA-256 截断，或至少重命名为 `shortHash`。

### M2. `JSON.parse` 无防护（已复核 control-plane 两处）

- `lib/control-plane.ts:47`（`parseProject` 解析 `project_json`）与 `:780` 附近（`leaseNextJob` 解析 `payload_json`）：存储行损坏或历史数据不合法时抛未捕获异常；lease 路径尤其危险——一条坏作业会让整个租约接口反复 500，队列卡死。
- `lib/persistence.ts` 多处 `JSON.stringify`/`parse` 同样缺少防护（子审查报告，未逐一复核）。

建议：lease 路径对单条解析失败做隔离（标记该作业 `failed`/DLQ 并继续），读取路径给出带上下文的错误。

### M3. SSRF 校验对 IPv6 与非常规 IPv4 编码不完整（已复核）

`lib/source-adapters.ts:18` `assertPublicHttpUrl` 仅做主机名字符串检查：覆盖了 `localhost`、`127.*`、RFC1918、`169.254.*`、`::1`，但漏掉 IPv6 ULA（`fc00::/7`）、链路本地（`fe80::/10`）、IPv4 映射地址（`::ffff:127.0.0.1`）以及十进制/十六进制整数形式的 IPv4（如 `http://2130706433/`）。Worker 侧抓取前有 `dns.lookup` 私网检查兜底（`render-worker/worker.ts:98`），但控制面创建来源配置时只有这层字符串检查。建议解析出 IP 后统一按地址段判断，而不是匹配字符串前缀。

### M4. `team-members` 创建接口的幂等键不重放（子审查报告）

`app/api/v1/team-members/route.ts` 接受 `idempotency-key` 并写入审计，但创建前不查重放；网络重试会得到 409 而不是第一次的成功结果，与 experiments / source-configs 路由的行为不一致。

### M5. Schema 与迁移漂移：`evidence_links.article_revision_id` 的 ON DELETE（已复核）

`db/schema.ts:233` 声明 `onDelete: 'set null'`，但迁移 `drizzle/0013` 的 SQL 是裸 `REFERENCES article_revisions(id)`（默认 NO ACTION）。已应用该迁移的库中删除 `article_revisions` 行为与 schema 预期不一致。需要一条修正迁移（SQLite 需重建列或表）。

### M6. 租约 900 秒无心跳续约（子审查报告）

`render-worker/worker.ts` 租约固定 900 秒，长渲染超时后作业可能被另一 Worker 重复领取。至少一次语义下不算错误，但会浪费渲染成本并可能产生重复资产。建议渲染期间周期性续约。

### M7. `leaseNextJob` 查询缺匹配索引（子审查报告）

查询按 `kind IN (...) AND status` 过滤，现有 `idx_jobs_poll (status, available_at, created_at)` 不含 `kind`。当前数据量无感，作业表增长后建议加 `(kind, status, available_at)` 索引。

### M8. 迁移 0014 回填按 URL 精确匹配（已复核 SQL）

`a.url = evidence_links.source_url` 不做归一化，大小写、尾斜杠、query 参数差异都会导致静默漏回填。建议回填后跑一条统计（未匹配行数）并记录到运维文档，必要时补一轮归一化匹配。

### M9. render-worker 容器以 root 运行（子审查报告）

`render-worker/Dockerfile` 无 `USER` 指令。建议创建非特权用户运行 Node/Chromium/FFmpeg。

## 低优先级与建议

- `render-worker/worker.ts`：作业文件名直接使用 `job.id`。ID 由控制面生成（`job_<uuid>`）且接口有 token 鉴权，实际可利用性低，但加一个 `^[\w-]+$` 校验成本极低（纵深防御）。
- OpenAI 调用失败时可能把响应体原样写入错误/日志；建议只记录状态码与截断后的消息，避免上游回显敏感信息。
- `scripts/render-video.ts`、`scripts/generate-local-voice.ts`：输出路径来自 argv 无边界限制、临时文件用字符串替换生成。均为本地开发脚本，风险低，顺手可修。
- `scripts/media-qc.ts`：ffprobe/ffmpeg 输出用正则解析，格式变化时行为取决于 `Number.isFinite` 兜底方向；建议改为 `ffprobe -print_format json` 消除脆弱性（此条未复核失败方向）。
- `lib/control-plane.ts:519`：审计 `metadata_json` 解析失败时静默回退 `{}`，若非有意建议记录一次告警。

## 测试缺口

- 无 `leaseNextJob` / `finishJob` / 版本冲突（`VERSION_CONFLICT`）并发路径的测试；作业状态迁移与重复领取无覆盖。
- `test/webhook-auth.test.ts` 缺少缺失签名头、签名格式非法、空 body 的用例。
- H2 的并发幂等竞态正好是缺覆盖的场景，修复时应同步补测试。

## 未发现的问题类别

鉴权本地/生产分离（`resolveActor`）、角色-转换矩阵、ETag/If-Match、SQL 参数绑定、Worker token 与 HMAC 校验路径均未发现绕过。审计写入在复核过的变更路径上完整。

## 修复状态（2026-09-08 当日处理）

| 编号 | 处理 | 落点 |
| --- | --- | --- |
| H1 | 已修 | `render-worker/worker.ts` 在 `runQc` 结果非 `passed` 时仍提交 QC 报告，然后抛 `TerminalJobError`：不抽封面、作业以 `dead_letter` 结束、项目落 `FAILED`。`finishJob` 新增 `terminal` 入参，QC 这类确定性失败不再消耗重试预算。 |
| H2 | 已修 | `enqueueJob` / `enqueueIngestionRun` 捕获唯一索引冲突后回读既有作业并返回 `created: false`。 |
| M1 | 已修 | `lib/domain.ts` 的模块内哈希改为 SHA-256 截断 64 位并更名 `shortHash`，同时消除与 `lib/hash.ts` 的同名混淆。文章去重也走同一函数——32 位在数万条文章上必然生日碰撞。 |
| M2 | 已修 | `lib/control-plane.ts` 新增 `parseJsonColumn`；`leaseNextJob` 对损坏 payload 直接标 `dead_letter` 并返回 null（队列不再卡死），`parseProject` 报带项目 ID 的错误，审计 metadata 解析失败记一次告警。`lib/persistence.ts` 原本已有 `parseJson` 兜底，无需改动。 |
| M3 | 已修 | 新增 `lib/net-guard.ts`：解析出 IP 后按地址段判断，覆盖 IPv6 ULA/链路本地/组播、IPv4 映射、NAT64、6to4、CGNAT 与 0/8、224/4、240/4。控制面与 Worker 共用同一份判定。十进制/十六进制 IPv4 由 WHATWG `URL` 归一化后已被覆盖，此处一并加了回归用例。 |
| M4 | 已修 | `app/api/v1/team-members` 创建接口按审计事件里的幂等键重放第一次结果。 |
| M5 | 已修 | `drizzle/0015` 重建 `evidence_links`，把 `article_revision_id` 的外键补成 `ON DELETE SET NULL`；`drizzle-kit generate` 现在与 `db/schema.ts` 零差异。 |
| M6 | 已修 | 新增 `POST /api/v1/jobs/{id}/heartbeat` 与 `renewJobLease`；Worker 每 120 秒续约。 |
| M7 | 已修 | `db/schema.ts` 与 `drizzle/0015` 增加 `idx_jobs_kind_status_available (kind, status, available_at)`。 |
| M8 | 已修 | `drizzle/0015` 补一轮忽略大小写与尾斜杠的回填；未匹配行数的统计查询写进运行手册“迁移后核对”。查询参数差异仍是已知残留。 |
| M9 | 已修 | `render-worker/Dockerfile` 创建非特权用户 `signal40` 并 `USER signal40`。 |
| 低-作业 ID | 已修 | Worker 用 `assertSafeJobId` 校验 `^[\w-]{1,128}$` 后才拼进文件名。 |
| 低-上游回显 | 已修 | `describeUpstream` 只保留状态码与截断到 200 字符的消息。 |
| 低-脚本路径 | 已修 | `scripts/output-path.ts` 把 argv 输出路径限制在仓库内；本地配音的中间 AIFF 改用独立临时目录，不再靠扩展名字符串替换。 |
| 低-ffprobe | 无需处理 | `scripts/media-qc.ts` 早已用 `ffprobe -of json`；剩下的正则只解析 `blackdetect`/`volumedetect`/`silencedetect`，这些滤镜没有 JSON 输出。 |
| 低-审计元数据 | 已修 | 解析失败时记一次 `console.warn`，不再静默回退。 |
| 测试缺口 | 已补 | `test/control-plane.test.ts`（在进程内真 PostgreSQL 上重放 `drizzle/` 迁移，覆盖租约、续约、重复领取、重试与终态失败、损坏 payload 隔离、幂等竞态、`VERSION_CONFLICT`）、`test/net-guard.test.ts`、`test/webhook-auth.test.ts` 的缺失/非法签名与空 body 用例。 |
