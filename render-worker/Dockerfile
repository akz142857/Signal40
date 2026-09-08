FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
ENV NODE_ENV=production
# 非特权用户运行 Node/Chromium/FFmpeg：渲染进程会执行来自控制面的项目数据，不应拥有 root。
RUN useradd --system --create-home --home-dir /home/signal40 --shell /usr/sbin/nologin signal40 \
  && chown -R signal40:signal40 /app /home/signal40
USER signal40
ENV HOME=/home/signal40
CMD ["npm", "run", "worker"]
