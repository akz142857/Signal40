# Signal 40

Signal 40 是证据优先的短视频生产系统。它覆盖授权采集、跨来源选题、声明级研究、编辑审批、脚本与分镜、资产版权、TTS/字幕、Remotion 渲染、自动与人工 QC、发布、更正/下架以及指标回流，不是只导出一份 `project.json` 的 MVP。

完整方案见 [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)，实现映射见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，值班与恢复见 [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md)。

## 本地运行

要求 Node.js 22+、FFmpeg、Chromium（Docker 镜像内已包含）和 Docker。
控制面依赖 PostgreSQL 与 Cloudflare R2。

```bash
cp .env.example .env          # 填对象存储配置；已有 PostgreSQL 就只改 DATABASE_URL
docker compose up -d postgres # 可选：本地 PostgreSQL（宿主端口 55432）
make setup                     # npm ci + PostgreSQL 幂等迁移
make dev                       # 再次确认迁移后启动 127.0.0.1:3001
```

R2 通过 S3 兼容端点访问（`https://<account_id>.r2.cloudflarestorage.com`，`S3_REGION=auto`，
凭据用 R2 API Token）。本地开发不起对象存储替身——分片上传、用户元数据、校验和这几处
行为差异用替身测不出真结论，所以开发和 CI 都对着真实 R2 桶跑。

生产运行可使用 `npm run build && make start`（默认监听 `127.0.0.1:3001` 的普通 Node 进程），
或者用仓库根目录的 `Dockerfile` 构建控制面镜像。迁移不会在启动时自动执行——部署流程要显式跑 `npm run db:migrate`，
避免多副本同时启动时并发改 schema。

### 配置放哪里

本机开发配置集中在仓库根目录的 `.env`（已被 `.gitignore` 忽略，模板见 `.env.example`）。
`vinext` 原生加载，直接运行的 node 脚本靠 `--env-file-if-exists=.env`，shell 脚本在
`scripts/lib-pg.sh` 里加载；已经导出到环境里的变量优先。Compose 不再向服务注入整份 `.env`，
而是按工作负载显式列出允许变量；生产必须用部署平台的 Secret 注入与身份机制，不能把开发 `.env` 挂进容器。

| 变量 | 谁读 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 控制面 + 脚本 | PostgreSQL 连接串 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 控制面 | R2 的 S3 端点与 API Token；`S3_REGION` 固定 `auto` |
| `BOOTSTRAP_ADMIN_EMAILS` / `MEDIA_SIGNING_SECRET` / `SCHEDULER_TOKEN` / `WEBHOOK_SECRET` | 控制面 | 鉴权与签名 |
| `SIGNAL40_CONTROL_URL` | Worker | 控制面地址 |
| `SIGNAL40_SOURCE_WORKER_TOKEN` / `SIGNAL40_RENDER_WORKER_TOKEN` | 对应 Worker + 控制面 | 生产必须为两个 profile 配置不同值，控制面按作业类型和端点拒绝越界令牌 |
| `SIGNAL40_OPENCLI_BIN` | Source Worker | 微信/小红书选择 OpenCLI 搜索时使用；默认 `opencli`，第三方 RSS 模式不需要 |
| `SIGNAL40_IDENTITY_HEADER_ID` / `SIGNAL40_IDENTITY_HEADER_EMAIL` | 控制面 | 认证反向代理注入的身份头名 |
| `SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS` | 控制面 | 生产必须 `false`，否则本机请求可伪造角色 |
| `SIGNAL40_AUTOMATION_ACTOR_ID` | 控制面 + 调度器 | 自动化服务账号；必须是 `team_members` 里 active 的 admin，不配则引擎不写入 |
| `SIGNAL40_SCHEDULER_INTERVAL_MS` / `SIGNAL40_ATTENTION_WEBHOOK_URL` | 调度器 | tick 间隔与待办外部通知地址 |
| `OPENAI_API_KEY` / `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | **只有 Worker** | 云端配音与字幕对齐；不配只影响 voice 作业 |
| `YOUTUBE_ACCESS_TOKEN` / `SIGNAL40_ALLOW_PUBLIC_PUBLISH` | **只有 Worker** | 不配就只能用 package 渠道产出发布包 |

`OPENAI_API_KEY` 由 Render Worker 使用，不是控制面——控制面不直接调用任何模型服务。

### 本地验证

```bash
npm run db:migrate      # schema
npm test                # 当前 260 项；未配安全可用的对象存储测试凭据时有 3 项远程契约测试跳过
npm run source:chaos   # 固定 seed 的本地采集事务/租约故障演练（不代表目标环境验收）
npm run source:sensitive-canary # 扫描公开 DTO；可重复传 --artifact 扫描 HAR/log/trace/export
npm run test:evaluation # 100 个门禁回归场景
npm run drill:restore   # 备份 → 隔离库恢复 → 逐表比对行数 → 自动清理
npm run test:render     # 三个模板 + 预览成片（需要 FFmpeg/Chromium）
```

四类工作负载分开跑：控制面 `npm run dev`（或 `npm run build && npm run start`）、
Source Worker `npm run worker:source`、Render Worker `npm run worker:render`、
调度器 `npm run scheduler`。
Worker 启动后会打印 `connected to <控制面地址>`，并在空闲轮询时上报心跳，
界面据此判断「入队的作业有没有人会执行」。
来源 Worker 还会上报每项 capability 支持的最大整数协议版本；HTTP JSON
metadata 采集使用 v2 逐页提交/恢复协议，旧 v1 Worker 不会误领该类作业。
微信和小红书来源可选择两种方式：OpenCLI 按公众号/账号名称定时搜索，或粘贴已获准使用的
第三方 RSS/RSSHub Feed。`make setup` 会安装项目锁定的 OpenCLI；使用前仍须按其官方说明配置
Chrome 与 Browser Bridge，并可运行 `npm run opencli:doctor` 检查。它是候选发现，不等于平台官方的 canonical 账号订阅。系统不会保存
Cookie，也不会把搜索词伪装成文章发布者。严格账号订阅应使用能核验账号身份的第三方 Feed。
OpenCLI 模式应在能连接该 Chrome profile 的宿主机 Source Worker 运行；默认 Compose 容器没有宿主浏览器会话，
除非部署方另行完成 Browser Bridge 网络与隔离验收，否则容器部署请选择第三方 RSS 模式。
本地 Compose 会常驻拉起 `control-plane` / `source-worker` / `render-worker` / `scheduler`，
均设置 `restart: unless-stopped`，日常使用不需要手工启动它们。
按上述 Makefile 命令，`npm run dev` 监听 `127.0.0.1:3001`；
`SIGNAL40_CONTROL_URL` 可使用 `http://127.0.0.1:3001`。

页面：`/` 选题雷达，`/sources` 来源与调度，`/projects/{id}` 全流程工作台，`/operations` SLO、成本和 DLQ，
`/governance` 成员、实验和评分校准，`/automation` 自动化策略与近期自动动作，`/inbox` 待办箱，
`/settings/diagnostics` 系统自检（数据库、迁移版本、对象存储读写、Worker 在线数、队列积压、调度器上次 tick）。

首次接入来源前，先在 `/governance` 登记至少两个 active admin，并只给其中需要审核来源权利的人开启“来源权利审批”能力。创建、批量导入或批准来源 proposal 只会生成 provisional request；请求人不能自批，必须由另一位具备该能力的 active admin 核验主体、允许字段、地域、证据与条款快照后形成 verified grant。每个来源还必须明确业务负责人；负责人失效时系统产生 `/inbox` 待办，重新分配前禁止启用来源。历史 draft 不会被迁移脚本擅自分配给不存在的成员。

日常流程全部在界面里完成，命令行只保留部署与排障：
`db:migrate`、`drill:restore`、备份恢复属于运维流程；
`walk`、`ingest:real`、`check:storage`、`project:migrate`、`voice:local`、`render`、`qc:media`
是开发者与排障工具，不属于产品流程。

手工 JSON/CSV 导入必须在界面明确勾选元数据授权确认。相同幂等键和相同请求会返回第一次的精确结果；相同键不得用于另一批数据。生产环境还会校验当前成员角色，客户端伪造的角色头无效。

`contracts:rehash-local`（读 `DATABASE_URL`）只在从旧的 8 位指纹升级开发库时执行；它会将已进入审批后的项目退回 `CHANGES_REQUESTED`，要求重新审批。生产环境使用管理员接口 `POST /api/v1/contracts/rehash`。

## 端到端冒烟：从真实来源跑到成片

系统初始化后库里是空的，没有任何示例数据。下面这条路径用真实公开 RSS 源把 G0–G8 走一遍。

**先决条件**：`.env` 里 `DATABASE_URL`、`S3_*`（R2）、`OPENAI_API_KEY` 都已配置，
`npm run check:storage` 显示「对象存储配置可用」。

```bash
npm run db:migrate                 # 建表
npm run build && npm run start     # 控制面（渲染阶段必须用生产模式，见下方说明）
```

另开终端：

```bash
# 1) 采集真实文章并生成选题
npm run ingest:real

# 2) 在 / 页面核验一个 gate=通过 的选题，然后建项目（也可用 API）
curl -X POST "$API/api/v1/projects" -H 'content-type: application/json' \
  -H 'x-signal-role: editor' -H 'idempotency-key: <唯一键>' \
  -d '{"topicId":"<选题 ID>"}'

# 3) 推进到 SCRIPT_APPROVED（脚本要在这个状态入队配音）
npm run walk -- <项目 ID> SCRIPT_APPROVED

# 4) 入队配音 → 起 Worker → 推进到 ASSETS_READY
#    5) 在 ASSETS_READY 入队渲染 → 转 RENDER_QUEUED → 起 Worker
npm run worker
```

`npm run walk -- <项目 ID> [目标状态]` 会沿状态机往下推并逐个打印门禁结果，
推不动时停下并说明原因，不会假装成功。

### 三个必须注意的顺序

作业要在**特定状态**入队，早了晚了都会被拒：

| 作业 | 必须在这个状态入队 | 之后再转到 |
| --- | --- | --- |
| 配音 | `SCRIPT_APPROVED` | `ASSETS_READY` |
| 渲染 | `ASSETS_READY` | `RENDER_QUEUED` |
| 发布 | 先转到 `PUBLISH_SCHEDULED`，**再**建发布任务 | —— |

`walk` 默认一路推到底，所以入队前要用目标状态参数停住。另外 `RENDER_QUEUED`
没有回到 `ASSETS_READY` 的转换路径：误推进后可以直接退到 `CHANGES_REQUESTED`
（编辑或管理员权限），也可以取消渲染作业或走 `FAILED` 重来。

**这三个顺序约束在自动化模式下由编排引擎消化**：启用策略后，配音、渲染与发布任务
都由 `lib/orchestrator.ts` 在正确状态下入队，人不需要记住顺序。

### 旁白长度要匹配时间轴

`G5` 要求旁白时长落在成片目标时长的 60%–110%，自动 QC 还会拒绝超过 3 秒的连续静音。
中文 TTS 实测约 **3.86 字/秒**，45 秒时间轴对应约 **174 字**。
自动模板会用 `narrationBudget` 按目标时长分配脚本长度；人工修改后仍可能超出区间，需要在 `SCRIPT_DRAFT` 状态调整。
脚本编辑器会实时显示「预计旁白 X 秒 / 目标 Y 秒」（`lib/script-duration.ts`），
超出区间时标红并给出还差多少字，不必等配音生成后才在 G5 或自动 QC 上失败。
**不要为了凑数缩短 `render.durationSeconds`** —— 那是发布阻断项，不是可以绕过的告警。

### 渲染阶段必须用生产模式

`npm run dev` 无法流式返回响应体，`/api/v1/media` 会返回 500，
Worker 渲染前下载音轨会失败。渲染和发布阶段请用 `npm run build && npm run start`。

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

## 自动化

系统默认自动推进已开启的机械步骤（采集、质量评估、配音、渲染、发布执行、指标回流），
四道问责门禁（G3 研究、G4 脚本、G6 终审、G7 发布）默认仍需人确认；自动建项目因当前质量闸门默认关闭。

打开自动化的顺序：

1. **起调度器**：`docker compose up -d scheduler`（或 `npm run scheduler`）。
2. **配服务账号**：把 `SIGNAL40_AUTOMATION_ACTOR_ID` 指到 `team_members` 里一个 active 的 admin。
   不配时引擎一步都不做，并在 `/inbox` 留一条说明——自动化不允许凭空构造身份。
3. **建策略**：`/automation` 新建策略并启用。新策略默认机械步骤自动、四道审批人工、
   自动建项目关闭。
4. **（可选）开预先授权**：勾选要自动放行的审批，指定授权人和有效期。
   研究/脚本/终审用一个授权人，发布用另一个——两者必须是**不同的真实成员**，
   否则 G7 的职责分离形同虚设，保存时和每次自动放行时都会校验。
   自动放行写入的是那个人的批准记录，note 注明依据哪条策略，审计里以 `trigger=automation` 区分。

人工干预：

- 项目页「暂停自动化」随时接管；任何人工编辑、审批或配置修改都会自动转人工，需显式「恢复自动」。
- 项目一旦开了内容事件（勘误、下架、投诉），立即退出自动化，事件关闭前不会恢复。
- 处理不了的事进 `/inbox`，配了 `SIGNAL40_ATTENTION_WEBHOOK_URL` 时还会带 HMAC 签名推到外部。

自动化不做的事：不改写已批准的脚本内容、不放宽任何门禁阈值、
不把 `SIGNAL40_ALLOW_PUBLIC_PUBLISH` 置为 true（公开发布始终是人的显式决定）、
失败不静默重试到成功（同一阶段连续失败 3 次即熔断 15 分钟并进待办箱）。

**自动建项目默认关闭**：`lib/topic-quality.ts` 度量簇内一致性、声明与证据的对应唯一性、
语言与词表匹配度并写入 `topics.quality_json`；当前的聚类与证据绑定还达不到阈值，
不达标的选题只进待办箱。要打开它，先让选题质量指标达标，再在策略里把「自动建项目」改成自动。

## 安全与边界

- 非本地环境的角色只从反向代理注入的身份头（`SIGNAL40_IDENTITY_HEADER_*`）和 `team_members` 读取，忽略客户端角色头；界面用 `/api/v1/session` 返回的真实身份，不再硬编码角色。
- 自动化不构造身份：机械步骤用注册在 `team_members` 的服务账号，自动放行写入策略里那个真人的 `actor_id`，审计里以 `trigger=automation` 与 `policyId` 区分「人做的」和「策略做的」。
- 选题、来源、项目、资产、QC、发布和审计读取均要求有效团队成员；导入只允许研究员/管理员，核验只允许编辑/管理员。
- 项目快照、审批和审计使用确定性 SHA-256；媒体使用字节级 SHA-256。
- Worker、调度器、Webhook、OpenAI 和 YouTube 密钥只进入托管 Secret。
- 来源检查 URL、重定向、DNS 私网地址、大小、字段和时间；未知版权资产不能过 G5。
- 系统不提供个性化投资建议。发布必须经过独立 G7 批准，事实更新进入内容事件和更正/下架流程。

## 发布状态

本地实现与 Docker 真渲染已具备全链路候选能力。生产认证代理、托管 PostgreSQL/S3、staging、OpenAI 真实声音、YouTube 测试账号、真实历史金标和生产灾备演练均是独立外部门禁；本仓库不会在没有项目所有者授权时执行外部上传或发布。
