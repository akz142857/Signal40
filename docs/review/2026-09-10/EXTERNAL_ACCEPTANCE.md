# Signal 40 外部集成与生产验收缺口

> 原则：代码、mock、PGlite、本地桶或 synthetic 数据只支持 `Implemented locally`。没有目标环境和真实外部回执时，不提升为 `Integrated` 或 `Accepted`。

## 1. 验收矩阵

| 能力 | 当前证据 | 当前状态 | 关闭条件 | 建议责任人 |
| --- | --- | --- | --- | --- |
| 认证反向代理 | 可配置身份头、团队成员与 RBAC 实现 | Implemented locally / Blocked | 修复 REV-P1-03；两个不同真实账号完成身份映射、越权负测与 G7 异人审批 | Platform + Security + Product |
| 托管 PostgreSQL | 33 个迁移 checksum、本地 PGlite/开发库证据 | Implemented locally | staging 从已发布旧版本升级、重复 migrate、回滚决策、备份/PITR 与审计连续性证据 | DBA/SRE |
| 数据库恢复 | 脚本和安全守卫存在 | **Blocked** | 修复 REV-P1-04；在目标等价环境完成隔离恢复、55 表对账、RTO/RPO 记录 | SRE |
| Cloudflare R2 | 历史开发桶证据；本次 3 项契约测试未执行 | External pending | 轮换凭据后，以隔离测试桶完成 put/get/list/delete、multipart、checksum、metadata、保留与孤儿清理 | Platform + Security |
| OpenAI TTS/ASR | 适配器与本地流程代码存在 | External pending | 生产 Secret、授权声音、配额/429、成本、超时、失败降级和审计证据 | Product + Legal + Platform |
| Remotion/FFmpeg | 本次三个模板与 2 秒预览冒烟通过 | Implemented locally | 修复 Render Worker P1；部署池完成真实 45 秒成片、并发、资源上限、24 类 QC 与许可证确认 | Media + SRE + Legal |
| YouTube | 续传与 private fail-safe 代码存在 | External pending / Blocked | 修复租约栅栏；测试频道 private 上传返回真实 ID，响应丢失不重复发布，更正/下架走通 | Publishing + Security |
| package 渠道 | 历史本地 E2E 记录 | Implemented locally | 当前提交、目标存储与真实审批链重新生成清单并人工确认分发 | Publishing |
| OpenCLI / Browser Bridge | 锁定二进制和候选搜索代码存在 | External pending | 连接真实受权账号/Bridge，保存命令隔离、失败行为、publisher identity 和 run IDs | Source Owner + Security |
| RSS/Public JSON/网页来源 | 适配器、本地分页与 chaos 证据 | External pending | 每种实际启用来源提供权利批准、真实 run/page/checkpoint/provenance、限流/变更/失败证据 | Editorial + Source Owner |
| Social Evidence | synthetic 与本地分类/匹配回归 | External pending | 版本化授权中文标注集、误独立率/召回率报告、生产抽样及 Product/Editorial 签字 | Data + Editorial |
| Secret/镜像隔离 | 本地 Canary 通过；CI 定义镜像扫描和 env 矩阵 | External pending | 当前 commit 的远端镜像 digest、SBOM、Trivy、非 root/只读、实际 Secret 可见矩阵 | Security + Platform |
| 监控与告警 | `/health`、`/operations`、SLO 代码和 runbook | External pending | 外部探针、真实值班目标、HMAC 通知、DLQ/5 分钟失败/80% 预算演练 | SRE |
| 28 天观察 | 策略已定义 | Not started | 迁移、来源、告警和责任人先签字；连续真实窗口满足样本量和 burn-rate 规则 | Product + SRE + Editorial |

## 2. 本次不能宣称的结论

- 不能因本地 265 项测试通过而宣称 R2 已验收；3 项远端契约没有在本次环境运行。
- 不能因本地 Remotion 冒烟通过而宣称 Render Worker 已集成；当前正常拓扑存在项目读取和租约栅栏阻断。
- 不能因 YouTube 适配代码存在而宣称发布可用；没有真实测试频道 ID，完成接口还存在旧租约写入风险。
- 不能因 synthetic `gateAccuracy=1` 而宣称财经事实质量或 Social Evidence 已接受。
- 不能因 CI YAML 声明扫描步骤而宣称当前提交镜像已扫描；需要具体 run、digest 和报告。
- 不能因恢复脚本存在而宣称灾备通过；本次可重复演练实际失败。

## 3. 建议证据包

每个外部验收项至少保存：目标环境与版本、开始/结束时间、操作者、非敏感配置摘要、输入数据范围、外部返回 ID、关键日志/截图、数据库前后状态、失败注入结果、回滚结果、已知限制和签字人。Secret、完整签名 URL、OAuth token、原始敏感载荷不得进入证据包。

外部验收应在 P1 修复并完成 Re-review 后开始，避免用尚未冻结的协议产生不可复用证据。
