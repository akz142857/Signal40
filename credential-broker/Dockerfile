FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV SIGNAL40_DEPLOYMENT_MODE=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY scripts/credential-broker.ts ./scripts/credential-broker.ts
COPY lib ./lib
RUN useradd --system --create-home --home-dir /home/signal40 --shell /usr/sbin/nologin signal40 \
  && chown -R signal40:signal40 /app /home/signal40
USER signal40
ENV HOME=/home/signal40
EXPOSE 3002
CMD ["node", "--experimental-strip-types", "scripts/credential-broker.ts"]
