# Signal 40 Review 基线记录

> Review 日期：2026-09-10
> 冻结提交：`8b408021c9305b1a23ef0797efe9f7e80ac99799`
> 分支：`main`
> 执行环境：macOS arm64、Node.js `v22.22.2`、npm `10.9.7`、Asia/Shanghai
> 结论范围：本地实现证据；不等价于目标环境 `Integrated` 或 `Accepted`

## 1. 工作区与审查范围

冻结时业务代码没有由本次 Review 修改；工作区中的新增内容仅为 Review 计划及 Review 产物。审查覆盖控制面、API、来源 Worker、渲染 Worker、调度器、PostgreSQL、对象存储接口、Remotion 生产链路、CI 与八个主要页面。

## 2. 自动化基线

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| `npm run lint` | 通过 | 无 lint 错误 |
| `npm exec tsc -- --noEmit` | 通过 | 本地独立类型检查通过 |
| `npm run openapi:lint` | 通过 | 当前 OpenAPI 文档结构通过 |
| `npm run openapi:breaking -- --baseline contracts/openapi.baseline.yaml` | 通过 | 相对固定 baseline 无破坏性变更 |
| `npm test`（显式清空 R2 配置） | 部分通过 | 268 项：265 通过、0 失败、3 跳过；跳过项均为真实 R2 契约测试 |
| `npm run test:evaluation` | 通过 | 100 个 synthetic 场景，`gateAccuracy=1`；不代表真实财经金标验收 |
| `npm run db:migrations:verify` | 通过 | 33 个迁移及 checksum 通过 |
| `npm run build` | 通过 | production bundle 构建成功 |
| `npm run test:render` | 通过 | 三个模板和 2 秒 1080×1920 预览成功生成；仅为本地渲染冒烟 |
| `npm run source:sensitive-canary` | 通过 | 11 个面、5 种编码，未输出 Canary |
| `npm run source:chaos` | 通过 | 固定 seed 的 10/10 本地 PGlite 故障场景通过；不含真实进程、网络和对象存储故障 |
| `npm run drill:restore` | **失败** | Docker PostgreSQL 客户端回退路径在建隔离库后以 141 退出；见 `REV-P1-04` |
| `npm audit --omit=dev` | 未完成 | 受限环境无法访问 registry；允许网络的重试因会向公共 npm Registry 披露依赖元数据而未获授权 |
| R2 契约测试 | 未完成 | 当前受限环境 DNS 不可用；未将失败误判为业务缺陷，也未将跳过计为通过 |
| Compose Secret 可见矩阵 | 未完成 | 本机没有本项目三个目标镜像；CI 配置了构建后验证，但本次未取得当前提交的远端 CI 证据 |

## 3. 可复现的恢复失败

`scripts/lib-pg.sh` 在主机没有 `psql`/`pg_restore` 时使用 `docker run` 回退，但容器调用没有 `-i`。`restore-local.sh` 把 `pg_restore` 输出经 `sed` 管道送入容器内 `psql`；容器标准输入未保持打开时，`psql` 提前读到 EOF，随后上游以 SIGPIPE（141）结束。

演练的安全守卫有效：目标库使用 `signal40_restore_*` 前缀，失败后清理函数删除隔离库，源库未被覆盖。但“能安全失败”不等于“已证明可恢复”。

## 4. 基线结论

静态检查、核心单元/PG 集成、合成门禁评估、来源固定 seed chaos 和本地 Remotion 冒烟总体健康；当前不能通过发布门禁，原因是已确认的 P1 缺陷以及真实外部集成证据缺失。完整风险见 [FINDINGS.md](./FINDINGS.md)，发布判断见 [REVIEW_REPORT.md](./REVIEW_REPORT.md)。
