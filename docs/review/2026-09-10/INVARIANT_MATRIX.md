# Signal 40 核心不变量追踪矩阵

> 结论词：`Pass locally` 表示本地代码和自动化证据成立；`Partial` 表示仅部分调用路径成立；`Blocked` 表示已发现反例；`External pending` 表示需要目标环境或真实系统证据。

| 不变量 | 权威实现 | 当前测试/证据 | 结论 | 缺口或关联发现 |
| --- | --- | --- | --- | --- |
| 状态不能跳转，角色必须允许目标状态 | `lib/workflow.ts:54-102`、`lib/control-plane.ts:353-429` | workflow/control-plane 测试；服务端 `assertTransition` | Pass locally | 真实身份代理尚未验收 |
| 状态写入必须受 expectedVersion 约束 | `lib/control-plane.ts:369-396` | PG 集成测试；SQL `WHERE id/version` | Pass locally | 需路由级并发覆盖 |
| 门禁必须由服务端当前数据计算 | `lib/control-plane.ts:909-1151` | gate/evaluation 测试；100 synthetic 场景通过 | Pass locally | synthetic 不等于真实财经金标 |
| G3/G4/G6/G7 批准绑定当前哈希 | `lib/control-plane.ts:1083-1144` | approval/gate 测试 | Pass locally | 目标环境审计与真实签字待验收 |
| G7 研究与发布批准人不同 | `lib/control-plane.ts:1134-1144` | workflow/approval 测试 | Pass locally | 两个真实账号和代理身份映射未执行 |
| 人工变更暂停自动化 | `lib/control-plane.ts:418-423` 及各写路径 pause statement | 自动化回归测试 | Pass locally | 浏览器操作链尚未验收 |
| 自动化批准后重新计算门禁 | `lib/orchestrator.ts:1134-1198` | orchestrator 测试 | Pass locally | 无人值守观察期未开始 |
| 同项目自动推进不能并发执行 | `lib/orchestrator.ts:1595-1665` | PG 行锁/事务测试 | Pass locally | 真实多 Scheduler/多进程强杀未执行 |
| Worker 完成必须匹配 status/owner/epoch/expiry | `lib/job-lease.ts:8-19` | `test/job-lease.test.ts:13-54` | **Blocked** | 来源路径使用较完整；Render 结果路由违反，见 REV-P1-02 |
| Worker 只能读取当前作业需要的数据 | 应由内部 Worker 协议保证 | 无 Render 读取集成测试 | **Blocked** | Render Worker 正常拓扑读取失败，见 REV-P1-01 |
| 同幂等键同请求精确重放、不同请求冲突 | `lib/idempotency.ts:42-115` | helper 与少数来源路由测试 | **Partial** | 项目、指标、实验、作业违反，见 REV-P1-05 |
| 来源分页不得断页、伪造 final 或倒写 checkpoint | 来源 page/complete/commit 路由与 materialization helpers | `npm run source:chaos` 10/10；page protocol 测试 | Pass locally | 真实远端与进程级 chaos 待验收 |
| 旧租约接管后不能修改来源快照 | 来源租约校验与事务提交 | 固定 seed `expired-lease-takeover-and-old-epoch-fence` 通过 | Pass locally | Render 路径未复用同一不变量 |
| 外部 URL 不得访问私网或通过重定向绕过 | `render-worker/worker.ts:275-354` | URL policy/SSRF 测试 | Pass locally | 目标网络策略、代理旁路和真实 remote IP 证据待验收 |
| production 缺身份或 Secret 必须 fail-closed | `lib/workload-env.ts:32-58` 部分覆盖 | workload env 单测 | **Blocked** | 控制面本地身份/Worker/media fallback 未受 production 硬约束，见 REV-P1-03 |
| 发布结果必须来自当前受权发布执行 | 发布任务、G7、Worker complete | G7 测试；无完整路由/外部集成 | **Blocked** | complete 缺租约 owner/epoch/expiry，YouTube 未真实验收 |
| 数据库恢复必须可重复且不覆盖源库 | `scripts/restore-drill.sh`、`restore-local.sh` | 本次真实执行 | **Blocked** | Docker PG 客户端回退 exit 141，见 REV-P1-04 |
| 敏感值不得进入客户端/扫描面 | diagnostics DTO、Canary 脚本 | `source:sensitive-canary` 通过 | Pass locally | 真实浏览器 HAR、日志、trace、镜像尚未验收 |

## 结论

状态机与来源协议的局部不变量质量明显高于 Render Worker 和通用 API 写路径。下一轮整改应优先让 Render Worker 复用已存在的 `activeLeaseMatches` 语义，并让全部写路由复用同一个幂等框架；否则“library 层正确”仍不能证明实际 HTTP 协议正确。
