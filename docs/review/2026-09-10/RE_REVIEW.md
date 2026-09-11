# Signal 40 整改 Re-review 记录

> 原始 Review 基线：`8b408021c9305b1a23ef0797efe9f7e80ac99799`
> Re-review 日期：2026-09-10
> 结论：10 项代码发现均已完成本地整改；外部集成与目标环境验收保持独立状态

## 1. 发现关闭矩阵

| ID | 状态 | 修复与证据 |
| --- | --- | --- |
| REV-P1-01 | Closed locally | Render Worker 的项目 GET 携带 token、jobId、workerId、leaseEpoch；服务端校验当前租约、项目与 kind。`critical-routes.test.ts` 覆盖成功和旧 epoch。 |
| REV-P1-02 | Closed locally | 资产、配音、QC、发布完成均在最终 SQL 中校验 owner、epoch、expiry、status、project、kind；同结果精确重放，不同结果 409。 |
| REV-P1-03 | Closed locally | production 不再接受 hostname 激活的角色、Worker 或媒体固定 Secret；启动时要求两类不同专用 Worker token、至少 32 字符媒体 Secret 和显式身份头配置。 |
| REV-P1-04 | Closed locally | Docker PG 客户端增加交互 stdin；恢复演练成功恢复并逐表核对 56 张表，自动清理隔离库且确认源库未修改。 |
| REV-P1-05 | Closed locally | 项目、实验、作业、指标统一采用 `idempotency_records` 请求哈希 reservation；业务写、审计和完成响应在同一事务内。 |
| REV-P1-06 | Closed locally | 新增关键路由真实 Handler → PostgreSQL 测试，覆盖 Worker 读取、资产、配音、QC、发布、项目、实验、作业和指标。 |
| REV-P2-01 | Closed locally | CI application job 增加独立 TypeScript typecheck。 |
| REV-P2-02 | Closed locally | 共享页面壳、三类宽度 token、唯一导航配置、active/`aria-current`、移动端 Sheet 与项目层级提示已落地。 |
| REV-P2-03 | Closed locally | OpenAPI 描述 edge session 到可信双身份头的认证链；Worker 请求定义 owner/epoch DTO 及 job-scoped 内部替代认证。 |
| REV-P3-01 | Closed locally | diagnostics 从 runtime 的脱敏配置投影读取，不再直接访问环境变量。 |

## 2. 自动化与实测证据

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 通过 |
| `npm exec tsc -- --noEmit` | 通过 |
| `npm run build` | 通过，93 个 API route 完成构建 |
| `npm run db:migrations:verify` | 通过，33 个迁移 checksum |
| `npm run openapi:lint` | 通过 |
| 核心路由、生产配置和页面壳定向测试 | 9/9 通过 |
| 全量本地测试 | 272/275；3 项仅因默认沙箱 DNS 无法访问 R2 |
| R2 契约测试（允许网络后单独复跑） | 3/3 通过；合并结论为 275/275 |
| Docker 隔离恢复演练 | 通过，56 表逐表行数一致，源库未修改；对象清单因当前环境不可用而跳过 |
| 1440px / 375px 浏览器回归 | 七个一级页面无横向溢出，宽度、导航、active 与移动 Sheet 通过 |

## 3. 有意的兼容性变化

Render Worker 的 `voice-tracks`、`qc-reports`、`publish-jobs/{id}/complete` 请求新增必需 `workerId` 与 `leaseEpoch`。这是关闭旧 Worker 越权回写所必需的内部协议升级，`openapi:breaking` 会相对已发布 baseline 报告 6 项 schema 结构变化。不得刷新不可变 baseline 来隐藏变化；发布时应：

1. 将控制面与本仓库 Render Worker 作为同一发布单元部署。
2. 先停止旧 Worker 领取新作业，再升级控制面和 Worker，最后恢复领取。
3. 在发布清单记录 Worker 协议升级和 artifact digest；下一次真实版本发布后再按既有流程建立新的不可变 baseline。

CI 通过 `contracts/openapi.breaking-allowlist.yaml` 对上述 6 条结果做精确审批：审批文件绑定当前不可变 baseline 的 SHA-256，新增 breaking change 或已经失效的审批都会继续让门禁失败。这不是刷新 baseline；审批只覆盖本次内部 Worker 协议的协调升级，并应在下一次真实版本发布、重建 baseline 后删除。

## 4. 残余验收边界

本轮证明的是 `Implemented locally`。下列事项不是代码发现复开，而是进入 `Integrated / Accepted` 所需的外部证据：真实认证代理双账号与 G7 异人审批、OpenAI TTS 授权声音、YouTube 测试频道续传/下架、OpenCLI 真实账号、目标环境 R2 保留/恢复、告警链路、目标环境恢复演练和 28 天 SLO 观察。详情见 [EXTERNAL_ACCEPTANCE.md](./EXTERNAL_ACCEPTANCE.md)。
