# Signal 40 实施与验收矩阵

更新时间：2026-09-08

`Implemented` 表示代码和本地自动化证据存在；`Accepted` 还要求目标环境、真实供应商、渠道和责任人完成验收。

| 阶段 | 能力 | 实现状态 | 代码/本地证据 | 外部验收 |
| --- | --- | --- | --- | --- |
| P0 | 角色、G0–G8、状态机、ETag、SHA-256 审批 | Implemented | `lib/workflow.ts`、工作台、状态机测试 | Sites 身份与团队成员实测 |
| P0 | project.json 2.0 / 1.0 兼容 | Implemented | Schema、迁移脚本、协议测试 | 历史项目批量演练 |
| P0 | D1/R2/作业/审计 | Implemented | 34 表、0000–0014、直接/分片上传、对象级短时读取、租约/DLQ、项目级声明 ID | 远端 D1/R2 与保留策略 |
| P1 | 来源、调度、滚动聚类、修订 | Implemented | RSS/Atom、HTTP JSON、CSV/OpenCLI、UTC Cron、滚动限流、72h 语料、article revisions、显式授权确认、精确幂等重放、授权原文保留与自动清理 | 至少三类真实授权来源 |
| P1 | Claim/Evidence/ResearchSnapshot | Implemented | 支持/反驳、冲突、快照、独立批准 | 财经编辑真实题材验收 |
| P2 | 脚本与分镜 | Implemented | 逐句声明、版本比较、评论/锁定、读音、连续帧、动态图表 | 品牌规范和模板冻结 |
| P3 | 资产、TTS、字幕 | Implemented | 版权元数据、OpenAI TTS、逐词对齐、字幕安全区、可选版权音乐与音量混合 | API key、授权声音与素材政策 |
| P3 | Remotion 渲染 | Implemented | 三个版本化视觉模板、Player、真实转场/屏幕文字/来源脚注、低码率预览、正式片 Worker、Docker、并发/预算、封面 | 部署池、许可证和金丝雀 |
| P4 | 自动/人工 QC | Implemented | 24 类媒体/内容/混音/关键帧检查、哈希绑定 QC、旁白覆盖门禁和独立批准 | 人工终审责任人签字 |
| P4 | 发布、更正和下架 | Implemented | 发布包、YouTube 续传、private fail-safe、HMAC 回调、事件与下架 | YouTube 测试账号 staging |
| P5 | 指标与实验 | Implemented | 2h/24h/7d 快照、版本/实验归因、确定性 A/B、校准审批及 `/governance` 操作台 | 真实指标口径与四周阈值校准 |
| P5/P6 | SLO、成本、容量、灾备 | Implemented locally | `/operations`、`/health`、DLQ 重放、CI、备份恢复和运行手册 | 托管告警、远端恢复和季度演练 |

## 自动化评估边界

仓库提供 100 个覆盖财报、商品、宏观、公司公告和市场传闻的确定性回归场景，验证门禁契约。它明确标记为 synthetic regression，不替代“100 个真实历史事件 + 权威证据 + 冲突 + 可接受表达”的人工金标和盲评。

## 当前不能宣称 Accepted 的项目

- 没有获得 Sites 源码上传/发布授权；远端迁移、访问控制和浏览器回归未执行。
- 没有生产 OpenAI Secret、声音权利证明、YouTube OAuth 测试账号和实际渠道返回 ID。
- 没有组织指定的财经终审、品牌/素材权利、Remotion 商业许可、月预算与保留期限决策。
- 本地备份/恢复脚本已交付，但生产 D1 时间点恢复、R2 生命周期、供应商切换和季度演练需要目标环境。

当前 Worker 作业层使用 D1 事务化租约、退避和死信状态，已经满足本地与单团队部署的至少一次执行语义。若目标环境改用 Cloudflare Queues，需要在 staging 加入 Queue/DLQ 适配器和远端投递验收；本文不把尚未创建的远端 Queue 资源描述为已实现。
