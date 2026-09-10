# Signal 40 第一轮技术发现清单

> 基线：`8b408021c9305b1a23ef0797efe9f7e80ac99799`
> 状态：本文保留第一轮原始发现；本地整改结论与验证证据见 [RE_REVIEW.md](./RE_REVIEW.md)
> 定级：遵循 `PROJECT_REVIEW_PLAN.md` 的 P0–P3 标准

## [P1] REV-P1-01：Render Worker 在独立部署中无法读取项目

- 范围：配音与 Remotion 渲染 Worker。
- 证据：`render-worker/worker.ts:959-963`、`render-worker/worker.ts:1129-1135` 对 `/api/v1/projects/{id}` 发起不带身份头和 Worker token 的 GET；`app/api/v1/projects/[id]/route.ts:7-16` 只接受 `resolveRequestActor` 解析出的团队成员。`docker-compose.yml` 中 Worker 使用 `http://control-plane:3000`，不满足本地角色模拟条件。
- 前置条件：控制面和 Render Worker 分进程或分容器运行，这是 Compose 和生产的正常拓扑。
- 复现：领取任一 `voice`、`preview` 或 `render` 作业，执行相应 Worker 分支。
- 实际结果：项目 GET 返回 403，Worker 的 `json()` 包装抛错，作业重试后可能进入 DLQ。
- 预期结果：当前有效租约的 Render Worker 可以读取完成该作业所需的最小项目快照，且不能读取其他项目。
- 影响：配音和渲染主链路在正常部署拓扑下不可用。
- 建议修复：新增 job-scoped 内部读取端点，以 render token、job id、worker id、lease epoch、未过期租约共同授权，并只返回该作业所需 DTO。不要把共享 Worker token 直接扩展成任意项目读取权限。
- 验证方式：容器化集成测试覆盖成功读取、错误项目、错误 owner、旧 epoch、过期租约和 source token。
- 责任人：Control Plane / Render Worker。
- 目标版本：下一发布候选版。

## [P1] REV-P1-02：Render Worker 结果回写未绑定当前租约

- 范围：配音、资产、QC、发布完成写路径。
- 证据：
  - `app/api/v1/projects/[id]/voice-tracks/route.ts:31-45` 只检查 render token、job/project/kind/status；请求体没有 `workerId`、`leaseEpoch`。
  - `app/api/v1/projects/[id]/qc-reports/route.ts:5-18` 同样只检查 `status='leased'`。
  - `app/api/v1/publish-jobs/[id]/complete/route.ts:6-28` 可把发布任务置为 published，并可能把项目推进到 `PUBLISHED`，但不校验 owner、epoch 或 expiry。
  - `app/api/v1/projects/[id]/assets/route.ts:16-24,78-100` 的生成资产路径甚至不要求 job identity。
  - `render-worker/worker.ts:992-1001,1126,1158-1178` 的调用也没有传入租约身份。
  - 对照：`lib/job-lease.ts:8-19` 已定义必须同时匹配 status、owner、epoch 和 expiry 的权威规则。
- 前置条件：Worker A 租约过期或失联，Worker B 接管；A 随后恢复并继续执行，或共享 render token 泄露给另一进程。
- 实际结果：旧 Worker 仍可上传资产、写配音/QC，甚至确认发布完成。
- 预期结果：任何 Worker 副作用都只能由当前未过期租约持有者提交；旧 epoch 必须 fail-closed。
- 影响：过期成片或 QC 倒写、重复资产、错误发布状态；发布路径还涉及不可轻易回滚的外部副作用。
- 建议修复：统一使用 `activeLeaseMatches` 或等价 SQL 条件，在单事务内验证 `jobId/projectId/kind/status/lease_owner/lease_epoch/lease_expires_at`。资产先写 job-scoped 暂存键，租约验证成功后再关联。YouTube 上传前增加一次当前租约授权，完成提交保持幂等。
- 验证方式：故障注入覆盖接管后旧 Worker 回写、租约恰好到期、错误项目、错误 kind、重复完成、外部响应丢失。
- 责任人：Control Plane / Render Worker / Publishing。
- 目标版本：下一发布候选版。

## [P1] REV-P1-03：production 未强制关闭本地鉴权 fallback

- 范围：用户身份、Worker token、媒体签名。
- 证据：`Dockerfile:11-12` 设置 production 模式，但未设置 `SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false`；`lib/runtime.ts:143-147` 默认值仍为 true；`lib/workflow.ts:170-208` 仅按请求 URL hostname 判断 loopback，并可由头部构造 admin；`lib/worker-auth.ts:1-5` 在未配置 token 且 URL hostname 为 localhost 时接受固定值 `local-development`；媒体路由也在 localhost 下使用固定签名 Secret（`app/api/v1/media/route.ts:12`、`app/api/v1/media-tokens/route.ts:14`）。
- 前置条件：生产实例经端口转发、同机代理、错误 Host 重写或内部请求以 localhost URL 到达，且相应 Secret/开关缺失。
- 实际结果：请求可获得本地管理员身份、Worker 能力或固定媒体签名能力，行为与 `SIGNAL40_DEPLOYMENT_MODE=production` 无关。
- 预期结果：production 模式下所有开发 fallback 无条件禁用；必需 Secret 缺失时启动失败。
- 影响：在可触发前置条件的部署中形成身份与 Worker 权限绕过，破坏 G7 职责分离。
- 建议修复：把 deployment mode 作为所有 fallback 的第一层硬条件；生产启动校验专用 Worker token、媒体 Secret 和身份代理配置；不要使用客户端可影响的 URL hostname 作为信任边界。
- 验证方式：production 配置下对 localhost URL、伪造 Host、伪造角色头、缺 token、固定本地 token 和固定媒体 Secret 全部做负向测试。
- 责任人：Platform / Security / Control Plane。
- 目标版本：下一发布候选版。

## [P1] REV-P1-04：Docker PostgreSQL 客户端回退无法完成恢复

- 范围：本地/运维备份恢复演练。
- 证据：`scripts/restore-local.sh:50-52` 把 `pg_restore` SQL 管道输入 `psql`；`scripts/lib-pg.sh:41-53` 的 Docker 回退没有 `-i`。本次 `npm run drill:restore` 在校验备份并创建隔离库后以 141 退出，随后 cleanup 删除隔离库。
- 前置条件：主机没有 `pg_restore` 或 `psql`，脚本按其声明走 `postgres:16-alpine` 回退路径。
- 实际结果：容器内 `psql` 不能消费管道 stdin，上游收到 SIGPIPE；逐表对账未执行。
- 预期结果：支持的回退路径完成备份、恢复、逐表行数比较及清理。
- 影响：灾备能力在常见开发/值班机配置下不可验证；发布清单中的恢复门禁无法关闭。
- 建议修复：为需要 stdin 的容器客户端显式传 `-i`，或让 `pg_run` 支持受控的 stdin 模式；增加“宿主无 PG 客户端”的 CI 场景。
- 验证方式：隔离环境完成 55 表恢复、行数一致、checksum 一致、失败清理和源库不变证明。
- 责任人：SRE / Platform。
- 目标版本：下一发布候选版。

## [P1] REV-P1-05：写接口幂等语义不一致，不能拒绝同键不同请求

- 范围：项目、指标、实验、作业及其他自定义幂等实现。
- 证据：
  - `app/api/v1/projects/route.ts:22-48` 只校验并回显 key，创建逻辑完全不使用它。
  - `app/api/v1/projects/[id]/metrics/route.ts:41-48` 只按 project/key 返回既有 ID，不比较请求哈希；select-then-insert 还有并发窗口。
  - `app/api/v1/experiments/route.ts:14-25` 从审计 metadata 查 key，不比较请求哈希，且没有对应唯一约束。
  - `lib/control-plane.ts:1275-1318` 的作业唯一键为 `(kind,idempotency_key)`，冲突后直接返回既有作业，不校验 project 或 payload。
  - `lib/idempotency.ts:42-115` 已实现 request hash、pending、replay、conflict，但目前只有三个路由调用。
- 前置条件：客户端重用 key 但请求体、项目或目标不同；或两个同键请求并发。
- 实际结果：可能重复创建、静默返回错误资源，或把不同请求错误视为成功重放。
- 预期结果：同 scope/key/同请求精确重放；同 scope/key/不同请求返回稳定冲突；并发只能有一个 owner。
- 影响：重复项目/实验/指标、错误作业关联和不可预测的客户端恢复行为。
- 建议修复：统一使用持久化 request hash reservation；为每个业务定义明确 scope；完成响应与业务写在可证明的一致边界内；移除基于审计表的幂等实现。
- 验证方式：所有关键 POST/PATCH 的同键同体、同键异体、并发同键、首请求失败和响应丢失表驱动测试。
- 责任人：API / Data。
- 目标版本：下一发布候选版。

## [P1] REV-P1-06：关键写路由缺少可执行的 HTTP/PG 测试

- 范围：API route handlers。
- 证据：仓库有 79 个变更型 Handler，测试只动态导入并执行 `team-members`、`source-configs` 两个路由模块。`test/routes-write-paths.test.ts:9-17` 已记录过两条 INSERT 在 lint、tsc 和约 260 项测试都通过、实际 PostgreSQL 直接失败的事故。
- 实际结果：大多数路由测试依赖源码文本匹配或间接测试 library，无法发现路由鉴权、请求 DTO、SQL bind、事务组合和响应码错误；本次 REV-P1-01/02/05 正是未被现有测试捕获的例子。
- 预期结果：所有关键写路径至少有一条真实 Handler → PostgreSQL 的正向测试和主要负向不变量测试。
- 影响：高风险回归进入构建和 CI 的概率较高。
- 建议修复：优先覆盖 Worker 读取/回写、项目创建、作业入队/完成、指标、实验、发布和撤回；其余路由按风险分层补齐。文本断言只保留用于静态政策检查，不作为可执行行为证据。
- 验证方式：生成 route inventory 与测试映射，关键路径映射必须为 100%，并保存 DB 前后状态与 HTTP 状态。
- 责任人：Backend / QA。
- 目标版本：下一发布候选版。

## [P2] REV-P2-01：CI 缺少显式 TypeScript 类型检查

- 范围：`.github/workflows/ci.yml` application job。
- 证据：CI 在 `.github/workflows/ci.yml:55-75` 执行 audit、lint、OpenAPI、测试、评估、迁移、构建和渲染，但没有 `npm exec tsc -- --noEmit`；本地 `Makefile` 虽包含 typecheck，CI 未调用该目标。
- 影响：vinext/Vite 构建若只负责转译和打包，未来类型错误可能进入发布产物。
- 建议修复：加入独立、可见的 typecheck step，保持与本地命令一致。
- 验证方式：临时类型错误能稳定使 CI 失败。
- 责任人：Platform / Frontend。
- 目标版本：最近迭代。

## [P2] REV-P2-02：页面宽度与全站导航没有统一权威实现

- 范围：八个主要页面。
- 证据：主容器同时使用 `max-w-5xl`、`max-w-6xl`、`max-w-7xl`、`max-w-[1480px]`、`max-w-[1500px]`；`/sources` 在加载/错误态还从 6xl 变为 5xl。各页面分别维护“返回雷达”或少量邻接链接，只有雷达包含完整入口；未发现业务页 `aria-current`。
- 影响：跨页面视觉跳动、入口不一致、移动端拥挤、可访问性和维护成本增加。
- 建议修复：按 Standard/Wide/Workspace 三类 token 建立共享页面壳、页头和单一导航配置；项目阶段导航保留为二级上下文导航；移动端提供统一折叠与焦点回收。
- 验证方式：320/375/768/1024/1280/1440/1920 视口截图与键盘回归；详见 [UI_CONSISTENCY.md](./UI_CONSISTENCY.md)。
- 责任人：Frontend / Design。
- 目标版本：最近迭代。

## [P2] REV-P2-03：OpenAPI 身份模型与运行时协议不一致

- 范围：API 契约与认证代理边界。
- 证据：`contracts/openapi.yaml:8-9,2221-2225` 把全局认证定义为 `sites_session` cookie；实际路由通过 `resolveRequestActor` 读取可配置的认证代理身份头。OpenAPI 也没有为 Render Worker 的结果端点定义 lease identity schema。
- 影响：SDK、网关策略和安全审查可能基于错误认证假设；内部 Worker 协议的兼容责任不清晰。
- 建议修复：在 OpenAPI 中准确建模可信代理身份或明确文档化“cookie 由代理验证并剥离/注入头”的边界；为 Worker DTO 使用具体 schema，纳入 epoch 协议版本。
- 验证方式：OpenAPI 契约测试与代理/路由集成测试使用同一认证模型。
- 责任人：API / Platform / Security。
- 目标版本：最近迭代。

## [P3] REV-P3-01：运行时配置读取没有完全收敛

- 范围：diagnostics 路由与配置边界。
- 证据：`lib/runtime.ts` 注释声明全仓只有该文件读取 `process.env`，但 `app/api/v1/diagnostics/route.ts:15-27` 直接读取多个 Secret/config 环境变量。
- 影响：配置默认值、生产校验和测试注入可能出现两套语义；当前未发现该路由直接回显 Secret。
- 建议修复：把 diagnostics 所需的“是否配置”信息收敛到类型化 config，避免路由直接接触 Secret 值。
- 验证方式：配置单元测试和敏感值 Canary 保持通过。
- 责任人：Backend。
- 目标版本：Backlog。
