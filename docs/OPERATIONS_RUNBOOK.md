# Signal 40 运行、故障与内容勘误手册

更新时间：2026-09-08

## 1. 值班入口与初始 SLO

- `/api/v1/health`：D1 可达性、活跃队列和 DLQ；外部探针每分钟检查。
- `/operations`：近 30 天采集、TTS、渲染、发布的成功/失败、重试、P50/P95、记录成本和待处置作业。
- 初始目标：控制面月可用性 99.9%；正式渲染 30 分钟完成率 98%；未核验声明和重复逻辑发布均为 0；重大事实错误目标为 0。
- 告警：健康接口 503 立即告警；`deadLetter > 0`、发布/渲染失败持续 5 分钟、渲染 P95 超过 30 分钟、月预算使用 80% 分别触发 P1/P2 告警。

生产告警发送器不保存在本仓库。部署时由托管监控读取上述接口，并把通知路由到团队实际值班系统。

## 2. 采集调度

外部调度器每分钟执行：

```bash
curl -X POST "$SIGNAL40_CONTROL_URL/api/v1/scheduler/run" \
  -H "X-Worker-Token: $SCHEDULER_TOKEN"
```

Cron 使用 UTC 五字段格式。调度器扫描上次运行后的遗漏分钟，最多回看 7 天；`schedule:<source>:<minute>` 保证同一计划时间只入队一次。来源失败进入指数退避，达到最大次数进入 DLQ。

## 3. Worker 启动与降级

```bash
docker run --rm --shm-size=1g \
  -e SIGNAL40_CONTROL_URL \
  -e SIGNAL40_WORKER_TOKEN \
  -e OPENAI_API_KEY \
  -e YOUTUBE_ACCESS_TOKEN \
  signal40-render-worker:<release>
```

- OpenAI 不可用：停止新建云端配音，保留已生成音轨；本地开发可用 `npm run voice:local`，不得把本地声音证据冒充生产授权。
- YouTube 不可用：使用 `package` 渠道生成待发布包，禁止绕过 G7 手工调用生产发布接口。
- Worker 过载：调低 `RENDER_CONCURRENCY_LIMIT`，高优先级先租约；预算由 `MONTHLY_RENDER_BUDGET_MICROS` 硬拒绝新渲染。
- 永久失败：管理员在 `/operations` 阅读错误后“确认并重放”；不要盲目循环重放。

## 4. 内容勘误与下架

1. 在项目事件 API 登记 `fact_update`、`correction` 或 `complaint`，填写严重度和事实原因。
2. 重大/关键事件立即停止排期。已发布内容调用 `/api/v1/publish-jobs/{id}/withdraw`；系统登记撤回事件、把项目退回 `CHANGES_REQUESTED`，并为 YouTube 入队远端删除。
3. 修订研究快照，解决冲突，重新走 G3–G7。新发布任务通过 `correctionOfId` 关联旧版本。
4. 发布勘误说明并在内容事件中记录处置结果；由另一位编辑或发布者关闭事件。
5. 对重大事实错误做复盘：来源、声明、审批、模板、平台 ID 和所有哈希必须能从审计流复原。

## 5. Webhook 与密钥

- Secret 只进入托管 Secret；`.env.example` 只有空值或占位符。
- YouTube 回调需提供 `X-Signal-Event-Id`、Unix 秒 `X-Signal-Timestamp`、`X-Signal-Signature: sha256=<hex>`。
- 签名内容是 `<timestamp>.<raw-body>`，允许时差 5 分钟；事件 ID 唯一，重放返回既有结果。
- 轮换顺序：部署新 Secret、切换发送端、验证回调、撤销旧 Secret。轮换行为在外部 Secret 管理审计中保留。

## 6. 备份与恢复

本地演练：

```bash
./scripts/backup-local.sh backups/drill
CONFIRM_RESTORE=isolated RESTORE_PERSIST_TO=/private/tmp/signal40-restore-drill ./scripts/restore-local.sh backups/drill
npm run drill:restore
```

`drill:restore` 会备份当前本地状态，在 `/private/tmp` 的隔离 D1/R2 目录恢复，执行 SQLite 完整性检查并逐表比对行数，结束后自动清理，不修改当前数据库。人工恢复脚本校验 SHA-256，且故意不自动覆盖 R2。生产 D1 使用托管导出/时间点恢复；R2 启用版本、生命周期与对象清单。季度演练必须在隔离环境恢复 D1/R2，并从研究快照重新生成成片。

## 7. 发布与回滚

1. 在目标 SHA 执行 `npm ci`、生产依赖审计、测试、100 场景回归、迁移、构建、Docker 真渲染。
2. 先做向后兼容迁移，再发布控制面与 Worker；金丝雀渲染通过后开放流量。
3. 应用/Worker 可回退上一镜像；D1 不回滚已应用迁移，采用新的前向修复迁移。
4. 发布后观察 30 分钟：健康、积压、失败、P95、成本、重复发布和内容事件。

## 8. 不可替代的人工责任

真实财经标注集、声音/素材权利、最终事实终审、渠道账号和 Remotion 商业许可必须由责任人确认。自动门禁只能阻止已知错误，不能代替财经编辑、法务或平台所有者。
