FROM node:22-bookworm-slim
# 基础镜像自带的 libpcre2 有 HIGH 级可修复漏洞（CVE-2026-86145，10.42-1 之前），
# 镜像扫描门禁会拦下来。只定向升这一个包，不做整镜像 apt upgrade——
# 后者会让镜像内容变成「构建当天 Debian 仓库的样子」，同一份 Dockerfile
# 两天构建出的镜像不再可比，而这条流水线是靠镜像可复现来做验收的。
RUN apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV SIGNAL40_DEPLOYMENT_MODE=production
COPY package.json package-lock.json ./
# 运行层不留包管理器：11 项 HIGH/CRITICAL 全部来自基础镜像自带的 npm 依赖
# （tar/brace-expansion/ip-address/pacote/picomatch/sigstore），升级 npm 也清不干净。
# 运行时只需要 node，删掉 npm 同时缩小攻击面，符合 P0A-IMG-01 的最小镜像要求。
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY render-worker/worker.ts ./render-worker/worker.ts
COPY lib ./lib
RUN useradd --system --create-home --home-dir /home/signal40 --shell /usr/sbin/nologin signal40 \
  && chown -R signal40:signal40 /app /home/signal40
USER signal40
ENV HOME=/home/signal40
ENV SIGNAL40_WORKER_PROFILE=source
CMD ["node", "--experimental-strip-types", "render-worker/worker.ts"]
