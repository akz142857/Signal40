# 数据源订阅与自动采集开发方案

- 日期：2026-09-09
- 版本：3.4（OpenCLI/第三方 RSS 社交发现 + Social Evidence 本地实现）
- 状态：Foundation 整体 `In progress`；只有已形成可重现本地证据的单项能力可称为 `Implemented locally`，尚无 Delivered/Deployed/Integrated/Accepted 连接器；未标记 Accepted 的连接器不对外宣称可用
- 当前 Foundation 目标：管理员首次配置 RSS 或无凭据 Public JSON，之后系统持续采集、去重、聚类并产生候选题；JSON/CSV 粘贴仅作为迁移与排障入口
- 当前剩余核心：公开网页/热榜以及微信/小红书 OpenCLI + 第三方 RSS 双策略已完成本地代码；仍缺真实 OpenCLI/Browser Bridge、具体 RSSHub 路由与真实来源验收，以及 Social Evidence 的真实授权语料与业务签字

本版已把产品/编辑、架构/数据一致性、安全/凭据、运行/SRE、交付/验收和法务/治理六个视角的评审意见合并到同一执行基线。这里的“评审闭环”只表示意见已转化为明确需求、依赖、负责人和关闭证据，不表示代码、外部平台接入或生产验收已经完成；实际状态始终以第 2 节事实账本、第 12 节工作包状态和第 15 节分层完成定义为准。

配套基线：[来源采集威胁模型](./SOURCE_INGESTION_THREAT_MODEL.md)、[来源采集 SLO 策略](./SOURCE_SLO_POLICY.md)、[固定种子本地故障演练](./SOURCE_CHAOS_DRILL.md)、[实施与验收矩阵](./IMPLEMENTATION_STATUS.md)、[2026-09-09 本地证据记录](./evidence/SOURCE_INGESTION_LOCAL_2026-09-09.md)。这些文档必须与本方案同步更新；证据记录只能证明其明确列出的检查，不能反向扩大本方案中的交付状态。

本次修订冻结以下执行裁决，后续实现和验收不得再以隐含假设替代：

1. **正式产品是来源订阅，不是手工导入**：RSS 与无凭据 Public JSON 是 Foundation GA 的首批承诺；JSON/CSV 粘贴或文件导入仅为迁移和排障兜底。
2. **外部平台按连接器独立晋级**：公众号、小红书、网页/热榜即使得到 `blocked` 结论，也不阻塞 Foundation GA；但不得显示为已支持，也不得以手工导入冒充连接器。
3. **发现与生产分层**：社交或网页内容可以作为发现信号进入雷达，但在声明级补证和独立性门禁通过前不得自动进入生产。
4. **不建设来源凭据平台**：Secret Manager、workload identity、OAuth/PKCE、自研本机 Agent、凭据 Broker 和相关数据模型均不属于系统范围。用户明确选择 OpenCLI 时，Source Worker 仅调用外部 `opencli` 可执行文件；浏览器登录态由 OpenCLI/Browser Bridge 自己管理，Signal40 不保存或转发 Cookie。
5. **一致性以服务端逐页提交协议为准**：页面 hash、ordinal、checkpoint CAS、lease epoch、版本与权利在提交端复核；连接器自身的“成功”不能绕过这些条件。
6. **状态声明按证据分层**：本地测试、Git/制品交付、目标环境部署、真实上游集成和业务验收分别对应 `Implemented locally`、`Delivered`、`Deployed`、`Integrated`、`Accepted`，禁止跨级表述。
7. **当前发布范围保持收窄**：Foundation GA 不承诺多租户或绕过平台限制；网页和第三方 Feed 只接收经权利确认的公开 URL。OpenCLI 只作候选发现，不能把搜索词当作 canonical 发布主体；社交证据自动放行仍须通过校准门禁。
8. **状态只有一条线性交付链**：`Implemented locally → Delivered → Deployed → Integrated → Accepted`；`Blocked`、`Experimental` 和 `Deprecated` 是正交标签，不是更高交付等级。禁止再使用 `Integrated locally`。
9. **浏览器与 Worker 使用不同读模型**：用户端只取得明确 allowlist 中的字段；Worker 所需 checkpoint cursor 和运行内部数据使用内部执行契约，不通过同一响应依赖调用者猜测分支。
10. **分页持久化不等于对用户可见**：逐页提交的 article/origin 在 run `complete` 前保持 staged，不进入雷达、证据门禁或主题重算；完成时一次性可见并触发幂等重算。

---

## 1. 产品结论与原则

Signal 40 的正常使用方式应当是：

1. 用户一次登记并确认数据源；
2. 系统按平台允许的频率持续增量采集；
3. 采集结果统一转换为来源条目，进入文章去重、修订、滚动聚类、转载识别和质量评分；
4. 社交信号及时出现在雷达，系统并行寻找独立原始证据；
5. 只有证据门禁通过的候选才能进入生产；
6. 用户日常只处理来源失效、补证失败、内容冲突和审批等待办。

手工 JSON/CSV 导入继续保留，但只用于历史迁移、开发排障、暂无连接器时的临时兜底，以及有明确授权的批量数据交接。它不属于正式日常工作流，不能作为“来源订阅已实现”或“无人值守采集已验收”的证据。

硬边界：

- 不绕过验证码、付费墙、访问控制或平台反自动化保护；
- 平台能力和授权不明确时显示“待确认”或“不可用”，不降级为隐蔽爬取；
- 公众号、小红书和热榜属于信号发现渠道，不能单独满足财经证据门禁；
- 来源类型、发布主体和独立性由服务端治理，不能由普通用户自报后直接影响门禁；
- 连接器内容一律视为不可信数据，不能成为控制面、Agent 或模型的操作指令。

## 2. 当前事实基线与实施账本

本节是截至 2026-09-09 的代码和本地 PostgreSQL 实测记录，不是未来时态。后续每次交付必须更新此处，并把 `Implemented locally/Delivered/Deployed/Integrated/Accepted` 分开。

### 2.1 交付快照

| 项目 | 当前事实 |
| --- | --- |
| 记录时间 | 2026-09-09 22:32 +08 |
| 代码范围 | `main@47a7596c459d24cec01412fd147f2f9c223ed77e`，已推送且与 `origin/main` 一致；工作树干净（仅 `CLAUDE.md` 有本地文档修改，不含代码） |
| 实现提交 | 已提交：`70d4b76`（来源订阅与采集平台）、`bb5ad3a`（简化采集并加入 Social Evidence）、`47a7596`（OpenCLI 社交发现）。**可恢复 Git 交付点已存在**，此前“未提交”的记录作废 |
| 远端 CI | 已在 `47a7596` 运行并**失败**：[run 34352893022](https://github.com/akz142857/Signal40/actions/runs/34352893022)，4 个 job 全红。① `application` 在 `Reject OpenAPI breaking changes` 步骤退出 1，其后的 `npm test`、canary 扫描、evaluation、`db:migrations:verify`、两次 `db:migrate`、`drill:restore`、`build`、`test:render` **全部未执行**（不是 skip，是未运行）；② `workload-images` 的 control/source/render 三个 job 均在 Trivy `vuln,misconfig` 扫描退出 1。**不得以本地全绿替代该结果** |
| CI 阻断项 1：OAS 兼容 | 相对 baseline `bb5ad3a` 检出 4 项 breaking change，同一根因：`source-proposals` 响应的 `url` 由 `"string"` 变为 `["string","null"]`。**已核实为有意变更而非回归**：微信/小红书 OpenCLI 提案提交的是账号名而不是 URL（`test/source-proposals.test.ts` 的 wechat 用例 `url: ''`，`lib/source-proposals.ts:55` 显式投影为 `null`），`url` 同时从 `required` 移除，schema 与代码一致。**处置**：不回退该字段；改为按 §9.2 原设计锚定 baseline——新增 `contracts/openapi.baseline.yaml`（锚定 SHA `47a7596`），CI 由 `--baseline-git-ref ${{ github.event.before }}` 改为 `--baseline contracts/openapi.baseline.yaml`。原配置把「上一个提交」当基线，会让真实破坏性变更在下一个提交后自动消失、而正常 pre-GA 演进每次硬失败。已做负测试：把 `url` 收窄回 `string` 时 checker 仍报 4 项并 exit 1，门禁未被削弱 |
| CI 阻断项 2：镜像漏洞 | 三个镜像的 `Node.js (node-pkg)` 各报 `Total: 11 (HIGH: 10, CRITICAL: 1)`，全部标记 `fixed`，故 `ignore-unfixed: true` 不生效：`tar` 7.5.11(CVE-2026-59873, CRITICAL)、`brace-expansion` 2.0.2(3 项)、`ip-address` 10.1.0、`pacote` 19.0.2/20.0.1、`picomatch` 4.0.3、`sigstore` 3.1.0。**归因已核实**：`docker run node:22-bookworm-slim ls /usr/local/lib/node_modules/npm/node_modules` 确认 6 个包全部属于基础镜像自带的 npm 10.9.8，不是应用依赖（`npm audit --omit=dev` 对生产依赖树报 0）。**升级 npm 不足以修复**：实测 npm@12.0.2 后 `brace-expansion` 仅到 5.0.7（需 5.0.9）、`ip-address` 仅到 10.2.0（需 10.3.1）、`tar` CRITICAL 仍在。**处置**：三个运行层镜像统一删除 npm/npx（`rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx`），控制面 CMD 改为 `node node_modules/vinext/dist/cli.js start`，compose 的 scheduler 改为 node 直调。已确认 `vinext` 仅在 `lint`/`deploy`/帮助文本中调用 npx，`start` 路径不涉及 |
| 最后完整本地验证 | 2026-09-09 22:0x–22:3x 在上述干净树执行：260 项测试 **260 pass、0 fail、0 skip**——此前 3 项 R2/S3 远程对象存储契约本次真实执行并通过（分片上传耗时 21.5 s，为真实网络往返）。`tsc --noEmit`、oxlint、Redocly OAS 3.1 lint、33 项 migration checksum、100 例 evaluation（`gateAccuracy` 1、0 failures）与 production build 均通过。**但本地对象存储测试所用凭据是否为 `R-ROTATE-01` 要求轮换后的新凭据，无法从代码侧判定，该风险仍开放**。OpenCLI 1.8.6 二进制可用，但 `doctor` 显示 Browser Bridge 未连接，真实搜索仍属外部验收待办 |
| 最后完整验证后的改动 | 无代码改动；仅本节事实账本、`DELIVERY-01` 状态与 `CLAUDE.md` 同步 |
| 数据库 | manifest 已扩展到 `0000`–`0032` 共 33 项；`0032` 增加社交发现配置并以 OpenCLI/RSS 双策略 release 替换误导性的“平台公开 Feed”。PGlite fresh install 与本机开发 PostgreSQL `0000`–`0032` 升级均已通过；生产升级证据仍待目标环境执行 |
| 迁移校验 | `drizzle/checksums.json` 覆盖 `0000`–`0032` 精确有序文件集和 SHA-256；runner 在连接数据库前校验文件，并在 `schema_migrations` 保存/核对 checksum；缺项、增项、改写和数据库 hash 漂移均 fail closed。PGlite fresh migration、旧开发 PostgreSQL 19→21→22→23 upgrade 已通过；`0023`–`0032` 的开发/生产升级、隔离 restore 和远端 CI 仍未验证 |
| 可发布结论 | **否**；Foundation 整体为 `In progress`。本轮变化是「可恢复提交」这一半前提已满足，但 `DELIVERY-01` 随即被远端 CI 红结果明确阻断，且阻断点在测试之前——`47a7596` 上没有任何远端测试/迁移/恢复证据。`P0A-STATE-01` 已有本地关闭证据；`P0A-RBAC-01`、`P0A-API-03/04A` 和 `MIGRATION-INTEGRITY-01` 的代码/本地测试已显著推进，但各自仍缺浏览器/安全签字、已发布 baseline 或生产升级等更高层证据 |

后续快照必须绑定单一可还原的 commit/tree，记录基线/实现 commit SHA、全部 tracked/untracked 内容清单与哈希、完整 migration checksum、CI run URL、制品 digest/provenance、目标环境、验证命令/时间、skip 计数和批准人。唯一状态链是 `Implemented locally → Delivered → Deployed → Integrated → Accepted`：本地脏工作树证据不能支持 Delivered，部署了但未连通真实上游不能支持 Integrated，连通了但未签字不能支持 Accepted。

证据登记同样分层，不能用较低层级记录替代较高层级验收：

| 证据包 | 当前状态 | 负责人/批准人 | 可证明 | 不可证明 |
| --- | --- | --- | --- | --- |
| `docs/evidence/SOURCE_INGESTION_LOCAL_2026-09-09.md` | 已登记；本地记录（其描述的脏工作树已于 `47a7596` 提交固化） | 执行人：Codex session；批准人：无 | 该次记录范围内的测试、静态检查、开发 PostgreSQL 迁移、开发对象存储探针和本地镜像构建/rootfs 边界 | Git 交付、远端 CI、签名制品、部署、外部集成、产品/安全/法务验收 |
| 远端 CI evidence | 已生成但为失败记录：`47a7596` 的 run 34352893022 四 job 全红，不构成交付证据 | Owner：交付负责人 | 该 commit 上哪些步骤被执行、哪些因前序失败而未执行 | 任何「测试通过」结论——application job 在 `npm test` 之前即中断 |
| 环境 acceptance pack | 未生成 | Owner：对应工作包；批准人见 15.1 | 制品、目标环境、真实来源、恢复和安全边界 | 未列入 pack 的平台与能力 |
| Social Evidence evaluation pack | 未生成 | Owner：Data/Editorial；批准人：产品与编辑负责人 | 声明级补证、独立性阈值和生产抽样 | 仅凭连接器采集成功推导内容可生产 |

本地证据表必须保留命令或 run ID、基线/制品、环境、执行人、时间、有效期和链接；没有独立批准人的记录只能支持 `Implemented locally`。签名验收包必须另外记录批准角色、批准时间、适用 connector/version、例外和到期日，不得覆盖或改写原始本地记录。

| 来源/能力 | 当前状态 | 已有证据 | 达到 Accepted 前仍缺 |
| --- | --- | --- | --- |
| RSS / Atom | Implemented locally，未 Deployed/Integrated/Accepted | 三步 draft/test/enable UI；独立 XML parser + syntax validator；namespace、`xml:base`、相对 URL、多 link、ETag/Last-Modified/304；受控 Worker | 当前环境将外网 DNS 映射到 `198.18.0.0/15`，真实 SEC RSS 被 SSRF 防线正确拒绝；需在可达公网的生产 egress 环境完成真实增量、重启续采和用户验收 |
| HTTP JSON | Partial, local only；未 Delivered/Deployed/Integrated/Accepted | UI 可配 items/id/kind/title/url/publishedAt/updatedAt/deletedAt/summary/author 及 page/cursor/since；有界页数/条目/字节、cursor 环检测、坏项逐条 rejection、同时间戳 tie-break、结构化 429/Retry-After 与预览；metadata 模式逐页 staged，complete 后原子可见；upsert/tombstone 判别联合和事件状态防旧回放复活 | 仍需真实无凭据 Public JSON 上游的多页/opaque cursor/中断恢复及真实删除/重现验收 |
| 网页/热榜 | Implemented locally | 公开 HTML 的 JSON-LD/可见链接解析、5 MB/100 条上限、无 JavaScript、无登录绕过 | 逐站点真实 URL、浏览器 E2E 与权利验收 |
| 微信公众号 | Implemented locally | `opencli weixin search` 候选发现；可切换到 RSSHub CareerEngine/Newrank/EFB 等第三方 Feed URL；Signal40 负责调度、内容指纹去重和 checkpoint | 安装并实测 OpenCLI/Browser Bridge；逐个第三方路由确认参数、授权、发布主体、编辑/删除与稳定性；OpenCLI 仍不是 canonical 账号订阅 |
| 小红书 | Implemented locally | `opencli xiaohongshu search` 候选发现；可切换到获准第三方 RSS；Signal40 负责调度、去重和 checkpoint | 真实账号搜索、登录态/Bridge、主体映射、编辑/删除语义与权利验收 |
| CSV / JSON 手工导入 | Fallback | 保留现有迁移/排障入口 | 不计入连接器 Accepted |

基础平台实施状态：

- 已实现或已有本地代码路径：来源生命周期与配置哈希门禁、不可变权利 grant、调度/租约/提交复核、异步预览、批量导入、RSS/Public JSON/公开 HTML、微信/小红书 OpenCLI 候选搜索与第三方 RSS、结构化 checkpoint、逐页 staged 后原子可见、origin/rejection 持久化、发布 canary、隔离/删除编排、SLO/预算和运行治理。OpenCLI 由 Worker 以参数数组直接执行，不经 shell；Signal40 不保存其浏览器 Cookie。Social Evidence 已接入 publisher/origin、保守关系分类、不可变人工修正、声明级合格支持和 family↔publisher group 最大匹配。
- 已验证：迁移 `0000`–`0022` 已应用到当前 PostgreSQL，`0023`–`0032` 仅完成 PGlite fresh install 和 manifest 校验。本地回归覆盖 OpenCLI JSON 映射、无 shell 参数、publisher 不伪造、社交提案、公开连接器及 Social Evidence 门禁；3 项真实 R2/S3 契约因此前凭据轮换后尚未恢复而不计通过。
- Experimental / Partial Gate：`publisher_entities`、`source_item_origins`、保守关系分类器、不可变人工修正、声明级合格支持证据和 evidence family 最大匹配已进入滚动语料与项目门禁；未批准 Social Evidence 校准时 social/web 自动生产默认关闭。仍缺已授权真实标注集、真实生产抽样生成的评测报告与 Product/Editorial sign-off，因此不能宣称 Social Evidence Accepted。
- 未完成主线仅为外部验收：真实公开 Feed/网页浏览器 E2E、已授权版本化标注集与生产抽样、Product/Editorial 签字，以及目标环境迁移/恢复/chaos、安全扫描和观察期。OAuth、Agent 与来源凭据基础设施不再列为待办。
- 安全现状：本地已增加 `.dockerignore` Secret/私钥/云配置排除、allowlist-copy 非 root 镜像、Compose 显式 env allowlist、生产 shared-token/fallback 拒绝、镜像 canary 和 CI 扫描矩阵。它们保护当前运行时，但不再派生云 Secret Manager/workload identity 或 OAuth/Agent 建设任务。

### 2.2 当前发布决策

| 决策对象 | 本版裁决 | 对发布的影响 |
| --- | --- | --- |
| Foundation GA 承诺集 | RSS + Public JSON + 来源管理/调度/运行/待办基础平台 | 两条真实来源链路均达到 Accepted 后才可声明 Foundation GA |
| 网页/热榜 | 条件式能力；按站点模板逐个批准 | 没有授权模板和隔离证据时保持 Blocked，不进入承诺集 |
| 公众号/小红书 | 已实现 OpenCLI 候选搜索与获准第三方 RSS 双策略；不自建账号托管或 Cookie 服务 | OpenCLI 搜索不声明 canonical 账号订阅；真实 Bridge/账号或真实获权 Feed 未验收时只能保持 Implemented locally |
| Social Evidence | 与“连接器可采集”分开验收 | 连接器 Accepted 仍只允许内容进入发现层，不能自动放行生产 |
| 多租户 | 本期明确不做 | 当前仅允许固定单 team；开放前必须完成复合租户约束与越权测试 |
| 手工导入 | Fallback | 可用于迁移/排障，不计入任何连接器 Accepted 或无人值守验收 |

本版没有把“所有平台都接通”作为 Foundation GA 的前置条件；它要求每个列入 release manifest 的连接器独立满足合法性、稳定性、恢复、产品和运维验收。未列入承诺集的平台必须保持隐藏、Blocked 或 Experimental，而不是通过模糊文案把未来能力包装成当前能力。

## 3. 目标用户体验

### 3.1 用户角色与职责

当前应用角色包含 `researcher/editor/admin/producer/publisher/auditor`。来源 action × role 矩阵、researcher/editor 独立 proposal、admin 异人批准、提案者不可自批、legal hold 建立者不可自行解除、checkpoint 请求者不可自行批准已经实现；批准 proposal 只创建 `rights=pending` draft 和 provisional request。`team_members.can_approve_source_rights` 与 `team_members.can_manage_source_legal` 都是独立于 admin 的显式 capability：服务端分别要求 active admin + 对应 capability；权利请求提交者不得自批，legal hold 建立者不得自解，创建 hold 前还必须存在另一名有效法律操作人。治理页可分别配置两种 capability；来源页提供证据/条款摘要审批，以及保全记录查看、建立、异人解除和依法删除入口。成员能力降级与 hold 建立锁定同一有效管理员集合，active hold 期间不能降至两人以下。跨角色真实浏览器正反矩阵及 Security/Legal sign-off 尚未完成，因此 `P0A-RBAC-01` 仍是 In progress。

| 能力角色 | 职责 | 不得做的事 | 当前映射 |
| --- | --- | --- | --- |
| researcher / 普通编辑 | 雷达、来源/运行只读、发起 proposal、对已启用来源请求立即采集 | 自批权利、启用/删除来源 | proposal、自有提案读取、只读来源与立即采集权限已本地实现；浏览器矩阵未验收 |
| source operator | 修改无敏感采集配置、发起测试/补采、处理运行故障 | 批准权利或 legal hold、查看 Secret | 目标 capability，当前由 admin 代理 |
| rights approver | 核验来源主体、条款和使用范围，签发不可变 grant | 以自我声明代替证据，或因 URL/配置变化自动续权 | 独立 capability、异人审批、UI/API/审计已本地实现；真实任命与 Legal sign-off 未验收 |
| release operator | connector/version kill、shadow、quarantine 和恢复演练 | 单人改写 checkpoint | 当前由 admin 代理，cutover 有双人门禁 |
| legal operator | 建立/解除 hold、批准删除范围与最小保留 | 单人自建自解 hold | 独立 admin capability、两人存续门禁、并发锁序、UI/API/OAS/审计和负向 PG 回归已本地实现；真实任命、浏览器矩阵与 Legal sign-off 未验收 |
| auditor | 只读查看配置版本、权利证据、连接测试、运行、删除回执和审计 | 任何写入 | 部分实现 |
| system/workload | 按冻结策略调度、退避、采集、提交、暂停并产生待办 | 代替人批准权利、解除 fail-closed、越过 workload scope | 本地 capability 边界部分实现，生产身份未验收 |

目标提案流程使用独立对象：`proposal_pending → proposal_approved | proposal_rejected`，批准后才创建 `source_config` draft。proposal 不得复用 source lifecycle 枚举，发起人不得批准自己的 rights 或高风险连接。待办必须显示处理 capability、业务负责人和可执行下一步，不能只给技术错误。

### 3.2 默认三步接入

普通编辑不需要理解连接器、CSS 选择器、游标、载荷保留或证据枚举。默认流程压缩为：

1. **定位来源**：仅展示当前 release manifest 中可连接的来源类型；Foundation 阶段为粘贴 RSS/Atom 或 Public JSON URL。公众号、小红书与热榜只在对应 connector 进入 Accepted 后才出现在可执行向导；
2. **连接并确认**：RSS/Public JSON 直接预览；平台连接器仅在 Spike 已确认稳定授权路径后展示 canonical account ID、认证主体、主页和最近 3–5 条内容；
3. **测试并启用**：确认服务端推导的证据类型、首次采集范围和推荐频率，异步测试通过后启用，并显示预计首次出数时间。

无法唯一识别的同名账号必须要求用户确认，不能以显示名称作为持久身份。

用户从点击“添加来源”到得到可读测试结果，最多经过 3 个顶层向导步骤；弹窗、异步等待和错误详情不计为新步骤，但不得跳转到其他管理页才能完成。后端 source lifecycle 仍保留 `draft → connecting → tested → enabled`。连接、测试或启用失败时保留 draft 和已完成步骤，从原失败点可在 2 次操作内继续，不重新填写已有配置。启用确认必须显示预计首次导入条数、回看时间窗、请求数、费用和完成时间；默认最多最近 7 天或 20 条，超过阈值必须转为有预估、有确认的显式 backfill。

启用前执行 Scheduler、`required_capability` Worker 和 egress 预检。能力不足时 source lifecycle 保持 `tested`（如已启用后失能力则保持 `enabled`），另由 `health_status=waiting_capacity` 显示明确的非绿色状态；页面显示负责人、缺失能力和修复动作，不能把“配置有效”表现为“正在采集”。

### 3.3 高级设置

高级设置包含：

- 采集档位：“尽快”“标准”“低频”；具体最小间隔由连接器能力和供应商配额钳制；
- 每次最大条数与补采时间窗；
- JSON 字段映射和分页方式；
- 授权原始载荷的保留层级和期限；
- 通知、成本上限和来源优先级；
- 管理员专用的自定义网页抽取配置。

证据类型由服务端推导并默认锁定。管理员确需修正时必须填写原因，保存审计并重新计算受影响主题。

界面不能把所有情形都笼统称为“授权”：公开 RSS/网页显示“公开来源使用确认”，组织或供应商 API 显示“组织/API 授权”，需要用户会话的平台显示“账号登录连接”，并分别解释取得的数据、允许用途和撤销方式。

### 3.4 批量接入

支持 OPML、来源清单 CSV、批量粘贴账号/URL 和复制现有来源策略。批量导入后集中预览异常项，只逐个处理歧义或失败来源。批量操作仍需逐来源完成身份确认、权利判断和连接测试，不能通过一次总勾选绕过。

### 3.5 日常来源页

来源卡片显示：

- 平台、canonical identity 和服务端认定的证据类型；
- `draft/connecting/tested/enabled/degraded/paused/archived` 生命周期；
- 最近成功、下次计划、最近有效内容和预期更新缺口；
- 接受、拒绝、重复和空结果数量；
- 登录/授权状态、配额余量、本月请求量和预计成本；
- 对应 Worker 能力是否在线；
- 可操作的错误原因。

卡片必须把三种状态分开展示：**采集健康**回答“是否稳定取得数据”，**权利健康**回答“当前是否允许使用”，**证据状态**回答“是否支持具体声明”。三者互不替代：采集成功不代表证据可靠，账号已授权也不代表可进入生产。

主要操作包括立即采集、停用、重新连接、补采、查看运行、归档和撤回内容。普通用户不需要进入终端。

### 3.6 雷达的两层状态

雷达不能只显示已经通过生产门禁的内容，否则用户会误以为公众号或小红书没有采到数据。候选明确分为：

- **发现信号**：已采集、相关且值得关注，但可能仍缺原始证据；
- **可进入生产**：声明已有独立原始证据支持，并通过现有门禁。

卡片显示“正在自动补证”“缺少公司公告”“疑似同源转载”等原因。生产门禁限制进入项目，不隐藏合规采集到的信号。

### 3.7 雷达与编辑负荷控制

- 同一事件聚类后默认只展示一个代表信号，可展开查看所有来源；
- 支持关注实体/主题/账号、屏蔽词、静音来源和稍后处理；
- 每来源和主题设置每日展示上限，低优先级条目进入摘要而不是逐条制造待办；
- 排序综合新鲜度、来源可信度、跨来源增长和财经相关性；
- 每张卡解释“为什么出现”和“为什么尚不可生产”；
- 高流量社交来源必须通过编辑工作量验收，不能以采集条数最大化作为成功标准。

## 4. P0 外部可行性门禁

通用 RSS/HTTP connector contract v1 已在本地实现中冻结；微信、小红书和浏览器的扩展契约不得凭空套用 v1，必须先完成各自 3–5 工程日可行性 Spike 再冻结。供应商沟通、合同、平台审批时间另计。

| 平台 | 必须确认 | 结果 |
| --- | --- | --- |
| 微信公众号 | 是否能按 canonical account ID 订阅、字段、游标、登录方式、配额、授权范围、成本 | `go / constrained / blocked` |
| 小红书 | 官方 API、企业授权、合规供应商或本机代理是否存在稳定路径 | `go / constrained / blocked` |
| 目标热榜 | 是否允许采集、更新规律、静态/动态页面、结构稳定性、正文使用范围 | 每个站点独立决策 |
| JSON/RSS 供应方 | API/Feed SLA、认证、分页、速率和内容使用范围 | 每个来源独立决策 |

每个平台 Spike 必须输出实际响应样本与字段字典、canonical identity 取得方法、授权流程、增量/删除/编辑语义、配额/延迟/成本、数据权利、外部资源和明确退出条件。权利部分还必须引用官方 API/供应商合同/平台 ToS 的具体版本和生效日期，并回答是否允许自动访问、存储、AI 处理、衍生、内部编辑使用与对外再发布，以及 permitted fields、主体身份、数据地域/跨境/subprocessor、编辑/删除传播、保留/退出/导出、DPA、事故通知、删除 SLA 和审计权。`robots.txt` 或“公开可访问”只是技术信号，不能单独作为使用权依据。

`blocked` 是有效结论：对应平台从可选入口隐藏或标记“当前不可连接”，不使用不稳定爬虫伪装完成。它不阻塞基础连接器平台 GA，但阻止对应平台被标记为 Accepted。

Blocked 决策记录必须包含原因、证据、决策人、替代路径、最后评估时间和下次复核日期。入口使用“当前不可连接”，不能暗示已承诺恢复；到复核日期后由产品与安全负责人重新确认平台政策、供应商和授权能力。

任一 connector 的 ToS/API/合同版本或证据到期、canonical identity/删除/编辑语义不再可验证、登录自动化或 cookie custody 失去批准、封号/配额风险越界、DPA/subprocessor/数据地域变化，或删除/撤销/退出路径失效时，必须立即从 Accepted 降级为 constrained/Blocked，停止新采集并隔离在途结果，不等待下一人工复核。

## 5. 来源领域模型

### 5.1 分离平台、适配器和证据属性

| 维度 | 示例 | 归属 |
| --- | --- | --- |
| `platform` | `rss/http_json/web_page/wechat/xiaohongshu` | 用户选择的平台 |
| `adapter` | `rss/http/web` | 服务端注册的执行插件 |
| `source_type` | `social/media/market/filing/company` | 服务端治理的证据属性 |
| `publisher_entity` | 公司、媒体集团、监管机构、平台账号主体 | 独立性和权利判断 |
| `required_capability` | `source:rss/source:browser/source:wechat` | 队列路由 |

前端不能自由声明 adapter、source type 或 Worker 能力。服务端注册表返回允许的配置 schema、认证方式、最小频率和运行能力。

### 5.2 来源生命周期

```text
draft → connecting → tested → enabled
  │          │          │        │
  │          └──────────┴────────┼→ degraded → connecting
  │                              ├→ paused → connecting
  └──────────────────────────────┴→ archived
```

状态必须按实体分离，不得在 API、UI 或文案中把下列枚举混用：

| 字段/实体 | 冻结值 | 含义与 UI 映射 |
| --- | --- | --- |
| proposal status（目标） | `proposal_pending/proposal_approved/proposal_rejected` | 普通编辑的申请对象；不是 source lifecycle |
| `source_configs.lifecycle_status` | `draft/connecting/tested/enabled/degraded/paused/archived` | 已在代码、数据库和 OpenAPI 冻结的七态；`failed`、`waiting_capacity`、`rights_blocked`、`held` 都不是这个字段的值 |
| `source_configs.health_status` | `unknown/healthy/degraded/paused/waiting_capacity` | 运行健康投影；`waiting_capacity` 只在此展示，来源 lifecycle 仍保持 `tested` 或 `enabled` |
| `source_configs.rights_status` | `pending/approved/revoked/expired` | 权利状态；非 approved 一律阻断调度/提交 |
| `ingestion_runs.status` | `queued/running/succeeded/partial/failed/cancelled/rights_blocked` | 运行状态；`rights_blocked` 是终态，不会写回 source lifecycle |
| `ingestion_runs.quarantine_status` | `none/held/released/discarded` | 已提交批次的可见性/处置；不是运行成功状态 |
| connector release mode | `disabled/shadow/enabled` | connector/version 发布开关；与 connector acceptance state 正交 |
| connector acceptance state | `Proposed/Implemented locally/Delivered/Deployed/Integrated/Accepted/Blocked` | 交付证据等级；`Experimental/Deprecated` 可作附加标签 |

`P0A-STATE-01` 必须使数据库、TypeScript、OpenAPI、UI 文案和负向测试共用这张表；任何新状态必须先修改契约与迁移，不得以“投影为”方式引入未登记值。

- 先持久化禁用的 draft，再创建测试作业；
- 只有配置哈希与最后测试哈希一致且权利记录有效时才能启用；
- 修改 URL、主体、映射或适配器后自动退回待测试；
- `health_status` 由最近成功、结构化错误、连续失败、授权到期和重试时间确定性投影，不能任意覆盖。

### 5.3 `source_configs` 扩展

- `platform`、`locator_json`；
- `owner_team_id`、`business_owner_id`、`publisher_entity_id`；
- `collection_policy_json`、`capabilities_json`；
- `lifecycle_status`；
- `last_error_code`、`last_error_detail_redacted`、`retry_after`、`backoff_until`；
- `next_run_at`、`last_attempt_at`、`last_healthy_at`、`consecutive_failures`、`last_tested_at`；
- `config_hash`、`last_tested_config_hash`，以及只随法律使用范围变化的 `rights_config_hash`；
- `checkpoint_json`、`checkpoint_version`，以及完全独立的 `backfill_checkpoint_json`、`backfill_checkpoint_version`；旧字段在迁移期双读；
- `publisher_entity_id` 和服务端确定的 `source_type`；
- `active_run_id`、`archived_at`。

来源唯一性至少使用 `(team_id, platform, locator_hash)`；单团队版本也保留 team 维度，避免未来扩展时来源串租户。

当前 Foundation GA 明确限定为**单租户部署**：实例只能启用一个固定 team，API 不接受客户端任意选择 team，Worker/对象键/审计均绑定该固定 team。若未来开放多租户，必须先新增 `teams`、复合 `team_members(team_id,user_id)`，并让 source/run/job/session/grant/origin/对象键及所有按 ID 查询从 actor team 约束；仅保留 `team_id='default'` 不算租户隔离。

### 5.4 连接、权利与身份

`source_rights_requests → source_rights_grants` 的本地状态机已实现，但**真实法律有效性仍未验收**。`publicUseConfirmed` 现在只创建 `pending` provisional request，创建/修改/批量导入都不能直接写 approved grant；只有另一名 active admin 且显式拥有 `can_approve_source_rights` capability，提交主体、治理后的 `sourceType`、允许字段、地域、opaque evidence reference、evidence SHA-256、terms version、terms snapshot SHA-256、授予/到期时间后才能签发 grant。审批确认的 `sourceType` 必须与冻结请求一致；不一致时 409 并要求先修改来源、生成新请求，不能静默提权。请求绑定 `source_version + rights_config_hash`，配置漂移、过期、撤销、自批、未知 dossier 字段均 fail closed。浏览器只返回引用和 dossier hash，不返回证据/条款正文。真实 publisher entity/evidence family 目录映射、evidence artifact、条款解释、复核日期和 Legal sign-off 仍属外部 gate。

历史预留的连接会话、PKCE 和来源凭据表已由 `0031` 删除；当前接入只使用公开 URL、来源 draft、异步测试、权利审批和启用状态机。

版本化 `source_rights_grants` 包含 principal/provider、permitted fields、purpose、usage scope、territory、granted/verified/expires/revoked 时间、verified_by、evidence reference/hash 和 terms version/snapshot hash。调度器只认当前有效授权；过期或撤销时原子停用来源、取消未开始作业并产生待办。

每条 grant 是不可变版本，通过 `supersedes_grant_id` 串联，并用约束保证每来源只有一个当前有效版本。系统定期复核和预告到期；调度、租约和提交三个边界都要重新校验 grant/config version。在途抓取若于提交前失权，不写 article/origin、不推进 checkpoint，run 转 `rights_blocked/quarantined`，已上传 raw 进入删除队列并产生去重待办。

`publisher_entities` 保存法定主体、所有权集团、认证标识和人工校正历史。source type 和证据独立性由它与受控来源目录共同决定。

每个来源必须有 `owner_team_id` 和业务负责人。当前本地实现已支持 active 成员/角色校验、版本化所有权转移、成员变更前的影响提示、变更后的去重待办与周期复核；真实负责人离职演练仍未 Accepted。

### 5.5 `source_item_origins` 与证据家族

包含 `source_config_id`、`namespace`、`platform_item_id`、article/revision/run ID、canonical URL hash、带版本的内容指纹、`original/repost/quote/syndicated/unknown` 关系、`evidence_family_id`、`publisher_entity_id`、首见/末见/删除时间、算法置信度和人工修正记录。

唯一约束至少是 `(source_config_id, namespace, platform_item_id)`。历史或低置信度关系标记 `unknown` 并 fail closed。门禁按 `evidence_family_id + publisher_entity_id` 计独立性，不再按来源显示名称计数。

统一的 `NormalizedSourceItem` 必须是判别联合，不得要求删除事件伪造标题或 URL：

- `kind='upsert'`：必填 `namespace/platformItemId/title/url/publishedAt`；可选 `updatedAt/author/publisherCanonicalId/body/summary/metrics/relationHints`；
- `kind='tombstone'`：必填 `namespace/platformItemId/deletedAt/provenance/identityStrategy/identityConfidence`；不接受正文、伪造标题或伪造 URL。未知 item ID 的 tombstone 幂等记录但不建立空文章；重复删除不重复触发下游；删除后重现必须以平台版本/更新时间与人工政策裁决，不默认复活。

两种事件都携带字段 provenance、`canonicalUrlVersion` 和 `contentFingerprintVersion` 中适用的版本。无平台 ID 的 RSS 按 GUID → canonical link → 稳定内容指纹的顺序生成身份并记录策略版本。upsert 编辑创建 revision；tombstone 只标记对应 origin 并触发派生重算。连接器不得提交可直接提权的 `sourceType/publisherEntity/evidenceFamily`，这些字段由控制面治理。`P0A-CONTRACT-DELETE-01` 在任何声称支持编辑/删除的 connector 前必须关闭。

独立证据数不是两个集合大小的简单最小值，而是对“合格 origin—evidence family—publisher ownership group”关系图做最大独立匹配；`unknown`、低置信度或只由 URL/标题指纹生成的 family 不进入合格边。算法版本、输入快照和人工修正都必须可追溯。

### 5.6 调度、运行与删除

`ingestion_runs` 增加 `scheduled_for`、trigger、required capability、connector/payload version、checkpoint before/after、结构化错误、request/byte/accepted/rejected/duplicate 计数、fetch/queue/commit 分段耗时和 shadow/quarantine 状态。

通过部分唯一索引或 `active_run_id` 保证每个来源最多一个 queued/running 运行；定时运行唯一键为 `(source_config_id, scheduled_for, trigger='schedule')`。

保留策略分别覆盖原始载荷、规范化内容、origin 元数据、指标、派生主题/项目以及审计/legal hold。产品操作区分：

- **停用**：停止新采集，保留现有数据；
- **归档**：从日常列表隐藏，保留最小审计；
- **授权撤回**：停止使用并解绑/重算派生主题；
- **依法删除**：清除允许删除的正文、原始载荷和派生展示，仅保留法定最小审计事实及不可逆删除回执。

撤权或删除必须向下游传播：未进入生产的候选立即重算并可能锁定；进行中项目切换人工复核；已生成未发布资产进入隔离；已发布内容产生更正/撤回待办。系统不得把“已产生待办”表述成“已从外部平台删除”，外部删除必须有平台回执或人工确认。

所有 schema 变化通过新的 PostgreSQL Drizzle 迁移交付，不修改已应用迁移。

### 5.7 Raw payload 与删除生命周期

`raw_payload_uploads(id, team_id, source_config_id, ingestion_run_id, state, object_key, sha256, byte_size, created_at, updated_at, expires_at, committed_at, delete_after, deleted_at, delete_attempts, delete_lease_expires_at, last_error_redacted)` 已由 `0006` 建立。状态为 `initiated/uploaded/committed/aborted/expired/deleting/deleted`；`deleting` 使用 5 分钟租约，清理进程崩溃后可重新领取。run commit 只接受同 team/source/run、状态为 uploaded 且未过期、hash/bytes 一致的对象并原子转 committed。Sweeper 有界扫描未 committed TTL 和 committed retention，R2 lifecycle 只作第二层兜底。

删除作业覆盖 raw、normalized item、origin、派生展示及允许删除的指标，并生成不含正文、个人数据和 Secret 的不可逆 receipt hash。Legal hold 优先于删除；解除后自动重试。对象存储部分失败必须保留可重试状态，重复执行同一删除请求返回相同或可串联的回执，不能在未真正删除时标记完成。

## 6. 连接器执行框架

### 6.1 注册表与有界页面流

新增 `lib/source-connectors/`。注册表定义 connector ID/版本、配置 schema、平台、认证、最小频率、required capability、checkpoint schema、补采/正文/删除/指标能力及域名范围。

连接器返回有界页面流，不把完整载荷堆在内存：

```ts
type SourcePage = {
  pageKey: string;
  pageOrdinal: number;
  items: NormalizedSourceItem[];
  rejections: ItemRejection[];
  checkpointBefore: VersionedCheckpoint;
  checkpointAfter: VersionedCheckpoint;
  isFinal: boolean;
  requestCount: number;
  byteCount: number;
};

type SourceConnector = {
  validate(config: SourceConfig): ValidationResult;
  test(input: ConnectorTestInput): Promise<ConnectorTestResult>;
  pull(input: ConnectorPullInput): AsyncIterable<SourcePage>;
};
```

原始载荷通过受控存储 sink 流式写入。单页条数、总页数、字节、请求和执行时间都有硬上限；cursor 循环和超限进入结构化错误。连接器只负责取得和规范化数据，接纳、去重、修订、重算、门禁与审计由统一提交服务完成。

### 6.2 统一受控出站请求器

RSS、JSON、HTML 和连接测试复用同一 egress client：

- 单次解析并把已验证 IP 固定到实际 TCP/TLS 连接，同时保留 Host 与 SNI；
- 应用层固定到 IANA 2025-10-09 IPv4/IPv6 special-purpose registries，拒绝其中的目标以及组播；IPv4-mapped、NAT64 与 6to4 先解包后按真实 IPv4 目标裁决，并有相邻公网前缀负向回归。目标环境的默认拒绝 egress、代理旁路、DNS/CNAME/逐跳 redirect 与 packet evidence 仍由 `P0A-NET-01` 关闭；
- 限定协议和端口；
- 每次重定向重新检查 URL、DNS、IP、域名和次数；
- 跨源重定向剥离 Authorization、Cookie 和自定义 Header；公开来源配置本身不得携带这些认证值；
- 禁止 HTTPS 降级到 HTTP；配置 URL 拒绝敏感 query 键、签名参数和 userinfo，测试 preview/final URL 向浏览器输出前移除 fragment 并脱敏/移除敏感 query，Secret 不得进入 URL、游标、错误或任何浏览器响应；
- 限制解压前后体积、超时、User-Agent 和代理；
- 生产以出站代理/网络策略作第二层保护。

验收覆盖 DNS 检查与实际连接返回不同 IP 的 rebinding，不只测试私网字面量。

### 6.3 服务隔离

当前来源主线只接入经明确权利确认的公开 RSS、Public JSON、HTML/JSON-LD，以及显式选择的 OpenCLI 候选搜索。控制面、source Worker、render Worker 和发布进程继续使用独立 token、环境变量 allowlist、非 root 镜像和最小代码构建上下文；来源 credential provider/Broker、OAuth/PKCE 和自研本机 Agent 代码已删除。OpenCLI/Browser Bridge 属于外部运行依赖，其登录态不进入 Signal40 数据库或 API。

### 6.4 错误与重试

| 错误 | 是否重试 | 行为 |
| --- | --- | --- |
| `RIGHTS_BLOCKED` | 否 | 停用并取消未开始作业 |
| `SCHEMA_CHANGED` | 否 | 隔离结果，产生模板修复待办 |
| `PERMANENT_UNSUPPORTED` | 否 | 标记来源/平台不可用 |
| `RATE_LIMITED` | 是 | 尊重 Retry-After，带 jitter 退避 |
| `NETWORK` / 上游 5xx | 有界 | 指数退避，超阈值转 degraded/待办 |
| `INVALID_ITEM` | 单条隔离 | 运行可 partial，保存可重放 rejection |

健康投影、结构化错误和待办在同一事务中更新，恢复后关闭或标记对应待办已恢复。

没有匹配 capability 的在线 Worker 时不创建无法执行的无限积压；来源页在 60 秒内显示部署原因，并在待办箱生成去重后的运维事项。

如果来源已测试但运行能力不足，健康投影为 `waiting_capacity` 而不是 `healthy`。补齐能力后由系统重新预检并恢复，不要求用户重新授权或重建来源。

## 7. 具体连接器

### 7.1 RSS / Atom

- 使用禁用外部实体和外部资源的标准 XML parser，替换正则；
- 支持 RSS 2.0、Atom namespace、`xml:base`、相对 URL和多个 link；
- 保存前异步测试并预览最近 5 条；
- 支持 ETag、Last-Modified、304和有界补采；
- 区分空 Feed、长期无更新、XML 损坏、证书失败和发布时间异常；
- 空结果结合历史更新规律判断 freshness，不自动算成功。

### 7.2 HTTP JSON

- UI 配置 items、id、title、url、publishedAt、summary 和 author；
- 测试结果提供逐字段预览；
- 单条错误进入 rejections，不因一条坏记录丢弃整批；
- 支持 cursor/page/since 及供应商 opaque cursor；
- API Key/Header 只引用 Secret；
- 支持同时间戳 tie-break，防止漏采乱序与补发条目。

### 7.3 网页与热榜

普通编辑只选择版本化站点模板，不填写 CSS 选择器；自定义选择器仅在管理员高级模式开放并要求测试预览。静态 HTML 优先用 DOM parser，只有确实依赖 JavaScript 时才交给隔离浏览器 Worker。结构变化必须进入 `SCHEMA_CHANGED`，不能静默提交空语料。

浏览器 Worker 最低隔离规格：独立镜像/身份/部署池，非 root、只读根文件系统、无宿主挂载、临时 profile、seccomp/AppArmor/no-new-privileges/cap-drop、CPU/内存/PID/磁盘/下载/时间/并发上限、默认拒绝内网及控制面网络、仅允许来源域与必要 CDN、禁用扩展/`file:`/持久 service worker/弹窗/任意下载，并在任务后销毁环境。主文档、全部 subresource/redirect/WebSocket/DNS/QUIC/UDP/WebRTC/STUN/prefetch/service worker/下载必须通过同一默认拒绝 egress，禁止 direct DNS/socket 和代理旁路。

HAR、trace、截图、录像、console、crash dump、download、profile、cookie/localStorage/IndexedDB 都是敏感 raw，默认不持久化；确需留存时必须脱敏、加密、绑定来源/权限/TTL 并进入删除清单。平台 Spike 必须证明访问路径获授权且不会把长期 Secret 注入浏览器导航。

### 7.4 微信公众号

当前实现提供两条明确区分的路径：`opencli weixin search <公众号名称>` 用于周期性候选发现；或读取用户提供、已获准使用的 RSSHub CareerEngine/Newrank/EFB 等第三方 Feed。OpenCLI 输出未提供作者时保持 publisher unknown，不把搜索词伪造成主体。第三方路由由用户/部署方提供完整 Feed URL，Signal40 不收集 Newrank Cookie，也不代建 EFB→Telegram 桥。只有第三方 Feed 能核验 canonical account ID 且通过真实验收时，才能宣称严格账号订阅。

### 7.5 小红书

当前实现调用 `opencli xiaohongshu search <账号名称>` 做候选发现，或读取获准的第三方 RSS。浏览器与 Browser Bridge 是 OpenCLI 的运行前置，不是 Signal40 的凭据系统。真实验收仍必须确认 canonical identity、字段、更新/删除语义、频率、登录失效和内容保存边界；未完成前不标记 Integrated/Accepted。

## 8. 调度、队列与原子提交

### 8.1 调度领取

Scheduler 以 `ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED` 在短事务中领取 enabled、权利有效、已到期且不在退避期的来源。事务内校验 active run，创建 ingestion run/job 并推进 `next_run_at`。

必须定义 UTC cron 与显示时区、停机补跑上限、公平排序、`scheduled_for` 幂等、手动/定时串行规则和 429 退避，避免停机恢复形成洪峰或大量来源下发生饥饿。

### 8.2 能力路由

保留 `jobs.kind='ingestion'`，新增 `required_capability`、`payload_schema_version` 和整数 `required_capability_protocol_version`。Worker 分别注册 jobKinds、capabilities 及每项 capability 支持的最大协议版本；租约同时做能力与整数协议兼容匹配，并建立 `(required_capability,status,available_at)` 索引。产品/镜像版本只用于观测，不参与租约授权。自由格式 `minimum_worker_version` 不得再作为租约门禁；它只在滚动升级期作为旧控制面显式写入的废弃兼容列存在，新代码不读取，旧控制面退出后由独立 contract migration 删除。这样既避免产品版本和协议兼容产生双重真相，也避免 expand 阶段先破坏旧控制面；旧 Worker 不得租到不能理解的新连接器任务。能力路由不代替容器和权限边界。

Worker 不能通过请求体自提权。控制面从服务 token policy 得到 `allowed_capabilities`，心跳所报能力只能是其子集；登记与租约都取交集，越界声明拒绝并审计。兼容性统一使用 capability→max protocol 整数映射；connector version 与协议版本分离。

### 8.3 版本化 checkpoint

Connector-owned JSON 至少包含 schema/connector version、opaque cursor、watermark、同时间戳 tie-break item ID、分页续点及适用的 ETag/Last-Modified。Live 与 backfill checkpoint 分离。只有完整页面被接纳，或失败条目进入稳定 rejection/DLQ 后才能单调 CAS 推进；旧运行不能覆盖新 checkpoint。

### 8.4 原子提交

单页提交在一个 PostgreSQL 事务中：

1. 锁定 ingestion run 和 source config；
2. 校验 lease owner/epoch、source version 和 checkpoint before；
3. 重新校验来源仍可用、当前 grant、permitted fields、usage scope 与 grant/config version；
4. 幂等写入 origin、article 和 revision；
5. 保存 item rejection 与运行计数；
6. CAS 推进 checkpoint；
7. 标记页面/运行提交状态；
8. 更新来源健康与待办；
9. 提交事务。

逐页事务只把 article/origin 写入 run-scoped staged 可见性；只有 `complete` 对 final marker、连续 ordinal、计数、checkpoint 和权利复核全部成功后，才一次性转为对用户可见，并在事务后触发一个独立幂等主题重算作业。run 未完成、失败或被 hold 时，中间页不进入雷达、证据门禁或生产。R2 原载荷先流式上传再提交引用；DB 提交失败产生的孤儿对象按上传会话和 TTL 清理。每个边界执行故障注入与重放，包括 Worker 在抓取、上传和 DB commit 前后被强杀。

上述 staged visibility 已由 `P0A-VISIBILITY-01` 本地实现并完成专项回归：逐页只写内部 staged payload 与运行 checkpoint，complete 才发布 article/origin、推进公开 checkpoint 和入队一次重算。固定 seed 的本地前置演练已证明事务回滚和 running ingestion 过期租约接管；目标环境进程强杀、多 Worker 与并发故障注入仍由 `P0C-DRILL-01`、`P1B-CHAOS-01` 验证。

### 8.5 逐页提交与运行终结协议

- `PUT /api/v1/ingestion-runs/{runId}/pages/{pageKey}` 幂等提交单页，唯一键为 `(run_id,page_key)`；同 key 同 hash 重放返回首次结果，不同 hash 冲突拒绝；
- 中间页可按 CAS 单调推进可恢复 checkpoint，但 run 保持 running，`active_run_id` 不释放；
- `POST /api/v1/ingestion-runs/{runId}/complete` 校验最后已提交页、连续 page ordinal、累计计数、final 标志和 raw manifest 后，才终结 run 并释放来源；
- HTTP 响应丢失时 Worker 重放 page key；Worker 重启从最后 committed page checkpoint 恢复；
- 任一页失败时，不得假装 complete；只有稳定 item rejection/DLQ 可以随已提交页推进，未稳定处理的错误保持可恢复状态。

当前 HTTP JSON `metadata` 路径已实现本协议：Worker 先读取恢复视图，再逐页 PUT，并仅在 final 页已持久化后调用 complete。服务端自行计算请求体 hash；同一 page key 只允许同内容、同 lease epoch 重放，ordinal/checkpoint-before/CAS、累计计数、final marker 和终结时的 connector/rights/source version 均会复核。一个运行可跨重试 lease epoch 延续，但旧 epoch 不能写入当前租约。当前 RSS、网页、raw-retention HTTP JSON 和 shadow 使用有界运行级原子提交；它们尚未完成真实进程强杀和上游网络中断验收，不能把本地协议 smoke 解释为外部 Integrated/Accepted。

## 9. API 与权限

采用 OpenAPI-first；端点定义 request/response、错误码、幂等键、版本冲突、分页、取消和脱敏规则。

来源配置、测试、启用、运行、backfill、checkpoint、archive、内容撤回、legal hold、quarantine、证据 origin 修正和 pipeline 重算均使用明确的请求/响应契约与统一结构化错误。Actor 与 Worker 读模型分离，公开 DTO 使用 allowlist；来源凭据、连接会话、Broker 与 disconnect API 已从代码和 OpenAPI 删除。契约回归会递归枚举来源路由、解析全部本地引用，并核对 RBAC action 与已登记操作。

当前契约回归会递归枚举已实现的来源配置、连接器、采集运行、pipeline 和受限 Worker 路由，并逐一核对每个导出的 HTTP method 已登记到 OpenAPI；新增隐藏端点或漏登记方法会直接使测试失败。

完整 API gate 仍未关闭；`P0A-API-01..02` 已本地关闭，`P0A-API-03` 的运行时/OAS/回归、公开 DTO 合成 canary 扫描和可接收外部制品的扫描命令，以及 `P0A-API-04A` 的 lint/checker/CI wiring 已本地实现，但前者仍缺真实浏览器 HAR/录像及目标环境 log/trace/snapshot/export 扫描与 Security sign-off，后者仍需远端 required-check 证明；`P0A-API-04B` 必须等待首个已发布 SHA。不能用“运行时已经返回字段”替代文档契约，也不能用“OpenAPI 已描述”替代运行时回归。

### 9.1 浏览器可见读模型

来源列表/详情的 actor API 与 Worker runtime API 必须分离。迁移目标是新增 workload-only 读取契约（例如 `GET /api/v1/worker/source-configs/{id}`），迁移 source Worker 后删除其对 actor detail 的依赖。不允许同一 OpenAPI response schema 根据 token 类型暗中返回不同字段。

浏览器响应采用 allowlist DTO，所有对象设置 `additionalProperties: false`：

- 来源卡片可包含公开名称/平台/适配器、业务负责人、生命周期/健康/权利状态、调度与限额、脱敏成本、保留策略、时间/计数、`hasActiveRun`、`checkpointVersion`、删除状态和稳定公开错误码/脱敏说明；
- 浏览器禁止取得 checkpoint/cursor/ETag 原值、对象 key、raw 上游 body/header、内部 job/lease 字段、未脱敏 `last_error`、任意配置 JSON，以及带 userinfo、fragment、敏感 query 或签名参数的 URL；
- 可编辑配置通过专用 `publicConfig` schema 显示，只包含已登记 connector 的用户可编辑字段；不得直出 `config_json/locator_json/capabilities_json`；
- 测试 preview 每项只允许 `title/url/publishedAt/author?/summary?`，capabilities 只允许经评审的布尔/枚举/脱敏 URL；删除记录只返回状态、阶段、脱敏错误和不可逆 receipt hash；
- 公开错误只包含稳定 `errorCode`、公开安全消息、correlation ID 及严格结构的 issues；不允许任意 object 透传。

`P0A-API-03` 关闭必须同时具有 endpoint × role × field 矩阵、OpenAPI/runtime 等值回归、以 canary Secret 覆盖 config URL/redirect/finalUrl/cursor/checkpoint/ETag/error/preview/audit/log/trace/snapshot/export 的扫描、浏览器 HAR/录像、镜像/制品扫描和 Security 独立签字。

本地/CI 入口为 `npm run source:sensitive-canary`。命令使用 `SIGNAL40_SOURCE_SCAN_CANARY`（未提供时生成一次性随机 marker），先证明扫描器能检出 raw、URL encoded、Base64、Base64URL 与 hex，再扫描 Actor DTO、脱敏 error/audit/log/trace/snapshot/export 合成制品。目标环境验收通过重复的 `--artifact <path>` 参数加入真实 HAR、日志、trace、snapshot 与 export；输出只允许报告制品标签和编码类别，不得打印 marker。当前本地执行未传真实制品，因此这条命令是验收工具和前置证据，不是 `P0A-API-03` 关闭证明。

### 9.2 OpenAPI 基线与兼容性

API 基线分两步关闭，避免把当前脏工作树伪造成“已发布基线”：

- `P0A-API-04A`：本地实现 OAS 3.1 规范校验与 breaking-change 检查机制，规则至少覆盖 path/method/status 删除、request/response required 变化、类型/枚举收窄、安全要求弱化、不透明的 schema 更换和未按窗口弃用；
- `P0A-API-04B`：在 `DELIVERY-01` 的首个已发布 SHA 上保存不可变 baseline artifact，记录 SHA、artifact digest 和 CI URL；从下一个 PR 起对已发布 baseline 比较。第一个 baseline 只能证明基线被锚定，不能证明它向后兼容。

破坏性修改必须使用新版 API 或至少一个已发布周期的 deprecation 窗口，并在 release manifest 记录迁移方法。

| API | 模式 | 角色 |
| --- | --- | --- |
| `GET /api/v1/source-connectors` | 同步只读 | researcher/admin/auditor |
| `GET /api/v1/source-configs` | 浏览器安全的来源概要列表 | researcher/admin/auditor；固定 team 资源范围 |
| `GET /api/v1/source-configs/{id}` | 浏览器安全的来源详情 | researcher/admin/auditor；禁止 Worker 依赖 |
| `POST /api/v1/source-configs` | 创建禁用、`rights=pending` draft 和 provisional request | 当前 admin only；不能直接生成 verified grant |
| `POST /api/v1/source-configs/imports` | 预览 OPML/CSV/JSON/逐行 URL，或幂等创建逐项声明的 pending draft | admin；不能绕过独立权利审批、逐来源测试/启用 |
| `GET /api/v1/source-configs/{id}/rights` | 浏览器安全的权利请求/决定历史 | source read；不返回 dossier 正文 |
| `PUT /api/v1/source-configs/{id}/rights` | 提交/续提 provisional assertion，撤销旧 grant 并停用 | admin；版本锁、幂等、opaque reference |
| `POST /api/v1/source-configs/{id}/rights` | 批准/拒绝 pending request | active admin + 独立 capability + 异人门禁；批准需证据/条款 SHA-256 dossier |
| `POST /api/v1/source-configs/{id}/tests` | 异步创建测试作业，返回 202 | admin |
| `GET /api/v1/source-configs/{id}/tests/{testId}` | 查询预览和脱敏错误 | admin/auditor |
| `POST /api/v1/source-configs/{id}/enable` | 校验测试、配置哈希和权利后启用 | admin |
| `PATCH /api/v1/source-configs/{id}` | 修改配置，使用 expectedVersion | admin |
| `PATCH /api/v1/source-configs/{id}/ownership` | 版本化转移业务负责人和备用管理员，填写原因 | admin |
| `POST /api/v1/source-configs/{id}/runs` | 立即采集 | researcher/admin |
| `GET /api/v1/source-configs/{id}/runs` | 分页运行列表 | researcher/admin/auditor |
| `GET /api/v1/source-configs/{id}/runs/{runId}` | 运行详情 | researcher/admin/auditor |
| `POST /api/v1/source-configs/{id}/backfills` | 有界补采 | admin |
| `POST /api/v1/source-configs/{id}/backfills/estimates` | 只读估算条数、请求、费用和时间 | researcher/admin |
| `POST /api/v1/source-configs/{id}/archive` | 归档 | admin |
| `POST /api/v1/source-configs/{id}/content-withdrawals` | 撤回/删除并重算 | admin + 审计原因 |
| `GET /api/v1/ingestion-runs/{runId}/pages` | 读取当前租约可恢复的最后页、下一 ordinal 与累计数；不返回文章/raw/Secret | 受限 ingestion workload |
| `PUT /api/v1/ingestion-runs/{runId}/pages/{pageKey}` | 幂等逐页提交 | 受限 ingestion workload |
| `POST /api/v1/ingestion-runs/{runId}/complete` | 校验并终结运行 | 同一 lease owner/epoch |

上表是产品主链路摘要，不是完整权限清单。唯一机器可判定权限清单必须由 OpenAPI operation 与 `P0A-RBAC-01` 的 action × role × resource 矩阵共同生成，覆盖 source read/mutation、release control、checkpoint cutover、quarantine、legal hold/release/retry、deletion 和内部 Worker 端点，每项明确资源归属、二人审批、幂等和审计要求。

测试均走匹配 capability 的受限 Worker/connector agent，控制面不为“即时预览”同步抓取任意 URL。测试结果携带 config hash 和过期时间，配置变化后不可复用。

## 10. 社交信号补证

流程：社交来源形成发现信号，实体解析公司/商品/指标/时间/数字主张，从已授权 company/filing/market 目录检索，为每条声明判断支持、反驳、仅相关或无法确认；只有声明覆盖和独立性均通过才解锁生产。

“找到相关公告”不等于公告支持主张。测试必须覆盖同集团账号、同一新闻稿改写、同一匿名消息源、同文不同 URL、相关但不支持数字的公告及原始来源反驳。低置信度补证只展示建议，不自动绑定或放行。

### 10.1 Social Evidence GA 前的过渡策略

P3/P4 的 `Accepted` 只证明平台连接器能在真实授权下稳定采集，不自动证明其内容可用于生产。在 Social Evidence GA 前，社交内容只能停留在“发现信号”，或由编辑逐声明绑定独立证据并完成人工审批；仅凭文章级 evidence family 不得自动解锁。自动补证放行必须以声明级模型、冻结阈值和生产抽样全部通过为前置。

## 11. 待办、可观测性和指标

待办分为：

- **需立即行动**：授权失效、权利撤回、schema changed、公开 URL 出现敏感参数；
- **系统正在重试**：网络错误、上游 5xx、短期限流；
- **仅提醒**：来源长期无更新、接近配额、补证未完成。

支持批量重新连接、停用、延后提醒和每日摘要。“延后提醒”只能静音通知至指定日期，不延长 grant、不解除停用、不允许调度或提交；需要例外时必须创建新的不可变 grant 版本并由 rights approver 独立批准。连续失败来源自动 degraded/paused，并显示受影响主题和覆盖范围。

| 指标 | 定义 |
| --- | --- |
| 调度触发率 | 到期 occurrence 中在允许延迟内成功创建 run 的比例 |
| 运行成功率 | succeeded / eligible terminal attempts；partial、304、auth blocked 分开报告 |
| 来源新鲜度 | first_observed_at - upstream_published_at，另报 clock skew |
| 队列/抓取/提交耗时 | 分段计时，不混成一个 P95 |
| 有效条目率 | accepted / fetched |
| 空结果异常率 | 违反来源历史更新预期的空运行比例 |
| 平台/内容重复率 | platform duplicate 与 evidence-family duplicate 分开 |
| 补证成功率 | 目标时间内获得有效独立原始证据的社交信号比例 |
| 人工待办率 | 需要人工动作的运行或信号比例 |

按 source、connector、version、platform 和 capability 切片，使用 7/28 天窗口和最低样本量；样本不足不显示绿色。版本化策略 `2026-09-09.v2` 已在代码与 [SLO 策略](./SOURCE_SLO_POLICY.md) 中冻结当前可执行口径：只有 schedule run 进入运行成功率分母，`succeeded` 为成功，`partial/failed` 为失败，`rights_blocked/cancelled/queued/running` 及 manual/backfill 单列；HTTP 304 以 `fetch_outcome=not_modified` 独立持久化，正常内容响应和升级前未知值分别记为 `modified/unknown`；99% 目标、10/30 最低样本、低频来源保持 insufficient 并另需两个真实更新周期、5 分钟 freshness grace、2x/1x burn 和查询缺数 fail-closed 已进入查询、API、UI 与回归。主动暂停会自动开/关有理由的排除窗；未来计划维护有有界、幂等、可撤销且不可删除审计的 API，并已在来源卡片提供登记、历史查看和开始前取消入口；两者同时从 run 与 expected occurrence 分母排除，其他故障不得冒充维护。预算软阈值自动降频保留原始 cron，优先级 80–100/50–79/0–49 分别使用 1x/2x/4x 周期；每个被跳过的 cron 时点连同策略版本、预算快照、优先级和恢复时间写入独立审计表，只有这些精确记录可从 expected-trigger 分母剔除并以 `budgetThrottled` 单列，无记录漏跑、硬预算阻断和无 Worker 仍计为异常。来源页与运维页显示配置、当前倍数、跳过次数和恢复条件。当前只有 API/静态 UI/PG 回归证据，没有真实浏览器操作记录。它仍不是已签 SLO：真实来源清单/告警接收方及 Product/SRE 签字未完成，`0024`–`0026` 尚未部署到开发/生产 PostgreSQL。在这些项关闭前不得启动正式观察计时；观察开始后不得回溯改变验收口径。候选目标是调度触发率及健康 RSS/Public JSON 成功率 ≥99%、P95 新鲜度不超过配置周期 +5 分钟、平台重复入库率 <0.1%。未授权采集与凭据泄露是零容忍事件指标，但“观察到 0”不是控制有效性证明；还必须有 canary、负向攻击测试、日志/追踪/制品扫描覆盖率、告警演练和已知盲区。

转载独立性使用人工标注集报告 precision、recall 和 false-independent rate，不使用“已知错误为 0”。

### 11.1 成本与配额处置

- **软阈值**：提前通知负责人，展示预计耗尽时间和受影响覆盖；已按来源优先级执行可关闭的 1x/2x/4x 自动降频，保留原始 cron，并逐 occurrence 审计预算快照与恢复时间；
- **硬上限**：在来源行锁事务内拒绝创建该 occurrence 的 run/job，记录可解释待办，并继续推进下一调度时间以避免重试风暴；不自动改写优先级或预算；
- 429 尊重供应商窗口，不通过加 Worker 绕过配额；
- 管理员批准新预算或新周期开始后，按受控 catch-up 逐步恢复，避免集中补跑；
- 所有自动降频/暂停必须可解释、可审计，并在来源页显示恢复条件。

## 12. 分阶段交付

工程工作量是单工程师**原始估计**，不含供应商签约、平台审批、账号准备和观察期；下一轮排期只能估算“剩余工作”。执行状态如下：

六类缩写：`M` migration、`A` API、`W` Worker、`U` UI、`T` tests、`O` telemetry；值为 `L` 本地已有、`P` 部分/计划中、`N` 未开始、`X` 外部阻断。

| 工作包 | Owner | Depends on | 六类状态 M/A/W/U/T/O | 状态与已完成 | 剩余工作 | 关闭证据 |
| --- | --- | --- | --- | --- | --- | --- |
| P0A 基础不变量 | Platform + Security | 无 | L/L/L/L/L/P | Partial, local only；状态契约、proposal/RBAC 核心、Actor/Worker DTO、staged visibility、upsert/tombstone、整数 capability protocol、lease epoch、checkpoint/CAS、稳定 run cursor、API lint/兼容检查及三类独立本地镜像/四镜像 layer canary 已有证据 | 跨角色/安全验收、生产迁移/恢复、远端 SBOM/Trivy artifact、生产身份/网络与已发布 API baseline | 精确任务 ID 的证据合集，不使用“P0A 安全子集” |
| P0B RSS | Source Platform | 工作包关闭：`P0A-STATE-01/P0A-API-03/P0A-VISIBILITY-01/DELIVERY-01/P0A-IAM-01/P0A-NET-01/LEGAL-RIGHTS-01` | L/L/L/L/L/P | 工作包 In progress；parser、条件请求、admin 三步 UI、兼容运行级原子提交等 connector core 已有 `Implemented locally` 证据 | 关闭基础依赖；公网 egress、真实进程强杀/重启续采、跨角色且无终端验收 | 真实 run IDs + 浏览器记录 |
| P0C 发布控制 | SRE + Platform | `P0A-STATE-01/P0A-VISIBILITY-01/DELIVERY-01` | L/L/L/L/L/P | Partial, local only；持久化 connector/version mode、来源级停用、队列取消、提交隔离、shadow 无正式写入、来源稳定分桶 canary、切换时取消未领取运行、在途正式提交按当前桶复核、失败阈值自动停用、batch quarantine、双人 checkpoint cutover、管理员 UI 与可执行 runbook 模板 | 目标环境执行 canary/自动停止/恢复/并发演练并形成签字 acceptance pack | release drill + acceptance pack |
| P1A1 Public JSON | Source Platform | 工作包关闭：`P0A-STATE-01/P0A-API-03/P0A-VISIBILITY-01/DELIVERY-01/P0A-IAM-01/P0A-NET-01/LEGAL-RIGHTS-01` | L/L/L/L/L/P | Partial, local only；映射、分页、rejection、429、批量导入、metadata 逐页 staging/恢复/终结和可见性隔离已有本地证据 | 关闭其余基础依赖；真实无凭据 Public JSON 多页、网络中断/Worker 重启、多 Worker、opaque cursor | 外部 API run IDs |
| P1B 调度与 SLO | SRE + Source Platform | P0A、P0B | L/L/L/L/L/P | Partial, local only；next_run_at、active run、退避、backfill 隔离、稳定运行游标、来源与四类聚合切片的 7/28 天 SLO、最低/低频规则、burn 告警、304 分类、可审计暂停及来源卡片计划维护排除、用量/预算/配额 UI；来源优先级与可关闭 1x/2x/4x 预算降频、逐 occurrence 审计及不掩盖漏调度的分母规则已实现；策略 v2 已由 API 返回并有可执行报告 | `0024`–`0026` 环境升级、真实来源/告警清单和 Product/SRE 签字；双 Scheduler/多 Worker 目标环境 chaos、真实账单回填/核对与真实降频演练、真实观察窗口 | signed SLO spec + report + chaos + observation |
| Source Ownership | Platform + Security | P0A、团队成员治理 | L/L/L/L/L/P | Implemented locally；`0015`、owner team、业务负责人、版本锁转移、启用门禁、成员影响提示、Scheduler 巡检、待办链接与审计 | 真实离职/停用恢复演练、未来多租户 team 约束 | audit + browser offboarding drill |
| Legal Delete | Platform + Legal + SRE | `P0A-CONTRACT-DELETE-01/LEGAL-RIGHTS-01/P0C-DRILL-01` | L/L/L/L/L/P | 来源范围删除与保全编排已本地实现；不等于法律有效性或物理删除已验收 | 完整数据系统删除矩阵、对象版本/复制/备份/缓存/日志、真实平台撤回、职责分离和法律签字 | request/item/platform receipts + physical-state evidence + legal approval |
| P2 Browser/Web | Source Platform + Security | P0A、P0C | L/L/L/L/L/P | Implemented locally；公开 HTML JSON-LD/可见链接解析，不执行 JavaScript、不绕登录，统一 SSRF/大小/条目上限 | 逐站点真实 URL、网络隔离、恶意页面和权利验收 | manifest + browser/隔离证据 |
| P3/P4 Social | Source Platform + Legal | P0A、P0B | L/L/L/L/L/P | Implemented locally；公众号/小红书提供 OpenCLI 候选搜索与已获允许的第三方 RSS，不含自建账号托管 | 真实 OpenCLI/Bridge 或 Feed、publisher 映射、内容变化和权利验收 | 平台 acceptance pack |
| P5 Social Evidence | Data/Editorial | P0B、P1A1 + 已授权语料 | L/L/L/L/L/P | In progress；本地已实现 publisher/origin 治理、保守关系分类器、不可变人工修正、声明级合格支持、family↔ownership group 最大匹配、冻结阈值/数据集哈希/异人审批；无批准策略时 social/web fail closed | 已授权版本化评测集、真实评测与生产抽样、Product/Editorial 签字 | evaluation pack + production sample + approval |

每个工作包关闭时都要更新“状态 / 已完成 / 剩余 / 依赖 / 验收证据”；不能因为阶段中一部分代码存在就关闭整个阶段。

### 12.1 执行顺序与状态晋级

执行顺序以依赖门禁而不是表格行号决定：

1. **先关闭本地基础风险**：按任务 ID 完成 `P0A-STATE-01`、`P0A-RBAC-01`、`P0A-API-03/04A`、`P0A-VISIBILITY-01`、`P0A-CONTRACT-DELETE-01`、`MIGRATION-INTEGRITY-01` 和 `P0A-IMG-01`，不再使用无法判定的“P0A 安全子集”。未列入 Foundation manifest 的平台 Spike 可以通过独立 Blocked 决策关闭，不要求强行接通。
2. **固化可恢复交付**：单一目标 SHA 通过 `DELIVERY-01`，再从该已发布 SHA 生成 `P0A-API-04B` baseline。未经这一层的 dirty tree 不能进入环境验收。
3. **交付第一条真实链路**：目标环境先关闭 `P0A-IAM-01`、`P0A-NET-01`、`LEGAL-RIGHTS-01`，再执行 `P0B-E2E-01`、`P1A1-E2E-01` 和 `P0C-DRILL-01`。
4. **完成产品与长期运行验收**：`PRODUCT-E2E-01`、`P1B-SLO-01` 先关闭，`P1B-CHAOS-01` 通过后才启动 `P1B-OBS-01` 的 28 天计时；7 天只能作 pre-GA review，本地合成窗口不得替代真实观察。
5. **验收公开平台入口**：P2、P3、P4 的公开 URL/Feed 代码已实现；逐站点或逐 Feed 完成真实样本、权利和运行验收后才能进入 Foundation GA 的承诺集合。
6. **独立完成证据系统**：P5 可使用已授权语料并行开发，但在声明级补证、人工修正、冻结阈值和生产抽样完成前，社交/网页信号一律不能自动解锁生产。

规划状态 `Not started → In progress` 位于交付证据链之前；进入交付链后只能按 `Implemented locally → Delivered → Deployed → Integrated → Accepted` 晋级。发生证据失效、平台政策变化或严重回归时必须降级。晋级规则如下：

- 六类状态 M/A/W/U/T/O 逐项有负责人；不适用项写 `N/A` 并说明理由，不能留空；
- `Implemented locally` 需要本地代码、迁移、自动化测试和对应证据记录；
- `Delivered` 需要可恢复 commit、目标 SHA 远端 CI 和可追溯制品；
- `Deployed` 需要上述制品 digest 已进入明确目标环境，不代表外部上游已连通；
- `Integrated` 需要目标环境与真实授权上游成功连接；
- `Accepted` 需要工作包关闭证据、产品/安全/运行等对应批准人签字；
- 任一硬依赖仍为 Blocked、关键测试 failed/not-run，或证据超过有效期时，不得晋级。

### 12.2 评审后关闭清单

以下清单是本版的可执行剩余工作，不是愿景列表。完成一项时必须同时更新第 2 节事实账本、第 12 节工作包状态和对应 evidence record；只有代码或只有文档均不能关闭整项。

| ID | 优先级 | 工作与退出条件 | Owner | Depends on | 当前状态 | 关闭证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `P0A-API-01` | P0 | 为 Worker 全部 2xx 响应绑定专用 schema | Platform | 当前运行时结构 | Implemented locally | 当前专项通过；完整账本为 257 pass/0 fail/3 远程存储 skip |
| `P0A-API-02` | P0 | 所有来源控制面/Worker 已登记非 2xx 必须返回 `error+errorCode`，不污染非来源 API | Platform | `P0A-API-01` | Implemented locally | 当前专项通过；完整账本为 257 pass/0 fail/3 远程存储 skip |
| `P0A-STATE-01` | P0 | 将 proposal/source lifecycle/health/rights/run/quarantine/release/acceptance 枚举按实体冻结，DB/TS/OpenAPI/UI/负向测试等值 | Platform + Product | `P0A-API-02` | Implemented locally；`0019` DB checks、共享 TS 常量、OAS 等值和 UI 标签已验证 | `SRC-STATE-CONTRACT-001`；部署兼容仍由 DELIVERY gate 负责 |
| `P0A-RBAC-01` | P0 | 建立 action × role × resource 权限矩阵；researcher proposal 与 admin/rights approval 分离；高风险动作职责分离且不得自批 | Security + Product + Platform | `P0A-STATE-01` | In progress；可执行矩阵、proposal、显式 rights/legal capability、异人权利决定与 legal hold 解除、两名法律操作人存续门禁、API/UI/OAS/审计及负向 PG 回归已本地实现 | 仍缺真实身份下跨角色 API/browser 全矩阵与 Security/Legal sign-off |
| `P0A-API-03` | P0 | 按 §9.1 分离 actor/Worker DTO，严格 allowlist 浏览器字段，禁止 cursor/object key/raw/error/Secret URL 等越界 | Security + Platform | `P0A-STATE-01/P0A-API-02` | In progress；Actor allowlist、Worker-only 读模型、敏感 URL 清理、严格 OAS/回归、合成 canary scanner、自检和 CI step 已本地实现 | 仍缺真实浏览器 HAR/录像、目标环境 log/trace/snapshot/export 实扫与 Security sign-off |
| `P0A-API-04A` | P0 | 在本地/CI 接入 OAS 3.1 规范校验与 breaking-change 检查，冻结弃用窗口 | Delivery + Platform | `P0A-API-03` | Implemented locally；Redocly 0 warning、兼容 checker、90 天弃用规则和 CI required step 已入代码 | checker 及负测试通过；远端 required check 由 DELIVERY-01 验证 |
| `P0A-API-04B` | P0 | 从首个已发布 SHA 保存不可变 baseline；不使用 dirty spec | Delivery + Platform | `P0A-API-04A/DELIVERY-01` | In progress；机制已落地——`contracts/openapi.baseline.yaml` 为仓库内不可变锚点，CI 不再用漂移的 `github.event.before`，并有收窄类型的负测试。**但锚定 SHA `47a7596` 的 CI 从未通过，按 §9.2「第一个 baseline 只能证明基线被锚定，不能证明它向后兼容」，本项在 `DELIVERY-01` 指定已发布 SHA 并重新锚定前不得关闭** | baseline artifact digest + 已发布 commit SHA + 绿色 CI URL |
| `P0A-VISIBILITY-01` | P0 | 逐页数据在 run complete 前 staged，不进入雷达/门禁/重算；complete 后一次性可见并只触发一次重算 | Platform | `P0A-STATE-01` | Implemented locally；`0021` staged payload、运行内 checkpoint、complete 原子发布/CAS/幂等重算已验证 | `SRC-VISIBILITY-001`；进程强杀/多 Worker 由 chaos gate 验证 |
| `P0A-CONTRACT-DELETE-01` | P0 | 将 `NormalizedSourceItem` 冻结为 upsert/tombstone 判别联合，覆盖未知 ID、重放与删除后重现 | Platform + Legal | `P0A-STATE-01` | Implemented locally；严格 runtime/OAS 联合、HTTP 映射/UI、`0022` 最新事件状态、删除优先和显式较新恢复已实现 | `SRC-CONTRACT-DELETE-001`；真实上游与外部删除仍由 connector/LEGAL E2E 验证 |
| `MIGRATION-INTEGRITY-01` | P0 | 为全部迁移维护不可变 checksum manifest，运行时/CI 校验 tag+hash；分别验证 fresh install 和 from-current-production upgrade | Delivery + DBA | 无 | In progress；`0000`–`0032` 的 33 项 manifest、runner/CI 校验、PGlite fresh、旧开发库 19→21→22→23 upgrade 和 drift-negative 已通过 | `0023`–`0032` 尚未在开发/生产基线升级；仍缺隔离 restore log 与远端 CI |
| `P0A-IMG-01` | P0 | 构建上下文排除 `.env*`/私钥/云凭据；source/render 独立最小镜像与 env allowlist | Security + Delivery | 无 | In progress；allowlist-copy/non-root 镜像、Compose env allowlist和 CI 扫描矩阵已实现；Broker 镜像已从范围和构建矩阵删除。新增：三个运行层不再携带 npm/npx，消除基础镜像自带包管理器带来的 11 项可修复 HIGH/CRITICAL，运行时只保留 node —— 清除效果待远端 CI 扫描确认 | `SRC-WORKLOAD-BOUNDARY-001/SRC-IMAGE-CANARY-001`；仍缺远端 SBOM/Trivy artifact、签名 provenance 与 Security sign-off |
| `P0A-NET-01` | P0 | 默认拒绝 egress；用固定版本 IANA special-purpose corpus 验证 A/AAAA、mapped/NAT64/6to4、DNS/CNAME/逐跳 redirect/代理旁路/元数据 | Security + SRE | 目标环境 | In progress；应用层已固定 IANA 2025-10-09 IPv4/IPv6 corpus，mapped/NAT64/6to4 解包与相邻公网负向回归已实现 | 仍缺目标环境默认拒绝策略、代理旁路/CNAME/逐跳日志、actual remote IP/SNI、packet evidence 与 Security sign-off |
| `P0A-IAM-01` | P0 | 准备目标环境唯一 team、首个 active admin、business owner、身份头来源、禁用同步和 break-glass | Security + SRE | 身份源 | External pending | provisioning record + two-account RBAC test + recovery drill |
| `LEGAL-RIGHTS-01` | P0 | provisional assertion → verified grant；服务端治理 source type；不可变权利证据/条款快照 | Legal + Platform | 对应公开来源 | In progress；pending request→异人 verified grant、独立确认冻结 `sourceType`、严格 dossier、证据/条款 hash、配置漂移/自批/过期/撤销门禁已本地实现 | 仍缺真实 publisher/evidence-family 目录映射、公开来源 evidence artifact/dossier、到期/撤销环境演练与 Legal sign-off |
| `E2E-WECHAT-SOCIAL-01` | P1 | 用真实 OpenCLI/Browser Bridge 或选定第三方 RSS 验证测试、启用、增量、去重与主体 unknown/verified 行为 | Product + Source Platform + Legal | OpenCLI 环境或真实 Feed | External pending | 浏览器记录、run ID 与权利 dossier |
| `E2E-XHS-SOCIAL-01` | P1 | 用真实 OpenCLI/Browser Bridge 或获权第三方 RSS 验证测试、启用、增量与主体映射 | Product + Source Platform + Legal | OpenCLI 环境或真实 Feed | External pending | 浏览器记录、run ID 与权利 dossier |
| `E2E-WEB-{site}` | P1 | 每个热榜/网页站点用公开页面独立验收，不用一份结论覆盖所有站点 | Product + Source Platform + Legal | 目标站点 | External pending | per-site dossier + browser run + review date |
| `DELIVERY-01` | P0 | 固定单一目标 SHA；CI 必须包含 tsc/lint/test/evaluation/build/render、OAS 验证/兼容、迁移 fresh+upgrade、restore、secret/dependency/image scan，关键测试不得 skip；产出 control-plane/source/render 可追溯 OCI digest/provenance | Delivery | `P0A-STATE-01/P0A-RBAC-01/P0A-API-03/P0A-API-04A/P0A-VISIBILITY-01/P0A-CONTRACT-DELETE-01/MIGRATION-INTEGRITY-01/P0A-IMG-01` | Not delivered；目标 SHA 已固定为 `47a7596` 且已推送，但该 SHA 的 required CI（run 34352893022）4 job 全红：OAS 兼容门禁在 `bb5ad3a` baseline 上检出 4 项 `source-proposals.url` breaking change 并中断 application job，其后测试/迁移/restore/build/render 未执行；三个镜像 job 均被 Trivy 可修复 HIGH×10+CRITICAL×1 阻断，未产出可追溯 OCI digest | 两个阻断项修复后重跑 CI，取 commit SHA + required CI URL + skip=0 + migration/restore logs + 三个 OCI digests/provenance |
| `P0B-E2E-01` | P0 | admin 无终端完成 RSS 接入、测试、启用、采集、雷达/运行详情；重启后从 checkpoint 续采 | Product + Source Platform | `DELIVERY-01/P0A-IAM-01/P0A-NET-01/LEGAL-RIGHTS-01` + 有效 RSS | External pending | browser recording + run IDs + restart trace |
| `P1A1-E2E-01` | P0 | 真实无凭据 Public JSON 验证多页、opaque cursor、429、网络中断、Worker 重启和同时间戳补发 | Source Platform | `DELIVERY-01/P0A-IAM-01/P0A-NET-01/LEGAL-RIGHTS-01` | External pending | upstream/run IDs + recovery trace |
| `P0C-DRILL-01` | P0 | 目标环境演练 canary 命中/未命中与阈值自动停用，以及 kill/shadow/quarantine/cutover/recovery，并证明未 complete 页不可见 | SRE + Platform | `DELIVERY-01/P0A-VISIBILITY-01` | External pending；本地已覆盖稳定分桶、payload/run shadow 固化、最小样本阈值和自动 kill switch | drill log + before/after SQL/API/audit/run IDs |
| `PRODUCT-E2E-01` | P0 | 跨角色提案/批准，批量歧义，失败断点恢复，capacity waiting，雷达发现/生产双层与高流量摘要 | Product + Editorial | `P0A-RBAC-01/P0B-E2E-01/P1A1-E2E-01` | External pending | browser suite + usability assertions + signed acceptance |
| `P1B-SLO-01` | P1 | 在观察前冻结 SLI 分母/类型归属、维护/pause/missing-data、低频规则、阈值、burn 与查询 | SRE + Product | 真实来源列表 | In progress；`2026-09-09.v2` 已冻结 schedule eligible terminal、失败/排除分类、304/modified/unknown、7/28 窗口、99% 目标、10/30 与低频规则、freshness、2x/1x burn、缺数上限、可审计暂停/计划维护，以及只剔除已持久化预算降频 occurrence 的规则；API/UI 与本地报告已实现 | 仍缺真实来源与告警目标、`0024`–`0028` 环境升级、真实账单触发演练及 Product/SRE 签字；未关闭前不启动观察 |
| `P1B-CHAOS-01` | P1 | 按 §13.2 固定矩阵验证允许重复 fetch、不允许重复 committed origin、checkpoint 不倒退且 staged 不泄漏 | SRE + Source Platform | `P0C-DRILL-01/P0B-E2E-01/P1A1-E2E-01` | In progress, local seeded harness；固定 seed/两 Scheduler/三 Worker（含旧协议）的 PGlite 报告已覆盖幂等入队、协议/租约 fence、raw 失败重放、page/complete 回滚、ACK 丢失、可见性和不重算 | `npm run source:chaos` + SQL before/after；仍缺目标环境真实强杀/网络/对象存储/在途授权变更、固定时长和签字报告 |
| `P1B-OBS-01` | P1 | chaos 通过后启动连续 28 天观察；7 天可做 pre-GA review，不等于 Accepted；低频来源同时覆盖至少两个预期更新周期 | SRE + Finance/Ops | `P1B-SLO-01/P1B-CHAOS-01` | External pending | 7/28-day snapshots + invoice reconciliation + alert drill |
| `OWN-DRILL-01` | P1 | 真实成员停用/降权，UI 完成 owner/steward 转移、阻断与恢复 | Security + Product | `P0A-IAM-01/P0A-RBAC-01` | External pending | audit events + browser recording |
| `LEGAL-E2E-01` | P1 | 验证全数据处理矩阵、对象版本/复制/备份/缓存/日志、外部回执、hold 职责分离、共享 origin 与过删/漏删 | Legal + SRE + Platform | `P0A-CONTRACT-DELETE-01/LEGAL-RIGHTS-01/P0C-DRILL-01` | External pending；本地已实现异人解除、单调 hold epoch、旧 lease 作废、对象删除线性化和平台调用前复核 | deletion matrix + physical/platform evidence + legal approval |
| `P5-EVIDENCE-01` | P1 | 声明级补证、合格图匹配、人工修正和冻结阈值；false-independent rate 达标后才开放自动生产 | Data + Editorial | 已授权评测语料 | In progress；本地已实现最大匹配、unknown/低置信度 fail closed、不可变人工修正、声明级合格支持门禁、数据集 SHA/策略/误独立率/召回率/生产抽样阈值与独立审批；无批准策略时 social/web 自动生产关闭 | 仍缺已授权 versioned dataset、真实评测报告、生产抽样及 Product/Editorial sign-off |

当前 Foundation GA 硬路径为：

```text
STATE + RBAC + API-03 + API-04A + VISIBILITY + DELETE-CONTRACT
          + MIGRATION-INTEGRITY + IMG
                         │
                         ▼
                    DELIVERY-01 ──► API-04B
                         │
          ┌──────────┴──────────┐
          ▼                     ▼
 IAM + NET + RIGHTS        RSS + Public JSON E2E
          └──────────┬──────────┘
                     ▼
              P0C drill + Product E2E
                     ▼
               SLO freeze + Chaos
                     ▼
             28-day observation + sign-off
```

Foundation must-pass ID 集合是 `P0A-STATE-01`、`P0A-RBAC-01`、`P0A-API-03/04A/04B`、`P0A-VISIBILITY-01`、`P0A-CONTRACT-DELETE-01`、`MIGRATION-INTEGRITY-01`、`P0A-IMG-01`、`DELIVERY-01`、`P0A-IAM-01`、`P0A-NET-01`、`LEGAL-RIGHTS-01`、`P0B-E2E-01`、`P1A1-E2E-01`、`P0C-DRILL-01`、`PRODUCT-E2E-01`、`P1B-SLO-01`、`P1B-CHAOS-01`、`P1B-OBS-01`、`OWN-DRILL-01` 以及适用范围内的 `LEGAL-E2E-01`。`SPIKE-WECHAT-01`、`SPIKE-XHS-01`、`SPIKE-WEB-{site}` 与 `P5-EVIDENCE-01` 是接下来的两条核心扩展主线；前三类可以得出 Blocked 决策，但阻止对应平台加入 manifest，P5 关闭前 social/web 始终保持发现层 fail closed。

### P0A：Foundation 基础不变量（需按 12.2 重新估算）

- 冻结生命周期、权利和 connector contract；
- 设计原子提交、checkpoint、capability routing；
- 完成状态/RBAC、actor/Worker 投影、staged visibility、tombstone、威胁模型、OpenAPI、迁移完整性、镜像脱密和 expand–migrate–contract 方案。

公众号、小红书和每个网页/热榜的 Spike 是条件式连接器任务，不属于 Foundation 核心代码关闭集；只需确保未 Accepted 入口被 hidden/disabled 并有可追溯决策。

### P0B：RSS 端到端产品化（4–6 工程日）

- expand migration、draft/test/enable 状态机；
- 注册表和受控 egress client；
- 标准 XML parser、预览和条件请求；
- 原子提交、运行详情、健康、结构化错误与待办。

验收：管理员在 UI 三步添加真实授权 RSS，立即采集后雷达出现内容；服务重启后从 checkpoint 继续，正常用户不执行命令。

### P1A1：公开 JSON 产品化（剩余工作重新估算）

- 已实现 JSON 映射、page/cursor/since、item rejection、429 与批量接入；
- 已实现 metadata 模式逐页提交、恢复视图、终结校验、lease epoch 和 HTTP 响应丢失重放；
- 剩余是真实服务多页执行、真实网络中断/进程重启、多 Worker、opaque cursor 和用户验收；
- 未接入真实来源前仍不可 Accepted。

### P1B：可靠调度与补采（来源级 SLO 已本地实现，运行验收待办）

- next_run_at 领取、活动运行约束；
- catch-up、公平调度、429 退避；
- live/backfill checkpoint 隔离；
- 已实现来源范围的单次运行详情；补采先由服务端冻结来源版本、时间窗和条数上界，给出保守请求数、配置单价成本和预计时长，大于 20 条或超过 7 天必须用该估算的 confirmation hash 二次确认，配置或范围变化后旧确认失效；
- 已实现 7/28 天来源级运行成功率和 cron occurrence 触发率、10/30 最低样本量、双窗口 burn-rate 告警、P95 新鲜度、请求/字节用量与分钟触发配额 UI；数据超过 500 来源或 100,000 run 时 fail closed 标为窗口不完整；
- 已实现版本化 SLO 策略 `2026-09-09.v2` 与 `npm run source-slo:report`：只有 schedule 的 `succeeded/partial/failed` 进入 eligible terminal 分母，`rights_blocked/cancelled/queued/running` 以及 manual/backfill 在 API/UI 单列；304 仍是成功但以 `not_modified` 单列，普通内容响应和升级前未知值以 `modified/unknown` 单列，矛盾的 304 内容提交被拒绝；主动暂停自动开关排除窗，计划维护可提前登记/开始前取消且全程审计，命中区间同时从 run 和 expected occurrence 分母排除；预算降频只剔除 `source_schedule_throttles` 已登记的精确 occurrence 并以 `budgetThrottled` 单列，无记录漏跑仍消耗错误预算；低频来源不足 30 个 28 天预期触发时保持 insufficient，并另需两个真实更新周期；
- 已实现 connector/version/platform/capability 聚合；来源单价必须由管理员显式配置，零单价显示“成本未建模”，不会把请求/字节冒充货币成本；
- 已实现按预留请求数估算、run 级单价冻结、提交后实际请求数重算、月度软提醒和硬阻断；运维页与待办给出月底预计成本、当月预计耗尽日期以及受影响文章/主题数；来源页可配置 0–100 优先级和自动降频开关，软阈值后以 1x/2x/4x 周期推进且保留原始 cron、逐时点审计、显示当前倍数/跳过数/恢复日期。尚缺真实供应商账单回填/核对及目标环境真实降频演练。

验收：两个 Scheduler、多 Worker、手动与定时并发时不重复、不漏采、不倒退 checkpoint。

### Legal Delete：来源范围删除与保全编排（本地状态机已实现；法律有效性与物理删除未验收）

- `source_deletion_requests/items` 持久化每一步，只有对象、外部撤回和数据库清理全部成功才生成最终 receipt hash；
- active legal hold 阻断初始化和后续步骤；建立 hold 会递增单调 epoch，取消排队、重试中及已领取的外部撤回作业并作废旧 lease；解除后只有更新 epoch 的新租约可恢复，Render Worker 在平台调用前再复核一次；
- 对象失败自动重试，外部 dead-letter 只能由管理员在修复原因后显式重试；
- 仅删除没有其他 active origin 的规范化文章；删除派生项目/资产并清理空主题；
- 当前回归是本地 PostgreSQL/PGlite 与对象存储证据，真实 YouTube 撤回、并发强杀、对象锁和法律签字仍未完成，故不能标记 Accepted。

在 Legal 签字前，API/UI 只能显示“删除请求已创建 / 正在删除 / 外部确认中 / 因保全暂停 / 技术步骤完成待法律确认”，不得显示“依法删除已完成”。对象存储删除 API 成功只证明请求被接受，不证明版本、复制、备份和缓存已物理清除。最终依资产分别记录 `physically_deleted`、`scheduled_for_expiry`、`retained_under_legal_basis` 和外部平台回执；保留的最小审计集、SLA、例外法律依据和到期日必须由 Legal 批准。legal hold 建立与解除要求 case/authority、不可变原因和不同主体批准；本地实现以 `legal_hold_epoch + job lease_epoch + 执行前授权` fence 不可逆步骤，真实平台并发与法律身份仍需环境验收。

### P2：网页与热榜（浏览器平台 8–15 工程日；每个模板另计 2–4 日）

- 静态模板和隔离浏览器 Worker；
- 独立身份、网络策略和资源限制；
- 版本化模板、结构变化检测和 quarantine；
- 至少 2–3 个真实授权模板。

P2 必须交付固定的容器/编排 manifest、网络策略和身份策略。验收从恶意页面真实执行控制面探测、云元数据访问、DNS rebinding、文件读取、下载、持久 profile 和进程炸弹测试，并记录实际出站网络、容器身份、seccomp/AppArmor 加载状态和任务后销毁证据；只通过应用层 mock 不得标记 Integrated/Accepted。

### P3：微信公众号（本地代码完成，外部集成与验收待办）

已交付 OpenCLI/第三方 RSS 策略选择、预览、调度、去重、checkpoint 与明确失败码。剩余用真实 OpenCLI/Browser Bridge 或选定 RSSHub 路由验证连续新增文章、账号身份、限流及编辑/删除；供应商/平台授权另计。

### P4：小红书（本地代码完成，外部集成与验收待办）

已交付 OpenCLI/第三方 RSS 双策略的本地执行路径；剩余用真实账号及 Browser Bridge 或真实获权 Feed 验证新增/编辑/删除与登录失效。

### P5：补证与生产观察（5–8 工程日，另加 chaos 通过后连续 28 天）

本地已交付 publisher entity 登记、origin 人工修正、声明级合格支持门禁、family↔ownership-group 最大匹配、离线标注集评测命令及冻结阈值审批；无批准策略时 social/web 自动生产失败关闭。剩余交付是已授权版本化标注集、关系分类器、真实评测报告、生产抽样和无人值守验证。低频来源至少覆盖两个预期更新周期，不能为满足日期提前宣称通过。

每阶段都必须列出 migration、API、Worker、UI、tests、telemetry 六类交付物；缺一项不得标记阶段完成。

### 12.3 近期可执行批次

| 批次 | 范围 | 可并行 | 退出条件 |
| --- | --- | --- | --- |
| A：平台可行性 | 公众号、小红书、每个网页/热榜站点分别确认 canonical identity、公开或签约数据路径、增量/编辑/删除、频率和使用权 | 三类 Spike 并行 | 每个平台得到 go/constrained/blocked 结论、样本和复核日 |
| B：Social Evidence 真实评测 | 建立已授权版本化标注集，运行现有评测器并做人工修正抽样 | 数据标注和编辑抽样可并行 | false-independent rate、recall、生产样本均达冻结阈值，Product/Editorial 异人签字 |
| C：连接器实现 | 只为批次 A 判定 go/constrained 的平台实现 connector、checkpoint、编辑/删除和 UI | 各平台独立开发 | 真实账号或站点完成增量、重启恢复、删除和限流验收 |
| D：联合生产验收 | 平台连接器进入发现层，Social Evidence 在批准策略下验证补证与生产门禁 | 平台验收和 P5 观察可并行 | 各 connector 独立 Accepted；P5 单独 Accepted，不混报 |

立即下一步是批次 A 与 B：平台 Spike 和真实 Social Evidence 数据准备并行。Secret Manager/workload identity、OAuth/PKCE 与本机 Agent 不在排期、依赖或完成定义中。

## 13. 测试矩阵

每条门禁进入证据登记表，字段为：`test_id`、类型（unit/DB integration/API contract/browser/chaos/external）、状态（not-run/passed/failed/blocked）、完整命令或 run ID、commit/tree/制品 digest、OS/Node/PostgreSQL/浏览器版本、环境、执行人、独立批准人、执行时间、`valid_until` 或失效条件、skip 计数、原始日志/artifact URL 和证据链接。测试文件存在不等于已执行，应用层 mock 不能替代真实浏览器、网络、平台或观察期。脏工作树临时证据还必须保存 porcelain manifest 和全部 tracked/untracked 内容哈希；否则不可重现。

### 13.1 连接器与安全

- RSS 2.0、Atom、namespace、相对 URL、多 link、编码、恶意 XML；
- JSON 坏项、分页、cursor 循环、空页后有数据和 schema change；
- ETag/Last-Modified/304；HTML 结构变化、超长字段和压缩炸弹；
- 私网/保留/云元数据地址、IPv4/IPv6 变体和 DNS rebinding；
- 重定向与跨域认证头剥离；
- 部署 Secret 不进入数据库普通字段、API、日志、审计和快照；
- 浏览器逃逸、内网访问、下载和资源耗尽；
- 302 到攻击域、HTTPS→HTTP、敏感 query、CDN allowlist 漂移；
- 单租户实例拒绝第二 team；未来多租户模式需覆盖跨 team source/run/object key 越权；

### 13.2 调度与一致性

- 两个 Scheduler、多 Worker 并发；
- active-run 与 checkpoint CAS 冲突；
- 乱序、相同时间戳、编辑、补发、置顶；
- backfill 与 live 重叠；
- 每个提交边界故障注入与重放；
- Worker 在抓取、R2 上传和 DB commit 前后强杀；
- R2 部分失败与孤儿对象回收；
- 来源停用、授权过期、撤销、依法删除；
- 新旧 schema/Worker 滚动升级；
- 伪造 capability、协议降级和旧 Worker 错领；
- 拉取后授权撤销、提交前授权过期或来源配置版本变化；
- multipart 未完成、DB 回滚、对象删除失败、legal hold 与解除后重试；

`P1B-CHAOS-01` 不接受“手工杀了几次没出错”的叙述证据。矩阵必须固定两个 Scheduler、至少三个 Worker（包括一组新旧协议混合）、可重现 seed/运行时长，并在 fetch 后、raw upload 后、page commit 前/后、complete 前/后和 HTTP ack 丢失时强杀；另覆盖 429、超时、响应断开、lease expiry/clock skew、live+backfill 并发、rights/config 中途变更。允许重复 fetch，但必须用 before/after SQL 证明无重复 committed origin/revision、checkpoint 不倒退、每来源最多一个 active run、旧 lease epoch 无写入、未 complete/held 批次不可见且没有提前重算。

当前只完成 [固定种子本地故障演练](./SOURCE_CHAOS_DRILL.md)；它关闭了本地状态机和事务前置风险，但不满足上述目标环境强杀、固定时长和签字条件。

### 13.3 证据与产品验收

- 同集团账号、新闻稿改写、匿名同源、同文不同 URL 与真正独立报道；
- 相关但不支持声明的公告、支持/反驳共存和人工拆分/合并后重算；
- 三步新增 RSS、立即采集、运行详情、雷达两层状态；
- 修改配置后旧测试失效；来源失败/恢复与待办同步；
- 批量接入并集中处理歧义；
- 首次启用显示采集范围/费用预估，超阈值补采需二次确认；
- 采集健康、权利健康和证据状态的反例不会被合并成单一绿色；
- 高流量社交源经聚类、展示上限和摘要后不会产生逐条待办风暴；
- 接入人离职、权限禁用和来源所有权转移后仍可恢复维护；
- 撤权/依法删除对候选、项目、未发布资产和已发布内容产生正确下游动作；
- 公众号/小红书分别用真实授权方式验收；
- 普通编辑无需终端或 CSS 选择器完成日常操作。

### 13.4 可手动执行的 Foundation 验收剧本

1. 以 researcher 登录，只能提交来源 proposal，不能自批或启用；换用 admin A 批准 proposal 后只生成 `rights=pending` draft/request，再换用已显式授予 capability 的 admin B 填写证据引用与条款快照并批准。admin A 自批、普通 admin 批准、旧版本请求和缺 hash dossier 都必须返回 403/409/422；审计显示三个主体。当前 API/PG 单元边界已实现，仍需真实身份浏览器剧本与 Security sign-off。
2. admin A 在 `/sources` 三个顶层步骤内添加一个真实 RSS并提交 provisional assertion，查看 3–5 条脱敏预览；admin B 完成权利批准后，admin A 才能启用。整个流程不使用终端。
3. 触发立即采集，检查运行从 queued/running 到 terminal；在 complete 前雷达无中间页，complete 后一次性出现，且主题重算只一次。
4. 在中间页后强杀 source Worker，重启后从最后 committed checkpoint 继续；不重复 origin，无 checkpoint 倒退，旧 Worker 再提交得到稳定错误码。
5. 用真实 Public JSON 重复第 2–4 步，额外验证多页、opaque cursor、429/Retry-After、坏项 rejection 和同时间戳补发。
6. 用 canary Secret 覆盖 URL query、redirect/finalUrl、cursor/checkpoint、ETag、error、preview 和 raw 响应；导出浏览器 HAR，并扫描 API/日志/追踪/快照/镜像/制品，任何原值或常见编码命中均为失败。
7. 在运行中执行 source/version kill switch、rights revoke、config update 和 quarantine；验证在途结果 fail closed、raw 按策略清理、待办可恢复，且 UI 不把“请求已创建”显示为“已删除”。
8. 用第二个真实账号停用/降权 owner，从待办进入来源并在 UI 转移维护责任；恢复后才允许新运行。

## 14. 发布、迁移与回滚

### 14.1 Expand–migrate–contract

1. 只增加 nullable/default 字段、表和索引；
2. 控制面双读/双写旧 adapter/checkpoint 与新字段；
3. 回填 platform、locator、publisher、checkpoint 和 capability；
4. 部署支持新 payload/capability 的 Worker；
5. 验证 `required_capability_protocol_version` 与 capability 心跳；产品/镜像版本只作观测，不参与租约授权；
6. feature flag 小流量启用；
7. 观察并停止旧写法；
8. 后续版本再收紧约束和移除旧字段。

发布门禁包括迁移备份、隔离恢复演练、旧/新版本兼容和远端运行验证。当前迁移 runner 已在连接前核对 `drizzle/checksums.json` 的完整有序文件集，并在 `schema_migrations` 记录和复核 SHA-256；已登记 SQL 被改写、manifest 缺项/增项或数据库 hash 漂移都会 fail closed。PGlite fresh install 和当前开发 PostgreSQL 19→21→22→23 upgrade 已通过，但尚无“当前生产基线 → 目标 SHA”的升级/恢复日志，因此 `MIGRATION-INTEGRITY-01` 仍不能提升为 Delivered。

当前步骤账本：`0003`–`0018` 的语义保持不变；`0019`–`0030` 依次冻结来源状态、提案、逐页提交、事件状态、权利、fetch outcome、SLO/预算、legal hold、canary、法律操作与 Social Evidence；`0031` 删除来源凭据/连接会话模型，`0032` 以 OpenCLI/RSS 双策略社交连接器替换误导性的公开 Feed 入口。`0000`–`0032` 已应用到本机开发 PostgreSQL 并通过迁移后浏览器复测；生产 PostgreSQL 升级、隔离恢复演练与目标环境证据仍未完成。

### 14.2 Shadow 与回滚

Shadow 使用独立 namespace/table 或严格 shadow 标志：不更新生产 checkpoint，不写正式文章、主题、待办或通知，不改变来源健康，只保留有 TTL 的脱敏摘要，并限制调用和成本。

GA 前必须支持 connector/source/version kill switch、取消未开始作业、按 ingestion batch quarantine、origin tombstone、checkpoint cutover 和受影响主题/门禁重算。当前这些代码路径均已本地实现：batch `hold/release/discard` 会触发幂等重算，checkpoint cutover 保存 before snapshot 并要求第二管理员批准。`0028` 还实现 connector/version 级独立 canary 开关：以 source ID + connector/version 做确定性 0–99 分桶，命中比例的来源按 enabled 正式运行，未命中来源自动走 shadow；开始或修改 canary 时取消 queued/retrying 作业及对应 queued run 并释放 active run，已经领取的旧正式运行则在两个完成入口按当前分桶再次复核，失配结果只隔离、不暂停来源；下一次 Scheduler tick 只统计本轮 canary 开始后的非 shadow 终态运行，达到最小样本且失败率达到阈值时调用同一持久化 kill switch，暂停该平台来源并留下审计和待办。默认配置为关闭、10% 范围、20% 失败阈值和 20 次最小样本；这些是安全默认值，不是目标环境已批准阈值。恢复手册现与脚本统一使用 `CONFIRM_RESTORE=isolated`、`RESTORE_TARGET_DB=signal40_restore_*`，并有静态回归防止变量和隔离库前缀漂移；但真实隔离恢复、并发演练、远端 CI 与目标环境证据仍未完成，因此 P0C 仍只能标记 Partial。保留审计不等于继续把错误内容视为有效证据。

每个 connector 的 acceptance pack 必须包含可执行 runbook：feature flag 名称/默认值/配置位置、connector/source/version kill switch、值班负责人和批准角色、触发阈值、对 queued/leased 作业的处理、回滚后验证 SQL/API、重算范围/预计耗时及恢复条件。Checkpoint 不允许普通直接改写；需要回退时创建双人批准、保存原 checkpoint 快照的 cutover/backfill run，历史 checkpoint 保持不可变。

当前回滚能力账本如下；“本地已有”只说明代码路径和自动化测试存在，不代表目标环境可执行：

| 回滚能力 | 当前状态 | GA 前关闭证据 |
| --- | --- | --- |
| connector/source/version kill switch | 本地已有 | 目标环境逐层停用、queued/leased 处理和恢复演练 |
| shadow no-write | 本地已有 | 目标环境证明不推进正式 checkpoint、不写正式 article/topic/通知 |
| batch quarantine、origin tombstone 与重算 | 本地已有 | 错误批次 hold/release/discard 及受影响主题恢复记录 |
| 双人 checkpoint cutover | 本地已有 | 并发冲突、审批分离、旧快照恢复演练 |
| 独立 feature flag/canary rollout gate | 本地已有；配置在 `source_connector_releases`，由 connector control API/UI 管理；默认关闭，默认 10%/20%/20 次；稳定来源分桶，未命中 shadow，下一 Scheduler tick 自动停用 | 目标环境校准阈值并演练命中/未命中、达到阈值、queued/leased 隔离、待办、恢复与并发 CAS；保存 SQL/API/audit/run IDs 和签字记录 |
| connector acceptance runbook | 模板已有，目标环境证据未生成 | 值班人实际执行并由对应批准角色签字 |

### 14.3 数据库事故决策树与 release manifest

回滚先根据数据是否受损分流：

1. connector 行为错误但数据未损：先 kill switch/停写，隔离在途批次，不回滚数据库；
2. 应用版本错误：只能回退到仍兼容当前 expand schema 的制品，核验旧 writer 不写新语义；
3. checkpoint/origin 局部污染：使用 quarantine/tombstone/双人 cutover 和受控重算，不直接改表；
4. schema/大范围数据损坏：停写后执行 PITR 或隔离库恢复，按事先批准的 RPO/RTO 裁决重放范围；
5. contract-drop 只在旧 writer 观测为 0 满一个完整回滚窗口后执行。

恢复验证不只比较表名和行数，还要核对关键约束/索引/sequence、active-run/checkpoint/origin 不变量、对象版本/清单与审计链。RPO、RTO、回滚窗口和数据丢失批准人必须在目标环境演练前写入 runbook。

release manifest 每行至少包含：`connectorId/version`、`releaseMode(disabled|shadow|enabled)`、`acceptanceState`、环境、授权模式、需要的 workload/capability protocol、制品 digest、OpenAPI baseline digest、权利证据版本/到期日、验收包链接、负责人、kill switch 和下次复核日。`releaseMode` 和 `acceptanceState` 是两个独立字段，不存在未定义的 connector `committed` 状态。

## 15. 分层完成定义

### 15.1 Foundation GA

- UI 支持 draft、连接/测试、启用、立即采集、停用、重新连接和运行详情；
- Scheduler 与匹配 Worker 无人值守持续采集；
- 原子提交、checkpoint、能力路由和幂等通过故障注入；
- 权利、RBAC、SSRF、保留和审计通过分项安全验证；
- 一个真实 RSS（公开使用权已验证）与一个真实、无凭据 Public JSON 分别 Accepted；
- 来源健康、错误、成本和待办已实现，chaos 通过后继续用 7 天真实数据做 pre-GA 复核，并完成 28 天硬观察；低频来源还须覆盖两个预期更新周期；
- 正常流程无需终端。

Foundation GA 的签字对象分开：自动化负责人确认 SSRF/RBAC/跨源 Header/secret scan/lease/capability；SRE 确认容器边界、网络策略和恢复演练；Security/法务确认威胁模型与 rights-grant 模板；产品/编辑确认三步首接、批量接入与故障恢复；外部验收包确认真实 RSS 和 JSON。任何一个 `npm test` 结果都不能代替这些签字。

Foundation GA 只代表连接器平台达到生产门槛，不代表 Social Evidence 可以自动放行。在 Social Evidence GA 前，`unknown`、低置信度或只用 URL/标题指纹形成的 family 不增加独立来源数；涉及 social/web/syndicated 的项目必须人工确认独立性，自动建项目和自动 research approval 保持关闭。

### 15.2 单连接器状态

- `Proposed`：只有方案；
- `Implemented locally`：代码、迁移、本地自动化与可重现证据存在；
- `Delivered`：实现已进入可恢复提交，目标 SHA 的 required CI 通过并有可追溯制品；
- `Deployed`：该制品 digest 已进入明确目标环境，但不当然意味真实上游已连通；
- `Integrated`：目标环境与真实平台/来源连接成功；
- `Accepted`：真实增量、恢复、授权和用户流程通过；
- `Blocked`：没有稳定或合法外部能力，入口不得显示可用，并记录复核日期；

公众号或小红书 Blocked 不阻止 Foundation GA，但阻止该平台被列为已支持。

### 15.3 Social Evidence GA

- 社交转载数量不能绕过独立证据门禁；
- publisher entity、evidence family 和声明级证据参与门禁；
- 标注集达到冻结阈值，并有生产抽样；
- 补证失败进入待办，低置信度不自动放行。

### 15.4 Vision Complete

- release manifest 中 `releaseMode=enabled` 的连接器全部达到 `acceptanceState=Accepted`；
- exploratory/Blocked 平台不属于承诺集合，必须隐藏或明确显示当前不可连接；替代路径只能标为 Fallback，不能让 Blocked connector 获得 Accepted；
- 高频来源在 chaos 通过后至少连续观察 28 天，其中第 7 天只是 pre-GA review；低频来源同时至少覆盖两个更新周期；
- 运行、质量、安全、成本和恢复证据可追溯；
- 不再依赖 JSON/CSV 或命令行完成日常采集。

达到对应层级前，只能声明单项能力的实际状态，不能笼统宣称“数据源自动采集已经完成”。

### 15.5 对外状态用语

| 当前证据 | 允许使用的表述 | 禁止使用的表述 |
| --- | --- | --- |
| 只有本地代码与自动化测试 | “已本地实现/正在开发验证” | “已上线”“可生产使用”“已支持该平台” |
| 已提交、CI 全绿且有制品 | “已交付待集成” | “已接通真实来源”“已验收” |
| 目标环境连通真实授权上游 | “已集成，等待业务验收” | “稳定可用”“无人值守已通过” |
| 单连接器 Accepted | “RSS 已验收”或“Public JSON 已验收” | 用单连接器结果概括所有数据源平台 |
| Foundation GA | “来源订阅基础平台 GA；支持 release manifest 所列连接器” | “公众号/小红书/网页均已支持”，除非它们分别 Accepted |
| Social Evidence GA | “社交信号可在冻结门禁下自动进入生产” | 在 GA 前以采集成功推导证据充分 |

状态页、README、发布说明和销售/演示口径都遵循本表；release manifest 必须列出 connector ID、版本、状态、适用环境、授权模式和验收包链接。某个连接器降级或证据到期时，只降级对应声明，不掩盖为整个平台绿色。

## 16. 评审意见闭环索引

本版把多角色意见落实到正文，后续评审按本表检查，不再依赖聊天记录：

| 主题 | 已落入章节 | 关闭标准 |
| --- | --- | --- |
| 首次接入过重、角色混淆、批量迁移 | 3.1–3.4、9、13.4 | `P0A-RBAC-01/PRODUCT-E2E-01`关闭；三步定义可测；提案/批准不自批；批量不绕门禁 |
| 状态枚举混用 | 5.2、12.1 | `P0A-STATE-01`关闭；DB/TS/OpenAPI/UI 等值，无未登记投影 |
| 雷达隐藏社交信号、编辑负荷过大 | 3.6–3.7、10.1 | 发现/生产分层；高流量来源不制造待办风暴 |
| source type 自报、转载绕门禁 | 5.1、5.5、10、15.3 | 服务端治理；合格图匹配与声明级证据通过标注集 |
| SSRF/DNS rebinding/重定向泄密 | 6.2、13.1 | socket IP 绑定、逐跳授权与真实攻击测试 |
| Worker 过权或部署 Secret 泄露 | 5.3–5.4、6.3、8.2 | 服务 token 能力子集、环境变量 allowlist、镜像扫描和生产最小权限签字 |
| checkpoint 倒退、分页中断、中间页提前可见、并发重复 | 8.1–8.5、13.2 | `P0A-VISIBILITY-01/P1B-CHAOS-01`关闭；逐页幂等、CAS、active run、staged visibility 与多实例不变量通过 |
| 权利过期、撤回与依法删除 | 5.4、5.6–5.7、8.4、13.2 | 提交前复核、下游传播、对象删除与回执恢复 |
| 浏览器隔离仅停留在原则 | 7.3、P2、13.1 | 固定部署策略与恶意页面真实验收 |
| Worker 镜像携带整份 `.env` | 2.1、6.3、12.2 | `P0A-IMG-01`关闭；镜像层/SBOM/运行环境无越权 canary Secret |
| 公开可访问被误当成法律授权 | 4、5.4、12.2 | `LEGAL-RIGHTS-01`关闭；条款快照、权利 dossier、到期/撤销演练与 Legal 签字 |
| 删除事件强制伪造正文 | 5.5、12.2 | `P0A-CONTRACT-DELETE-01`关闭；upsert/tombstone 判别联合与下游回归 |
| 本地实现被误报成已交付 | 2.1、12、15.2 | commit/CI/digest/环境证据齐全 |
| 阶段混合已完成和未开始工作 | 12 | 工作包状态、剩余、依赖和关闭证据逐项更新 |
| 测试清单无法证明已执行 | 13 | 证据绑定可还原 tree/制品、完整命令、版本、skip、日志、时间、失效条件与独立批准人 |
| 发布/回滚不可执行 | 14 | 每 connector acceptance pack 含 feature flag、kill switch、数据库事故决策树、RPO/RTO 与已实际运行的 runbook |
| 迁移标签存在即被当作幂等/不可变 | 12.2、14.1 | `MIGRATION-INTEGRITY-01`关闭；33 项 checksum、fresh/upgrade 与 drift 负测试 |
| 外部平台导致总体永不完成 | 4、15.2、15.4 | Foundation、单 connector、Social Evidence、Vision 分层判定 |
| 评审意见只有原则、无法排期 | 12.2 | 每个剩余项具备 ID、Owner、依赖、退出条件和关闭证据 |
| 发布文案扩大真实能力 | 2.2、15.5 | README、状态页、release manifest 与证据等级一致 |

### 16.1 多角色评审裁决

| 评审视角 | 本版处理 | 裁决 |
| --- | --- | --- |
| 产品/编辑 | 将来源 proposal 与权利/启用决策分开；冻结三步可测定义、manifest 内可用入口、批量歧义、Radar 双层和高流量摘要 | 已转为 `P0A-RBAC-01/PRODUCT-E2E-01`；proposal、独立 rights capability 与异人决定已本地实现，但真实跨角色浏览器验收仍未完成 |
| 架构/数据一致性 | 按实体冻结状态；NormalizedSourceItem 改为 upsert/tombstone；逐页写入 staged；能力兼容只使用整数 protocol | `P0A-STATE-01/P0A-VISIBILITY-01/P0A-CONTRACT-DELETE-01` 已本地实现；外部 connector 行为与多 Worker chaos 仍待环境验收 |
| 安全 | 纠正镜像 `.env`、RFC 6890 覆盖和浏览器响应的过度声明；冻结 actor/Worker DTO、canary 扫描和生产网络边界 | 已转为 `P0A-API-03/P0A-IMG-01/P0A-NET-01`；本地镜像/进程隔离及 layer canary 已实现，远端 SBOM/Trivy、目标网络、运行态 canary 与 Security 验收仍未完成 |
| 运行/SRE | 公平调度、停机补跑、结构化退避、active run、SLO、预算、kill switch、shadow、quarantine、cutover 和恢复条件进入 8、11、14 | 已纳入方案；canary feature flag/稳定分桶/自动停用已本地实现，多实例目标环境演练与真实观察尚缺 |
| 交付/验收 | 统一五级状态，拆分 API-04A/04B，补全 33 项迁移完整性、必需 CI、OCI digest/provenance、执行批次、决策树与 28 天观察 | 已转为 `MIGRATION-INTEGRITY-01/DELIVERY-01/P1B-SLO-01/P1B-OBS-01`；实现已落到 `47a7596`，但该 SHA 的 required CI 失败，仍不支持 Delivered |
| 法务/治理 | 区分 provisional assertion 与 verified grant；配置变化不刷新权利；删除降级为来源范围编排，补物理数据和 legal hold 职责分离 | 已转为 `LEGAL-RIGHTS-01/LEGAL-E2E-01`；当前不得显示“依法删除已完成” |

“已纳入方案”只表示评审意见已转化为可执行要求，不表示对应代码、外部接入或验收已经完成。各项当前事实仍以 2.1 和 12 的账本为准。

仍标为 Planned、Partial、Experimental、Blocked 或未 Accepted 的项目，必须继续保留该状态，直到对应关闭证据实际产生。

## 17. 开放决策与风险登记

| ID | 决策/风险 | 当前裁决 | Owner | 最晚决策点 | 失效/升级条件 |
| --- | --- | --- | --- | --- | --- |
| `R-STATE-01` | 多组状态枚举曾被混用 | §5.2、DB/TS/OpenAPI/UI 已本地等值并有负测试；部署混合版本仍待 DELIVERY 验证 | Platform + Product | `DELIVERY-01` 前 | 任一 API/UI 出现未登记状态立即升级 P0 |
| `R-PRIV-01` | 构建历史、制品层或运行环境可能携带越权 Secret | 当前 `.dockerignore`、allowlist-copy 镜像与显式 env allowlist 已降低风险；本地 compose 仍不得当作生产清单 | Security + Delivery | `DELIVERY-01` 前 | 任一 canary Secret 出现在越权镜像层、SBOM、进程环境或日志即停止发布 |
| `R-ROTATE-01` | 本次本地验证曾让 Compose 展开 `.env`，真实 OpenAI/对象存储凭据出现在工具输出 | 相关凭据按已暴露处理；轮换并验证旧凭据失效前禁止任何生产式部署或共享证据包 | Repository owner + Security | 立即，且早于 `DELIVERY-01` | 新凭据再次出现在终端、日志、HAR、镜像层或制品即停止并重启事件处置 |
| `R-PUBLIC-DTO-01` | actor DTO 回归或新增路由可能再次暴露执行内部字段 | `P0A-API-03` 已有 allowlist/OAS/回归，仍缺运行态扫描与 Security sign-off | Security + Platform | 批次 A 结束前 | cursor/object key/raw/error/Secret URL 任一泄漏即阻断交付 |
| `R-RIGHTS-01` | admin confirmation 可被误当法律授权 | 只视为 provisional，不进入 Accepted | Legal + Product | 首个真实来源启用前 | 无条款快照/权利 dossier 时 fail closed |
| `R-VISIBILITY-01` | 分页中间数据可能提前进入雷达/门禁 | complete 前 staged、完成后原子可见已本地专项验证；真实 kill/多 Worker 仍待 chaos | Platform + Editorial | RSS/Public JSON E2E 前 | 任一未 complete/held 页可见即停用 connector |
| `R-OBS-01` | 观察期和阈值可能成为移动球门 | 7 天仅 pre-GA，28 天是硬门禁；启动前先签字 SLO | SRE + Product | chaos 前 | 观察中改口径则时钟重置 |
| `R-SOCIAL-01` | 公众号/小红书/热榜被误报支持 | 默认 hidden/disabled，按 connector 独立 Spike | Product + Legal | 加入 manifest 前 | 平台/合同/删除路径变化自动降级 Blocked |
| `R-RUNBOOK-01` | 恢复文档参数与脚本不一致 | 当前 runbook 不可作为执行证据 | SRE | `DELIVERY-01` 前 | 示例未在隔离库实跑或任一命令安全失败 |
| `R-CI-01` | 本地全绿与远端 CI 结果背离：`47a7596` 本地 260 pass/0 skip，但同一 SHA 的 required CI 4 job 全红，且 application job 在测试之前就中断 | 两个阻断项已定位并修复（OAS baseline 锚定、运行层移除 npm），**但在新的 CI run 全绿之前，`DELIVERY-01` 保持 Not delivered**；修复本身不构成交付证据。另注：CI 的 `Render image smoke` 此前从未真正执行过（每次都在更早的步骤失败），且其调用方式依赖镜像内不存在的 `scripts/render-smoke.ts` 与 `test/fixtures/`，已一并改为只读挂载后用 node 直调 | Delivery + Security | `DELIVERY-01` 前 | 以本地结果替代远端 required check，或为通过而放宽 OAS checker / 扫描阈值，即升级为 P0 |

本表每周复核，但任务状态只在关闭证据产生时改变。风险接受必须绑定具体批准人、到期日和适用 connector/version；无期或泛化“已知风险”不是有效接受。
