# Signal 40 实施与验收矩阵

更新时间：2026-09-09（含数据源订阅、来源维护责任与本地验收账本）

交付状态统一为 `Implemented locally → Delivered → Deployed → Integrated → Accepted`；`Blocked/Experimental` 是正交标签。`Implemented locally` 只表示代码和本地自动化证据存在，`Accepted` 还要求目标环境、真实上游、渠道和责任人完成验收。不使用“Integrated locally”。

| 阶段 | 能力 | 实现状态 | 代码/本地证据 | 外部验收 |
| --- | --- | --- | --- | --- |
| P0 | 角色、G0–G8、状态机、ETag、SHA-256 审批 | Implemented | `lib/workflow.ts`、工作台、状态机测试 | 认证反向代理与团队成员实测 |
| P0 | project.json 2.0 / 1.0 兼容 | Implemented | Schema、迁移脚本、协议测试 | 历史项目批量演练 |
| P0 | 数据库/对象存储/作业/审计 | Implemented locally | PostgreSQL 55 表、直接/分片上传、对象级短时读取、`FOR UPDATE SKIP LOCKED` 租约、lease epoch、legal-hold epoch、整数 capability protocol、心跳续约/DLQ、项目级声明 ID | 托管 PostgreSQL/S3 与保留策略、混合 Worker 部署演练；`0023`–`0031` 尚未在开发/生产 PostgreSQL 升级 |
| P1 | 来源、调度、滚动聚类、修订 | Foundation 整体 In progress；五种公开来源入口均为 `Implemented locally`，未 Delivered/Deployed/Integrated/Accepted | draft/test/enable、权利异人审批、RSS/Atom、Public JSON 分页与 staged visibility、公开网页 JSON-LD/可见链接解析、公众号/小红书公开 Feed、统一 SSRF/限额、checkpoint、退避、SLO、预算、canary/shadow、运行隔离、业务负责人治理，以及 `0031` 对凭据 Broker/OAuth 预留的删除 | 真实 RSS/Public JSON/网页/公众号 Feed/小红书 Feed、跨角色浏览器、开发/生产迁移恢复、目标环境 chaos、安全扫描和 28 天观察 |
| P1 | Claim/Evidence/ResearchSnapshot | Implemented | 支持/反驳、冲突、快照、独立批准 | 财经编辑真实题材验收 |
| P2 | 脚本与分镜 | Implemented | 逐句声明、版本比较、评论/锁定、读音、连续帧、动态图表 | 品牌规范和模板冻结 |
| P3 | 资产、TTS、字幕 | Implemented | 版权元数据、OpenAI TTS、逐词对齐、字幕安全区、可选版权音乐与音量混合 | API key、授权声音与素材政策 |
| P3 | Remotion 渲染 | Implemented | 三个版本化视觉模板、Player、真实转场/屏幕文字/来源脚注、低码率预览、正式片 Worker、Docker、并发/预算、封面 | 部署池、许可证和金丝雀 |
| P4 | 自动/人工 QC | Implemented | 24 类媒体/内容/混音/关键帧检查、哈希绑定 QC、旁白覆盖门禁和独立批准、QC 失败即终态失败作业 | 人工终审责任人签字 |
| P4 | 发布、更正和下架 | Implemented | 发布包（已端到端验证：真实成片 → 清单落对象存储 → 人工确认分发 → PUBLISHED）、YouTube 续传与 private fail-safe（**尚未端到端验证**）、HMAC 回调、事件与下架 | YouTube 测试频道实测；`SIGNAL40_ALLOW_PUBLIC_PUBLISH` 的开放决策 |
| P5 | 指标、实验与 Social Evidence | Implemented locally / external acceptance pending | 2h/24h/7d 快照、版本/实验归因、确定性 A/B；Social Evidence 保守关系分类器、最大匹配、unknown/低置信度 fail closed、publisher entity、不可变 origin 人工修正、声明级合格支持门禁、数据集哈希/误独立率/召回率/生产抽样冻结审批及 `/governance` 操作台 | 已授权版本化标注集、真实评测报告与生产抽样、Product/Editorial 签字；此前通用 synthetic 回归不计为 Social Evidence 金标 |
| P5/P6 | SLO、成本、容量、灾备 | Implemented locally | `/operations`、`/health`、DLQ 重放、CI、备份恢复和运行手册 | 托管告警、远端恢复和季度演练 |
| UI-P0 | 常驻 Worker、系统自检、无 Worker 告警、脚本时长前置校验 | Implemented locally | compose 常驻服务、独立 Worker 注册心跳、诊断页、项目页定时刷新孤儿作业、自动脚本按 `narrationBudget` 生成 | 目标环境的常驻部署与告警接入 |
| UI-P1a | 选题质量指标 | Implemented locally | 质量 JSON 会在选题更新时失效重算；雷达显示一致性、区分度、语言、词表覆盖和 0–100 综合分；策略支持数值下限 | 有授权的中文来源上的阈值校准 |
| UI-P1b | 调度器进程与编排引擎 | Implemented locally | 项目行锁覆盖完整推进事务；作业/发布/API 单轮上限、阶段熔断、分窗口指标提醒、过期策略转人工及回归测试 | 连续无人值守运行的观察期 |
| UI-P2 | 自动化策略、待办箱、控制台、通知 | Implemented locally | 可审计全局暂停、创建时策略成本归因、强制 HMAC 通知、自动/人工比例、按类型积压、内容事件创建/关闭与人工写入自动暂停 | 组织指定的授权人与通知渠道 |
| UI-P3 | 生产身份 | Application ready; not accepted | 所有选题路由统一走服务端身份策略；身份头可配，本机角色模拟可关闭，界面读取 `/api/v1/session` | **认证反向代理或 OIDC 身份源本身不在本仓库内**；需两个不同真实账号完成 G7 回归 |

## 真实数据端到端验证（2026-09-08）

用 6 个公开财经 RSS 源的 100 篇真实文章跑通了 G0–G8 全流程：选题聚类与核验、项目创建、
OpenAI TTS 配音与逐词字幕、Remotion 渲染、24 项自动 QC 全通过、独立发布人批准、
`package` 渠道发布包产出、人工确认分发、指标回流至 `MEASURED`。产物（音轨、成片、封面、
发布包清单）全部落在 Cloudflare R2。**该批次通过历史脚本/手工 ingest 路径准备语料，不是新的 source draft/test/enable/scheduler/checkpoint 订阅链路验收**；没有绑定新链路的可追溯 run IDs 时，只能作为历史本地流水线演示。

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

- 生产认证反向代理、远端迁移、访问控制和浏览器回归未执行。
- 公众号/小红书公开 Feed 与网页/热榜连接器代码已完成本地实现；剩余是逐来源真实 URL、权利与浏览器验收。Social Evidence 的关系分类、人工修正和门禁代码已完成，仍需真实授权评测集、生产抽样与 Product/Editorial 签字；自动放行保持关闭。Foundation 尚未完成真实来源、生产 egress、成员离职恢复、目标环境 chaos 和 28 天观察。
- 没有生产 OpenAI Secret、声音权利证明、YouTube OAuth 测试账号和实际渠道返回 ID。
- 没有组织指定的财经终审、品牌/素材权利、Remotion 商业许可、月预算与保留期限决策。
- 备份/恢复脚本（`pg_dump`/`pg_restore` + 隔离库演练）已交付，但生产库的时间点恢复、对象存储生命周期、供应商切换和季度演练需要目标环境。

作业队列的租约、续约、lease epoch、整数 capability protocol、重复领取、终态失败与损坏 payload 隔离由 `test/control-plane.test.ts` 覆盖；逐页 key/ordinal 唯一、checkpoint/final/累计数和跨重试完成由 `test/source-page-protocol.test.ts` 覆盖；来源运行稳定游标与所有 Worker 写路径租约身份分别由 `test/source-run-pagination.test.ts`、`test/job-lease.test.ts` 覆盖。测试直接在进程内的真 PostgreSQL（PGlite）上重放 `drizzle/` 迁移，schema 与迁移漂移、以及 SQL 方言问题都会在测试里暴露。

当前 Worker 作业层使用 PostgreSQL 事务化租约（`SELECT ... FOR UPDATE SKIP LOCKED`）、心跳续约、退避和死信状态，已经满足本地与单团队部署的至少一次执行语义。若目标环境改用专用消息队列，需要在 staging 加入队列/DLQ 适配器和远端投递验收；本文不把尚未创建的队列资源描述为已实现。
