# Signal 40

财经选题雷达：从多个来源发现同一事件的短时共振，给出可审计的选题分数，并在脚本生成前执行原始信源核验门禁。

## 已完成的 V1

- 文章归一化、内容指纹去重、中文/英文关键词聚类；
- 跨来源共振、增长速度、数字冲击力、来源质量、时效性、视频可解释性评分；
- 原始来源与独立证据门禁；
- D1 数据模型与迁移；
- 选题工作台、筛选、证据抽屉、示例管道 API；
- OpenCLI 微信搜索导入脚本；
- 与 Remotion 解耦的 45 秒竖屏 `project.json` 协议。

完整产品边界和里程碑见 [开发方案](docs/DEVELOPMENT_PLAN.md)。

## 本地运行

```bash
npm install
npm run db:generate
npm run dev
```

页面内“运行采集”会用示例文章跑通完整链路。真实微信搜索需要先按 OpenCLI 官方说明完成安装和 `opencli doctor`：

```bash
npm run ingest:weixin -- "DRAM" 20
```

默认把标准化 JSON 输出到终端；设置 `SIGNAL40_API_URL=http://localhost:3000` 后会提交到 `/api/topics`。

## 验证

```bash
npm test
npm run lint
npm run build
```

## 安全与内容边界

V1 不自动登录微信、不采集未授权数据、不绕过平台风控，也不自动发布视频。候选分数只说明“值得研究”；只有通过证据门禁的主题才允许生成视频协议。
