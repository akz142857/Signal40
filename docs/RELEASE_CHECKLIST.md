# Signal 40 全流程发布检查清单

## 1. 目标版本

- [ ] 记录目标提交 SHA、控制面版本、Worker 镜像 digest、模板版本和迁移清单。
- [ ] 工作树只包含拟发布改动；生成成片、密钥和本地数据库/对象存储状态未进入 Git。
- [ ] 产品决策已冻结：渠道、品牌、时长、声音/素材权利、审核人、许可、预算和保留期。

## 2. 自动化门禁

- [ ] `npm ci`、`npm audit --omit=dev`。
- [ ] `npm test`、`npm run test:evaluation`、`npm run lint`、`npm run build`。
- [ ] 空库顺序应用 `drizzle/` 下的全部迁移，再次执行无待处理迁移。
- [ ] `npm run test:render` 与 Docker 内 `npm run test:render`。
- [ ] 固定 45 秒项目运行 `render` + `qc:media`，保存输出哈希和 24 类检查。
- [ ] OpenAPI YAML、项目 JSON Schema 和 1.0→2.0 迁移验证通过。

## 3. 产品与内容

- [ ] 三类真实授权来源定时采集；坏记录隔离、修订、检查点、失败、重试、DLQ 可见。
- [ ] 声明级支持/反驳、冲突解决、研究快照和独立 G3 批准完成。
- [ ] 每句事实绑定声明；版本差异、评论、锁定、读音提示和时长可审计。
- [ ] 图表有原始值、单位、变换、零基线和声明来源；资产版权全部 cleared。
- [ ] TTS 逐词对齐、字幕安全区、响度、黑帧、编码、帧率、免责声明和封面通过。
- [ ] 独立 G6/G7 审批绑定当前 SHA-256 快照。

## 4. Staging 与渠道

- [ ] 认证反向代理注入身份头（`SIGNAL40_IDENTITY_HEADER_*`）后非本地请求可正常鉴权；`SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false`，客户端伪造角色头无效。
- [ ] Secret 不出现在源码、数据库、浏览器、日志或发布包。
- [ ] YouTube 测试账号 private 发布返回 ID；重复请求不重复发布。
- [ ] 失败恢复、签名重放、取消/重放、更正关联、远端下架和事件关闭通过。
- [ ] 2h/24h/7d 指标带项目、版本、快照、渠道和实验归因回流。

## 4.1 自动化上线前

- [ ] `SIGNAL40_AUTOMATION_ACTOR_ID` 指向 `team_members` 里 active 的 admin 服务账号；未配置时 `/inbox` 会出现 `automation_actor_missing`，引擎不写入任何内容。
- [ ] `scheduler` 与 `render-worker` 作为常驻服务运行；`/settings/diagnostics` 的「调度器上次 tick」与在线 Worker 数正常。
- [ ] 策略里研究类与发布类自动授权人是**不同的真实成员**，且预先授权有效期已设定；G7 的两个批准人在审计里可区分。
- [ ] 自动建项目仅在选题质量指标达标后开启；`topics.quality_json` 有实际评估结果。
- [ ] 待办通知目标（`SIGNAL40_ATTENTION_WEBHOOK_URL`）已接入值班渠道，并验证过 HMAC 签名。
- [ ] 演练过：人工编辑自动转人工、内容事件立即停止自动化、阶段熔断后进待办箱。

## 5. 运行与灾备

- [ ] `/health` 外部探针、`/operations`、5 分钟失败告警和 80% 预算告警已接入值班系统。
- [ ] 并发上限、月预算、DLQ、Worker 超时和供应商降级演练通过。
- [ ] 隔离环境完成数据库恢复、对象清单核对和从 ResearchSnapshot 重新成片。
- [ ] 事实错误的登记、停发、撤回、修订、重审、勘误和复盘走通。

## 6. 最终签字

- [ ] 财经事实终审。
- [ ] 版权/品牌/声音与许可确认。
- [ ] 发布账号所有者批准。
- [ ] 运维值班与回滚负责人批准。
- [ ] 项目所有者明确授权源码上传和 production 发布。
