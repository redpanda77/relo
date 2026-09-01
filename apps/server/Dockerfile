FROM node:22-bookworm-slim AS pnpm
ARG PNPM_VERSION=11.20.0
RUN npm install --global "pnpm@${PNPM_VERSION}"

FROM pnpm AS build
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @relo/server...

COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/dashboard ./apps/dashboard
COPY packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/fixtures ./packages/contracts/fixtures
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/migrations ./apps/server/migrations
COPY apps/server/fixtures ./apps/server/fixtures
RUN pnpm --filter @relo/server build
WORKDIR /workspace/apps/server

FROM pnpm AS production-deps
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  --filter @relo/server --filter @relo/notification-contracts
COPY --from=build /workspace/apps/server/dist ./apps/server/dist
COPY --from=build /workspace/apps/server/fixtures ./apps/server/fixtures
COPY --from=build /workspace/apps/server/migrations ./apps/server/migrations
COPY --from=build /workspace/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/apps/server
RUN groupadd --system --gid 10001 relo \
  && useradd --system --uid 10001 --gid relo --home-dir /nonexistent relo
COPY --from=production-deps --chown=relo:relo /workspace /workspace
USER relo
EXPOSE 8180
CMD ["node", "dist/index.js"]
