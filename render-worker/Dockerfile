FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# 运行层不留包管理器：11 项 HIGH/CRITICAL 全部来自基础镜像自带的 npm 依赖
# （tar/brace-expansion/ip-address/pacote/picomatch/sigstore），升级 npm 也清不干净。
# 运行时只需要 node，删掉 npm 同时缩小攻击面，符合 P0A-IMG-01 的最小镜像要求。
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY render-worker ./render-worker
COPY lib ./lib
COPY video ./video
COPY public ./public
COPY scripts/media-qc.ts ./scripts/media-qc.ts
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
ENV NODE_ENV=production
ENV SIGNAL40_WORKER_PROFILE=render
ENV SIGNAL40_DEPLOYMENT_MODE=production
# 非特权用户运行 Node/Chromium/FFmpeg：渲染进程会执行来自控制面的项目数据，不应拥有 root。
RUN useradd --system --create-home --home-dir /home/signal40 --shell /usr/sbin/nologin signal40 \
  && chown -R signal40:signal40 /app /home/signal40
USER signal40
ENV HOME=/home/signal40
CMD ["node", "--experimental-strip-types", "render-worker/worker.ts"]
