# Source Credential Broker 运维手册

## 适用范围

当前实现为开发/自托管环境的 `environment` provider。浏览器与 source Worker 永远不读取长期 Secret；Worker 把受约束请求交给控制面 Broker，Broker 在进程内注入 Header 并返回上游内容。生产上线前必须替换或扩展为云 Secret Manager + workload identity，并单独验收网络与身份策略。

## 预配 alias

在控制面环境中配置策略和实际 Secret：

```dotenv
SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON={"market-data":{"provider":"environment","secretEnv":"SIGNAL40_MARKET_DATA_KEY","targetOrigins":["https://api.example.com"],"headerName":"Authorization","prefix":"Bearer "}}
SIGNAL40_MARKET_DATA_KEY=<secret only in control-plane environment>
```

规则：

- alias 是 UI 可见的逻辑名，不是 Secret；
- `secretEnv` 必须以 `SIGNAL40_` 开头，且不会由 policies API 返回；
- `targetOrigins` 只能是无路径、无用户信息的 HTTPS origin；
- `headerName` 不能是 Cookie、Host、Connection、Content-Length、Proxy-Authorization 或转发类 Header；
- 不得把 token/key/signature 放到来源 URL query；
- source Worker 的容器/服务环境不得包含 `SIGNAL40_MARKET_DATA_KEY`。

## 接入与轮换

1. 在 `/sources` 新建 HTTP JSON 来源，选择与 URL origin 匹配的 alias；页面不会要求粘贴 Secret。
2. 绑定会生成新的 opaque `credential_ref` 和递增版本，来源保持禁用并要求重新测试。
3. 测试通过后人工核对预览，再启用。
4. 轮换时先在 provider 更新 Secret，再在来源卡片点“轮换凭据”；旧 queued/retrying 作业会取消，已租约结果在提交时隔离。
5. 若策略的 origin/Header 发生变化，更新服务端配置后重新绑定；策略漂移时 Broker fail closed。

当前版本是立即切换，不提供双版本宽限窗口。需要零中断轮换的供应商必须等双版本窗口实现与验收后再标记 Accepted。

## 紧急撤销

在来源卡片选择“撤销凭据”并填写审计原因。系统将：

- 撤销 current binding，递增 credential/source version；
- 停用来源并标记 `auth_required`；
- 取消未领取采集；
- 拒绝旧 ref/version 的新 Broker 兑换；
- 在旧租约提交时不写规范化数据、不推进 checkpoint，并把 raw 标记为待删除。

撤销环境变量本身由 Secret provider/运维系统执行；应用内撤销与 provider 撤销应同时完成。

## 审计与排障

- `source_credential.bound/rotated/revoked`：管理员生命周期操作；
- `source_credential.redeemed`：记录 workload、source、job、target origin、版本和结果；
- `source_ingestion.credential_blocked`：旧版本在提交边界被隔离；
- `AUTH_REQUIRED`：Secret 缺失、上游 401/403、撤销或版本变化；
- `POLICY_DRIFT`：数据库策略快照与当前服务端 allowlist 不一致，必须重新绑定；
- `SSRF_BLOCKED`：URL、DNS/IP 或重定向目标被安全边界拒绝。
- `UPSTREAM_SECRET_REFLECTION`：上游响应正文或 Broker 会返回的响应字段命中当前 Secret，整包已丢弃；应按凭据泄漏事件轮换并检查供应商日志。

审计和日志中不得出现 Secret、Secret 环境变量值、完整带敏感参数 URL、请求 Header 或完整上游错误体。发生疑似泄漏时先在 provider 轮换/撤销，再停用连接器版本并保全脱敏审计证据。

## 上线门禁

- Secret scan 与日志/审计/API 快照验证为零泄漏；
- source Worker 环境确实看不到 provider Secret；
- 使用真实 egress 验证 DNS rebinding、云元数据、IPv6、HTTPS 降级与跨 origin redirect；
- 使用真实授权 API 验证 401/403、429、轮换中途与撤销中途；
- Secret Manager IAM 只允许 Broker workload 读取指定 alias；
- 证据绑定 commit、镜像 digest、部署环境和批准人。
