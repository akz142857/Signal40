# Signal 40 开发方案

## 1. 产品目标

Signal 40 不是文章搬运器，而是财经选题与证据工作台：监控多个财经来源，将短时间内描述同一事件的内容聚类，计算“是否值得做成 40–45 秒数据视频”的分数，并在生成脚本前强制回到原始来源核验。

核心承诺：每天稳定产出 10 个值得研究的候选题，而不是自动发布未经核验的视频。

## 2. V1 范围

- 采集：OpenCLI 微信适配器、JSON/CSV 手工导入、可插拔 HTTP/RSS 来源。
- 归一化：标题、摘要、作者、来源类型、发布时间、原文 URL、可选互动量。
- 去重与聚类：URL/内容指纹去重；中文关键词与实体相似度聚类。
- 评分：跨来源共振、增长速度、数字冲击力、来源质量、时效性、视频可解释性。
- 证据：保留所有来源；区分自媒体、媒体、市场数据、公司财报/公告等原始来源。
- 工作台：候选列表、评分拆解、来源证据、核验状态、生产门禁。
- 视频协议：输出与渲染引擎解耦的 `project.json`，V1 不自动发布平台。

## 3. 明确不做

- 不把单一公众号文章改写后直接生成或发布视频。
- 不在缺少原始来源时把模型生成内容标记为已核验事实。
- 不在 V1 依赖不稳定的微信阅读量抓取；互动数据是可选增强信号。
- 不自动登录微信、不绕过风控、不自动发布到视频平台。

## 4. 架构

```text
OpenCLI / JSON / RSS
        ↓
ingestion adapters
        ↓
normalized articles → dedupe → topic clustering
                                ↓
                         deterministic scoring
                                ↓
                      topics + evidence + status
                                ↓
                         Signal 40 dashboard
                                ↓  verification gate
                     project.json → Remotion (V2)
```

部署侧使用 Cloudflare D1 保存结构化记录；离线/批处理侧保持适配器协议独立，可由 Python、定时任务或外部编排器调用。模型只用于辅助摘要、实体抽取与解释，关键排序保留可审计的确定性分数。

## 5. 核心数据协议

`Article`: `id/source/source_type/author/title/summary/url/published_at/metrics/content_hash/raw_payload`。

`Topic`: `id/title/keywords/score/score_breakdown/heat/source_count/status/created_at/updated_at`。

`Evidence`: `topic_id/article_id/evidence_type/is_primary/claim/support_level`。

`VideoProject`: `version/topic/claims/sources/scenes/audio/captions/brand/render`。详细 JSON Schema 位于 `contracts/video-project.schema.json`。

## 6. 评分口径

总分为 0–100：

- 跨来源共振 25%；
- 增长速度 20%；
- 数字冲击力 15%；
- 来源质量 20%；
- 时效性 10%；
- 视频可解释性 10%。

`score >= 80` 进入候选榜，但只有满足下列条件才能进入脚本生产：至少一个原始来源；关键数字至少两个独立证据，或一个权威原始数据源；没有未解决的证据冲突。

## 7. 交付阶段

### M1：可运行选题雷达（本次）

- 完成数据模型、示例数据、聚类与评分逻辑；
- 完成 D1 表结构和迁移；
- 完成候选工作台与 API；
- 完成核心单元测试和生产构建。

### M2：真实来源接入

- 在已授权环境中接入 OpenCLI 微信搜索/下载；
- 配置 10–20 个来源和 30–60 分钟调度；
- 建立采集成功率、重复率与缺失字段监控。

### M3：研究与视频生产

- 原始信源检索、声明级证据绑定和人工核验；
- 模型通过 Structured Outputs 生成严格 `project.json`；
- Remotion 模板、TTS、字幕与本地渲染。

### M4：效果学习

- 仅在用户授权后接入发布与表现数据；
- 用完播率、3 秒留存、互动率校准“可视频化”分数；
- 保留人工审核和停机开关。

## 8. 验收标准

- 无密钥、无 OpenCLI 时，可用示例数据跑通采集到候选榜的完整流程。
- 相同 URL 重复导入不会产生重复文章。
- 同一事件的多来源报道能聚为同一主题，且增加来源会提升共振分。
- 候选页明确显示分数、拆解、来源和核验状态。
- 未通过门禁的主题不能被标记为可生成脚本。
- 数据库迁移可重复应用，测试与生产构建通过。
