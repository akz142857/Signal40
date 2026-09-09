# 来源采集固定种子故障演练

更新时间：2026-09-09

这份演练是 `P1B-CHAOS-01` 的本地前置证据，不是目标环境验收。它使用完整 PostgreSQL 迁移构建的 PGlite 数据库，直接执行生产控制面的入队、租约和物化函数，并在事务边界注入确定性失败。固定 seed 为 `signal40-source-chaos-2026-09-09-v1`。

## 执行

```bash
npm run source:chaos
```

需要保存机器可读报告时：

```bash
npm run source:chaos -- --output /tmp/signal40-source-chaos.json
```

命令成功时输出 JSON，`summary.failed` 必须为 `0`。任何断言失败都会以非零状态退出，不会生成“部分通过”的绿色结论。常规回归 `npm test` 也会执行同一演练。

## 固定拓扑与覆盖

| 场景 | 本地演练证明 |
| --- | --- |
| 两个 Scheduler 同时处理同一 occurrence | 幂等键只创建一个 job/run，每来源只有一个 active run |
| live 与 backfill 同时发起 | 当前 Foundation 策略串行化，两者不会同时持有活动运行或推进不同 checkpoint |
| 一个旧协议、两个新协议 Worker | HTTP JSON v1 Worker 不能误领 v2 作业；v2 Worker 正常领取 |
| 原始载荷上传失败后重放 | 会话先进入 `aborted`，同内容重放恢复到 `uploaded`，不会创建第二会话 |
| page DB commit 前失败 | page、run 内 checkpoint 和业务可见数据全部回滚 |
| page HTTP ACK 丢失 | 同 page key、内容 hash 和 lease epoch 返回 replay；不同内容冲突 |
| page 已提交但 run 未 complete | article origin、公开 checkpoint 和 topic recompute 都保持不变 |
| Worker 崩溃且 lease 到期 | 新 Worker 以递增 epoch 接管 running ingestion；旧 epoch 无法完成作业 |
| complete DB commit 前失败 | article/origin/checkpoint/recompute 同事务回滚 |
| complete 成功及 ACK 丢失 | 内容与 checkpoint 一次性可见，只存在一个 origin/revision 和一个 recompute job；持久结果可只读重放 |

报告中的 before/after snapshot 执行真实 SQL，至少记录：

- `queued/running` 活动运行数；
- 已提交 page 数、该 run 可见 origin 数；
- 按 `(source_config_id, namespace, platform_item_id)` 分组的重复 origin 数；
- 按 `(article_id, content_hash)` 分组的重复 revision 数；
- `source_configs.checkpoint_json/checkpoint_version`；
- 由该 run 产生的 topic recompute job 数。

## 明确不覆盖

本地命令不启动真实 Scheduler/Worker 进程，不发送 SIGKILL，不操作容器、云 IAM、生产 egress 或远程对象存储，也不伪造这些证据。以下项目仍必须在部署候选版本上完成，才可关闭 `P1B-CHAOS-01`：

- fetch、raw upload、page commit 前后、complete 前后和 HTTP ACK 丢失处的真实进程/容器强杀；
- 真实 429、Retry-After、超时、响应断开、DNS 变化和可控 clock skew；
- multipart 部分失败、对象已写而 DB 未提交、孤儿对象 sweeper；
- 在途 rights revoke、credential rotate/revoke 与 source/version kill switch；
- 至少三个已部署 Worker 的新旧镜像混跑，以及远程数据库 before/after SQL；
- 固定运行时长、资源上限、日志/追踪链接和 SRE + Source Platform 签字。

因此，本地演练通过只能把 `P1B-CHAOS-01` 从 `Planned` 推进到 `In progress, local seeded harness`，不能标记 `Delivered`、`Integrated` 或 `Accepted`，也不能启动正式 28 天观察。
