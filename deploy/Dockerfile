FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/media-service/package.json apps/media-service/package.json
COPY apps/executor/package.json apps/executor/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/rendering/package.json packages/rendering/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Default target: web app, API and worker.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
RUN mkdir -p /data/assets && chown -R node:node /data
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.mjs"]

# Optional: FFmpeg media service for video synthesis and clipping.
FROM node:24-bookworm-slim AS media
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk fontconfig && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 MEDIA_PORT=4100 MEDIA_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/media-service/dist ./apps/media-service/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4100
CMD ["node", "apps/media-service/dist/main.mjs"]

# Optional: browser execution node. Run it on a machine you trust; it holds platform login sessions.
FROM node:24-bookworm-slim AS executor
ENV NODE_ENV=production EXECUTOR_DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/executor/dist ./apps/executor/dist
RUN node node_modules/playwright-core/cli.js install --with-deps chromium && mkdir -p /data && chown -R node:node /data /ms-playwright && chmod 700 /data
USER node
CMD ["node", "apps/executor/dist/main.mjs"]
