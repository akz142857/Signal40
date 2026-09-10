# 控制面镜像：vinext 构建产物 + Node 生产服务器。
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV SIGNAL40_DEPLOYMENT_MODE=production
COPY package.json package-lock.json ./
# 运行层不留包管理器：11 项 HIGH/CRITICAL 全部来自基础镜像自带的 npm 依赖
# （tar/brace-expansion/ip-address/pacote/picomatch/sigstore），升级 npm 也清不干净。
# 运行时只需要 node，删掉 npm 同时缩小攻击面，符合 P0A-IMG-01 的最小镜像要求。
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY drizzle ./drizzle
# scripts/ 一起进镜像：同一个镜像既跑控制面，也跑迁移和调度器进程
# （node --experimental-strip-types scripts/scheduler.ts）。
COPY scripts ./scripts
COPY lib ./lib
# 非特权用户运行：控制面处理外部请求，不该有 root。
RUN useradd --system --create-home --home-dir /home/signal40 --shell /usr/sbin/nologin signal40 \
  && chown -R signal40:signal40 /app /home/signal40
USER signal40
ENV HOME=/home/signal40
EXPOSE 3000
# 迁移不在启动时自动跑——部署流程应该显式执行
# `node --experimental-strip-types scripts/migrate-pg.ts`，避免多副本同时启动时并发改 schema。
# 直接调 vinext CLI：镜像里已经没有 npm 可以解析 `npm run start`。
CMD ["node", "node_modules/vinext/dist/cli.js", "start"]
