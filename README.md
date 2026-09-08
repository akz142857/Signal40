# Signal 40

Signal 40 是证据优先的财经短视频生产系统。它覆盖授权采集、跨来源选题、声明级研究、编辑审批、脚本与分镜、资产版权、TTS/字幕、Remotion 渲染、自动与人工 QC、发布、更正/下架以及指标回流，不是只导出一份 `project.json` 的 MVP。

完整方案见 [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)，实现映射见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，值班与恢复见 [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md)。

## 本地运行

要求 Node.js 22+、FFmpeg、Chromium（Docker 镜像内已包含）和 Docker。

```bash
npm install
npm run db:local:migrate
npm run contracts:rehash-local -- .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<database>.sqlite
npm run dev -- --host 127.0.0.1 --port 3001
```

页面：`/` 选题雷达，`/sources` 来源与调度，`/projects/{id}` 全流程工作台，`/operations` SLO、成本和 DLQ，`/governance` 成员、实验和评分校准。

手工 JSON/CSV 导入必须在界面明确勾选元数据授权确认。OpenCLI 只输出本地 JSON 时不需要该确认；直接提交到服务端时需要显式设置：

```bash
SIGNAL40_API_URL=http://127.0.0.1:3001 \
SIGNAL40_RIGHTS_CONFIRMED=true \
SIGNAL40_IDEMPOTENCY_KEY=weixin-2026-09-08-01 \
npm run ingest:weixin -- "财经主题" 20
```

相同幂等键和相同请求会返回第一次的精确结果；相同键不得用于另一批数据。生产环境还会校验当前成员角色，客户端伪造的角色头无效。

`contracts:rehash-local` 只在从旧的 8 位指纹升级本地开发库时执行；它会将已进入审批后的项目退回 `CHANGES_REQUESTED`，要求重新审批。生产环境使用管理员接口 `POST /api/v1/contracts/rehash`。

## 从导出项目生成视频

```bash
npm run project:migrate -- /path/to/topic.project.json output/topic.v2.project.json
npm run voice:local -- output/topic.v2.project.json public/generated/topic-voice.m4a output/topic.with-voice.project.json
npm run render -- output/topic.with-voice.project.json output/topic.mp4
npm run qc:media -- output/topic.mp4 output/topic.with-voice.project.json
```

`voice:local` 只用于本机预览。生产配音由 Worker 使用托管 `OPENAI_API_KEY`，并保存逐词对齐、字幕和资产记录。工作台在资产就绪后可分别生成低码率审片预览与正式成片；上传版权已清除的音频输入时，可用 `X-Audio-Purpose: music` 和 `X-Music-Volume: 0.12` 将它绑定为背景音乐。

导出文件中的目标时长不会被静默缩短。如果旁白、字幕或音乐不足以覆盖时间轴，`qc:media` 会以非零状态阻止发布；应回到脚本/分镜补足内容或明确调整目标时长后重新冻结快照。

```bash
docker build -f render-worker/Dockerfile -t signal40-render-worker:local .
docker run --rm --shm-size=1g --env-file .env.local signal40-render-worker:local
```

公开发布默认关闭；未设置 `SIGNAL40_ALLOW_PUBLIC_PUBLISH=true` 时，YouTube 只会上传为 private。

## 验证

```bash
npm test
npm run test:evaluation
npm run lint
npm run build
npm run test:render
npm run drill:restore
npm audit --omit=dev
```

`evaluation/finance-events.ts` 是 100 场景的合约回归集，不是真实财经金标。算法上线仍需独立编辑完成历史事件标注和盲评。

## 安全与边界

- 非本地环境的角色只从 Sites 登录身份和 `team_members` 读取，忽略客户端角色头。
- 选题、来源、项目、资产、QC、发布和审计读取均要求有效团队成员；导入只允许研究员/管理员，核验只允许编辑/管理员。
- 项目快照、审批和审计使用确定性 SHA-256；媒体使用字节级 SHA-256。
- Worker、调度器、Webhook、OpenAI 和 YouTube 密钥只进入托管 Secret。
- 来源检查 URL、重定向、DNS 私网地址、大小、字段和时间；未知版权资产不能过 G5。
- 系统不提供个性化投资建议。发布必须经过独立 G7 批准，事实更新进入内容事件和更正/下架流程。

## 发布状态

本地实现与 Docker 真渲染已具备全链路候选能力。Sites 源码上传、staging、OpenAI 真实声音、YouTube 测试账号、真实历史金标和生产灾备演练均是独立外部门禁；本仓库不会在没有项目所有者授权时执行外部上传或发布。
