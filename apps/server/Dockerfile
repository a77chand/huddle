# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --omit=dev --workspace @huddle/server --include-workspace-root=false
COPY packages/core/src packages/core/src
COPY apps/server/src apps/server/src
ENV DATABASE_PATH=/data/huddle.db PORT=8787
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "apps/server/src/main.ts"]
