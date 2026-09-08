FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
ENV NODE_ENV=production
CMD ["npm", "run", "worker"]
