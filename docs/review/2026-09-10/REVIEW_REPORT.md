# Signal 40 发布就绪性 Review 报告

> 报告状态：本地整改与定向 Re-review 已完成
> Review commit：`8b408021c9305b1a23ef0797efe9f7e80ac99799`
> Review 日期：2026-09-10
> 当前决策：**代码整改通过；完成目标环境验收与 Worker 协议升级后可进入发布决策**

## 1. 管理层摘要

核心 G0–G8 状态机、版本条件写入、审批哈希绑定、G7 异人审批、自动化行锁及来源分页提交在代码与现有测试中具有较强证据；本地 lint、类型检查、OpenAPI Lint、272 项非 R2 测试、3 项联网 R2 契约测试、100 项合成评估、33 个迁移校验、构建和隔离恢复演练均通过。

第一轮 Review 确认的 **6 个 P1** 和 **4 个 P2/P3** 已完成本地整改。Render Worker 现在使用 job-scoped 项目读取协议；资产、配音、QC 与发布完成同时绑定 owner、epoch、expiry，并对响应丢失精确重放；生产控制面缺少专用 token、媒体签名或身份头配置时启动失败；Docker 回退恢复演练已通过；四条高风险业务幂等路径已统一使用 request hash reservation；关键 Handler 已纳入真实 HTTP → PostgreSQL 测试。

当前代码可以标记为 `Implemented locally`。这不等同于 `Deployed`、`Integrated` 或 `Accepted`：真实认证代理双账号、OpenAI TTS、YouTube、OpenCLI、目标环境告警与 28 天 SLO 观察仍需按外部验收计划执行；Worker lease DTO 是有意的内部协议破坏性升级，控制面与 Render Worker 必须同批发布。

## 2. 原发布阻断项整改状态

| ID | 级别 | 结论 | 发布前完成条件 |
| --- | --- | --- | --- |
| REV-P1-01 | P1 | Closed locally | job/token/owner/epoch/expiry/project/kind 共同授权；路由级正反测试通过 |
| REV-P1-02 | P1 | Closed locally | 资产、配音、QC、发布写入原子围栏；旧 epoch 与不同结果被拒，响应丢失可重放 |
| REV-P1-03 | P1 | Closed locally | production 禁用全部本地 fallback，必需信任边界配置在启动时 fail-closed |
| REV-P1-04 | P1 | Closed locally | Docker `psql` stdin 回退修复；隔离恢复及 56 表逐表核对通过，源库未修改 |
| REV-P1-05 | P1 | Closed locally | 项目、实验、作业、指标均使用请求哈希 reservation，并覆盖同体重放/异体冲突 |
| REV-P1-06 | P1 | Closed locally | Worker 读取/回写和四条幂等业务路由已执行真实 Handler → PGlite/PostgreSQL 测试 |

## 3. P2/P3 整改状态

| ID | 级别 | 结论 | 建议目标 |
| --- | --- | --- | --- |
| REV-P2-01 | P2 | Closed locally | CI 已增加独立 `tsc --noEmit` step |
| REV-P2-02 | P2 | Closed locally | 三类宽度 token、共享页头/导航、active 状态、移动 Sheet 已落地并完成 375/1440 浏览器回归 |
| REV-P2-03 | P2 | Closed locally | OpenAPI 建模认证代理 session → 双身份头链路及 Worker lease DTO |
| REV-P3-01 | P3 | Closed locally | diagnostics 只读取集中且脱敏的 runtime config 投影 |

## 4. 正向结论

- 状态推进由服务端 `assertTransition`、服务端门禁和 `WHERE id/version` 条件写入共同约束。
- G3、G4、G6、G7 批准均与当前研究、脚本或不可变成片哈希绑定；G7 检查研究与发布批准人不同。
- 自动化在批准后重新计算门禁，且单项目完整推进受 `FOR UPDATE SKIP LOCKED` 行锁保护。
- 来源 Worker 的分页、checkpoint、ACK 丢失、事务回滚、过期租约接管与旧 epoch 写入已有固定 seed 可执行证据。
- 外部 URL 获取实现包含 DNS 解析、私网拒绝、实际 socket pin、逐跳重定向、超时和响应大小限制。
- 敏感信息 Canary、迁移 checksum、OpenAPI baseline 与本地渲染模板均具备可执行证据。

## 5. 状态判断

| 能力 | 当前可支持状态 | 原因 |
| --- | --- | --- |
| G0–G8 与审批核心 | Implemented locally | 实现及本地测试存在；真实身份双账号和目标环境未验收 |
| 来源分页与本地故障语义 | Implemented locally | 10/10 PGlite chaos 通过；真实进程/网络/R2 chaos 未执行 |
| Render Worker 端到端 | Implemented locally | job-scoped 读取、全副作用租约围栏与响应重放测试通过；目标环境尚未集成验收 |
| 数据恢复 | Implemented locally | Docker 客户端回退与隔离恢复通过；目标环境恢复仍待执行 |
| R2/OpenAI/YouTube/OpenCLI | Not Accepted | 缺当前提交、目标环境、真实账号或真实上游的可追溯证据 |
| UI 宽度与导航统一 | Implemented locally | 页面统一为 Standard/Wide/Workspace；共享桌面与移动导航已完成本地浏览器回归 |

## 6. 建议整改顺序

1. 先修复 Render Worker 的租约绑定读取和全部副作用回写，补旧 epoch/过期租约/错误项目负向测试。
2. 关闭 production 本地 fallback，并用无 Secret、伪造 Host/角色头、代理身份缺失场景验证 fail-closed。
3. 统一幂等框架并覆盖项目、作业、指标、实验、发布等关键接口。
4. 修复 Docker 恢复回退，保留成功恢复后的逐表对账证据。
5. 扩充关键路由执行测试；同时把 typecheck 加入 CI。
6. 建立 `PageShell/PageHeader/GlobalNav`（或等价组件）及 Standard/Wide/Workspace token，再做八页桌面与移动端截图回归。
7. 最后进入目标环境 R2、OpenAI、YouTube、认证代理、OpenCLI、告警和 28 天观察验收。

## 7. Review 产物

- [自动化与环境基线](./BASELINE.md)
- [完整技术发现](./FINDINGS.md)
- [核心不变量追踪矩阵](./INVARIANT_MATRIX.md)
- [UI 宽度与导航一致性](./UI_CONSISTENCY.md)
- [外部集成与生产验收缺口](./EXTERNAL_ACCEPTANCE.md)

整改后的逐项证据、命令结果和残余发布约束见 [Re-review 记录](./RE_REVIEW.md)。
