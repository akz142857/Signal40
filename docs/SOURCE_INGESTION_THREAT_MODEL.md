# 来源订阅与采集威胁模型

- 日期：2026-09-09
- 范围：来源创建、测试、调度、Worker 拉取、raw upload、原子提交、主题重算、隔离、撤权与删除
- 状态：本地设计/代码核对，不是生产安全签字；与 `SOURCE_SUBSCRIPTION_AND_INGESTION_PLAN.md` v3.3 一致

## 1. 资产与信任边界

受保护资产包括 PostgreSQL 中的 source/grant/checkpoint/article/origin/audit，权利 evidence/terms snapshot，Object Storage raw payload 及其版本/复制/备份，signed URL，Worker token，游标/checkpoint，HAR/trace/crash dump，日志/快照/导出，删除回执以及编辑/发布门禁。来源连接器不保存平台账号、Cookie 或来源 Secret。

信任边界：浏览器到控制面、控制面到 PostgreSQL/Object Storage、DNS resolver/egress proxy、部署环境 Secret、容器编排、控制面到 source Worker、Worker/浏览器到外部来源及 subresource、外部供应商、调度器到控制面、主题派生作业到正式语料。来源响应、标题、正文、URL、redirect、cursor 和错误体全部是不可信输入。

攻击者模型包括恶意来源站点、被攻陷的 Worker/供应商账号、恶意或误操作管理员、供应链依赖和能访问日志/制品/备份的内部主体。

## 2. 本地观察到的控制与生产有效性

| 威胁 | 本地实现状态 | 生产有效状态 | 未关闭风险/证据 |
| --- | --- | --- | --- |
| SSRF、私网/元数据访问 | Partial：URL/端口、DNS 与 socket pin、逐跳 redirect、响应上限；应用层固定 IANA 2025-10-09 IPv4/IPv6 special-purpose corpus，并解包 mapped/NAT64/6to4 | Not Accepted | 仍需目标环境默认拒绝网络、代理旁路/CNAME/逐跳决策日志、actual remote IP/SNI 与包级攻击证据（`P0A-NET-01`） |
| 配置测试后偷换 | config hash、测试有效期、启用前重验 | 未验收 | 需真实浏览器/Worker 并发更改负测试 |
| 旧授权复用 | immutable grant version、单 current 约束、config/source version 绑定 | 法律有效性未验收 | 当前 admin confirmation 只是 provisional；需权利 dossier 与 Legal 签字（`LEGAL-RIGHTS-01`） |
| 调度后撤权 | 入队、租约、提交多边复核；失权 run `rights_blocked/held` | 未验收 | 需目标环境在途撤权、raw 清理与下游可见性证据 |
| Worker 越权领取/读取 Secret | kind/capability/protocol/release control、`.dockerignore`、独立镜像与 env allowlist 已本地验证 | Not Accepted | 仍需目标部署的实际 Secret 可见矩阵、远端镜像扫描和 Security 签字（`P0A-IMG-01`） |
| 数据库/job 保存长期明文 | 当前 RSS/Public JSON 主线不需要来源 Secret；浏览器 DTO 与部署 Secret 分离已有本地回归 | 未验收 | 不代表镜像、日志或备份已在目标环境验证 |
| 浏览器/API/日志脱敏 | Actor/Worker allowlist、URL 清理和敏感值扫描已本地实现 | Not Accepted | 仍需真实浏览器 HAR 与目标环境 log/trace/snapshot/export 扫描（`P0A-API-03`） |
| 重放/并发覆盖 | Idempotency-Key、active run、lease owner/epoch/expiry、checkpoint CAS、live/backfill 分离 | 未验收 | 需双 Scheduler/多 Worker/kill-point chaos（`P1B-CHAOS-01`） |
| 坏条目污染整批 | 规范化校验、逐条 rejection、字段授权、数量/字节/请求上限 | 未验收 | 需真实坏数据、schema drift 与部分失败上游验收 |
| Raw 孤儿与删除误报 | upload session、hash/size/source/run 校验、TTL、删除租约/重试 | 物理删除未验收 | 需对象版本/复制/锁/备份/缓存和多实例强杀证据 |
| 错误 connector 扩散 | connector/version disabled/shadow/enabled、queued 取消、leased 隔离 | 未验收 | 需目标环境 kill/shadow/recovery drill |
| 已提交错误批次 | hold/release/discard、origin tombstone、幂等重算 | 未验收 | 需证明未 complete/held 中间页对雷达/门禁不可见（`P0A-VISIBILITY-01`） |
| 人工倒退 checkpoint | before snapshot、第二 admin、source/checkpoint CAS、active run 阻断 | 未验收 | 独立 release operator 权限、并发冲突与真实恢复演练 |
| 转载绕独立性 | 保守关系分类器、origin/evidence family/publisher group 最大匹配、不可变人工修正、声明级合格支持与未批准策略 fail closed 已本地实现 | In progress | 已授权标注集、真实生产抽样、阈值评测报告与 Product/Editorial sign-off 未完成 |
| 删除被误报为完成 | deletion request/item、步骤回执、receipt hash、pending 文案边界 | 法律/物理有效性未验收 | 需全系统 deletion matrix、外部二次验证和 Legal sign-off |
| Legal hold 被绕过 | active hold 阻断初始化/分批删除，共享 origin 保护；建立者不能解除；hold epoch 作废已领取的外部撤回租约；对象删除与 hold 建立共享 source 行锁；Render Worker 在外部副作用前复核 lease/epoch/hold | 本地已验证，目标环境未验收 | 仍需真实身份、Legal authority 映射、对象存储/平台并发演练与 Legal/Security 签字 |
| 删除失败后丢步骤 | 短租约、过期恢复、失败重试、dead-letter 显式重试 | 未验收 | 需并发强杀、外部回执和对象系统真实故障证据 |

## 3. 尚未关闭的生产风险

以下项目不能用本地单元测试替代：

- 生产出站代理/网络策略对 DNS rebinding、跨 origin redirect、IPv6、云元数据和代理环境变量的真实阻断；
- 每 workload 独立身份与 token policy；当前共享 token/combined profile 只允许开发；
- Source Worker 的非 root、只读根文件系统、无宿主挂载、seccomp/AppArmor 和资源上限；
- 公开 Feed/网页的权利、canonical identity、编辑/删除语义与配额；
- 依法删除的真实平台撤回、对象锁/保留策略冲突、多实例强杀恢复和法律签字；本地状态机与回归不能替代这些证据；
- 双 Scheduler/多 Worker 强杀和恢复演练、冻结后的 7/28 天 SLI/burn-rate 查询，以及 chaos 通过后的连续 28 天真实观察；第 7 天仅作 pre-GA review；
- Secret scan、SAST/依赖/镜像扫描、远端 CI、制品签名与目标环境批准。

Foundation GA 只由 release manifest 中实际启用并验收的公开来源决定，必须关闭浏览器/API 脱敏、生产 egress、Worker 最小权限、来源范围删除与真实 E2E。网页/热榜、公众号 Feed 和小红书 Feed 的本地代码已经就绪，但仍按真实 URL/Feed 独立验收；Social Evidence 按真实语料和生产抽样独立验收。

## 4. 滥用场景与响应

1. 恶意 feed 返回控制面地址：网络层拒绝，Worker 记录脱敏 `SSRF_BLOCKED`，不重试。
2. 来源在 lease 后撤权：提交返回 terminal `RIGHTS_BLOCKED`，来源暂停，raw 删除，产生去重待办。
3. 发布版本出现解析错误：connector kill switch disabled；取消未领取运行；leased 结果提交隔离；按 Runbook shadow 修复版。
4. 管理员误改 checkpoint：直接写接口不存在；cutover 要求第二 admin，任何版本推进都会使审批失败。
5. 社交转载伪装独立证据：低置信度/unknown family 不自动放行，社交/网页在 Social Evidence GA 前保留人工审批。
6. Worker 声明越权能力：控制面按服务 token policy 与 capability protocol 拒绝并写脱敏审计。
7. 删除期间出现 legal hold：对象删除与 hold 建立使用同一 source 行锁确定先后；已排队、重试中或已领取的外部撤回作业都会被取消并递增 lease epoch，Render Worker 在平台调用前再次复核。已经在外部平台实际开始或完成的删除只能如实记录并幂等对账，不能伪造回滚。
8. 外部撤回 Worker 失败：请求转 `failed`，不清除数据库派生记录；管理员修复原因并显式重试，只有成功回执才进入最终清理。
9. 恶意或误操作解除 legal hold：建立绑定 case/authority 和不可变原因，解除必须由另一管理员执行；`0027` 为每次建立生成单调 hold epoch，旧 lease 不能继续，解除后必须以更新 epoch 的新租约恢复。代码与 PG 负向测试已完成；真实 Legal authority 身份映射、目标平台竞态演练和独立签字仍是生产阻断项。

## 5. 验证责任

- Platform：config/grant/checkpoint/lease/commit 原子性与回归测试；
- Security：RBAC、SSRF、secret scan、容器和网络攻击测试；
- SRE：迁移恢复、kill/shadow/cutover 演练、身份与网络策略、SLO；
- Legal/Editorial：权利模板、保留/删除、来源用途、声明级证据；
- Product：三步首接、批量接入、故障恢复和无终端日常流程。

签字必须绑定 commit、镜像 digest、环境、connector/version、执行时间、有效期/失效条件和证据链接；“代码存在”不等于生产控制已生效。

## 6. 残余风险记录要求

每个未关闭风险必须记录 `risk_id`、资产/信任边界、攻击者、适用 connector/version、本地控制、生产有效性、残余影响/可能性、Owner、关闭证据、独立接受人和到期日。没有到期日的泛化风险接受无效；依赖、平台政策、合同、镜像、网络或身份发生变化时自动失效并重新评审。
