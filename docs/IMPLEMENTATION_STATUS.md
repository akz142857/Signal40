# Signal 40 实施与验收矩阵

更新时间：2026-09-08（含当日代码审查修复）

`Implemented` 表示代码和本地自动化证据存在；`Accepted` 还要求目标环境、真实供应商、渠道和责任人完成验收。

| 阶段 | 能力 | 实现状态 | 代码/本地证据 | 外部验收 |
| --- | --- | --- | --- | --- |
| P0 | 角色、G0–G8、状态机、ETag、SHA-256 审批 | Implemented | `lib/workflow.ts`、工作台、状态机测试 | Sites 身份与团队成员实测 |
| P0 | project.json 2.0 / 1.0 兼容 | Implemented | Schema、迁移脚本、协议测试 | 历史项目批量演练 |
| P0 | 数据库/对象存储/作业/审计 | Implemented | PostgreSQL 32 表、直接/分片上传、对象级短时读取、`FOR UPDATE SKIP LOCKED` 租约与心跳续约/DLQ、项目级声明 ID | 托管 PostgreSQL/S3 与保留策略 |
| P1 | 来源、调度、滚动聚类、修订 | Implemented | RSS/Atom、HTTP JSON、CSV/OpenCLI、UTC Cron、滚动限流、72h 语料、article revisions、显式授权确认、精确幂等重放、授权原文保留与自动清理 | 至少三类真实授权来源 |
| P1 | Claim/Evidence/ResearchSnapshot | Implemented | 支持/反驳、冲突、快照、独立批准 | 财经编辑真实题材验收 |
| P2 | 脚本与分镜 | Implemented | 逐句声明、版本比较、评论/锁定、读音、连续帧、动态图表 | 品牌规范和模板冻结 |
| P3 | 资产、TTS、字幕 | Implemented | 版权元数据、OpenAI TTS、逐词对齐、字幕安全区、可选版权音乐与音量混合 | API key、授权声音与素材政策 |
| P3 | Remotion 渲染 | Implemented | 三个版本化视觉模板、Player、真实转场/屏幕文字/来源脚注、低码率预览、正式片 Worker、Docker、并发/预算、封面 | 部署池、许可证和金丝雀 |
| P4 | 自动/人工 QC | Implemented | 24 类媒体/内容/混音/关键帧检查、哈希绑定 QC、旁白覆盖门禁和独立批准、QC 失败即终态失败作业 | 人工终审责任人签字 |
| P4 | 发布、更正和下架 | Implemented | 发布包（已端到端验证：真实成片 → 清单落对象存储 → 人工确认分发 → PUBLISHED）、YouTube 续传与 private fail-safe（**尚未端到端验证**）、HMAC 回调、事件与下架 | YouTube 测试频道实测；`SIGNAL40_ALLOW_PUBLIC_PUBLISH` 的开放决策 |
| P5 | 指标与实验 | Implemented | 2h/24h/7d 快照、版本/实验归因、确定性 A/B、校准审批及 `/governance` 操作台 | 真实指标口径与四周阈值校准 |
| P5/P6 | SLO、成本、容量、灾备 | Implemented locally | `/operations`、`/health`、DLQ 重放、CI、备份恢复和运行手册 | 托管告警、远端恢复和季度演练 |
| UI-P0 | 常驻 Worker、系统自检、无 Worker 告警、脚本时长前置校验 | Implemented | compose 的 `control-plane`/`render-worker`/`scheduler` 服务、`workers` 心跳表、`/settings/diagnostics` 与 `GET /api/v1/diagnostics`、项目页孤儿作业告警、`lib/script-duration.ts` | 目标环境的常驻部署与告警接入 |
| UI-P1a | 选题质量指标 | Implemented | `lib/topic-quality.ts`（簇内一致性、证据对应唯一性、语言与词表匹配度）写入 `topics.quality_json`，不达标进待办箱 | 有授权的中文来源上的阈值校准 |
| UI-P1b | 调度器进程与编排引擎 | Implemented | `scripts/scheduler.ts` + `lib/orchestrator.ts`（短锁选集合、每轮有界、幂等键、熔断、只走状态机）、`automation_runs`、`test/orchestrator.test.ts` | 连续无人值守运行的观察期 |
| UI-P2 | 自动化策略、待办箱、控制台、通知 | Implemented | `automation_policies`（双授权人互斥、预先授权有效期）、`attention_items` 与 HMAC 通知、`/automation`、`/inbox`、人工编辑与内容事件自动暂停 | 组织指定的授权人与通知渠道 |
| UI-P3 | 生产身份 | Implemented（依赖外部代理） | 身份头可配（`SIGNAL40_IDENTITY_HEADER_*`）、`SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false` 关闭本机伪造、界面改用 `/api/v1/session` 的真实身份 | **认证反向代理或 OIDC 身份源本身不在本仓库内**；G7 的两个批准人必须是不同真实账号 |

## 真实数据端到端验证（2026-09-08）

用 6 个公开财经 RSS 源的 100 篇真实文章跑通了 G0–G8 全流程：选题聚类与核验、项目创建、
OpenAI TTS 配音与逐词字幕、Remotion 渲染、24 项自动 QC 全通过、独立发布人批准、
`package` 渠道发布包产出、人工确认分发、指标回流至 `MEASURED`。产物（音轨、成片、封面、
发布包清单）全部落在 Cloudflare R2。

这次验证覆盖的是**流水线**，不是选题质量。当次选题聚类把 97 篇英文文章合并成了一个话题，
三条声明的证据没有区分度——`lib/domain.ts` 的分词与财经词表是按中文语料调的，
英文源上基本失效。要评估选题质量需要接入有授权的中文来源。

这个问题现在是**可度量**的：`lib/topic-quality.ts` 把簇内一致性、声明与证据的对应唯一性、
语言与词表匹配度写进 `topics.quality_json`，英文簇会被直接判为不可自动化。
度量只是闸门，不是修复——当前的建项目规则仍然把整簇文章挂给每一条声明，
因此在聚类与证据绑定改进之前，**自动建项目在默认策略里是关闭的**，
不达标的选题只进待办箱，人依旧可以手工建项目。

`youtube` 渠道未在本次验证范围内，仍属于未验证路径。

## 自动化评估边界

仓库提供 100 个覆盖财报、商品、宏观、公司公告和市场传闻的确定性回归场景，验证门禁契约。它明确标记为 synthetic regression，不替代“100 个真实历史事件 + 权威证据 + 冲突 + 可接受表达”的人工金标和盲评。

## 当前不能宣称 Accepted 的项目

- 没有获得 Sites 源码上传/发布授权；远端迁移、访问控制和浏览器回归未执行。
- 没有生产 OpenAI Secret、声音权利证明、YouTube OAuth 测试账号和实际渠道返回 ID。
- 没有组织指定的财经终审、品牌/素材权利、Remotion 商业许可、月预算与保留期限决策。
- 备份/恢复脚本（`pg_dump`/`pg_restore` + 隔离库演练）已交付，但生产库的时间点恢复、对象存储生命周期、供应商切换和季度演练需要目标环境。

作业队列的租约、续约、重复领取、终态失败与损坏 payload 隔离由 `test/control-plane.test.ts` 覆盖，测试直接在进程内的真 PostgreSQL（PGlite）上重放 `drizzle/` 迁移，schema 与迁移漂移、以及 SQL 方言问题都会在测试里暴露。

当前 Worker 作业层使用 PostgreSQL 事务化租约（`SELECT ... FOR UPDATE SKIP LOCKED`）、心跳续约、退避和死信状态，已经满足本地与单团队部署的至少一次执行语义。若目标环境改用专用消息队列，需要在 staging 加入队列/DLQ 适配器和远端投递验收；本文不把尚未创建的队列资源描述为已实现。
