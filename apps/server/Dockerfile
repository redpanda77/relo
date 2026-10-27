FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS pnpm
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
COPY packages/owner-crypto/package.json ./packages/owner-crypto/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @relo/server...

COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/dashboard ./apps/dashboard
COPY packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/fixtures ./packages/contracts/fixtures
COPY packages/owner-crypto/tsconfig.json ./packages/owner-crypto/tsconfig.json
COPY packages/owner-crypto/src ./packages/owner-crypto/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/migrations ./apps/server/migrations
COPY apps/server/fixtures ./apps/server/fixtures
# Relo for Mac, when the deploy put it here (apps/server/mac/README.md); else only its README.
COPY apps/server/mac ./apps/server/mac
# Relo for Windows, likewise (apps/server/windows/README.md).
COPY apps/server/windows ./apps/server/windows
RUN pnpm --filter @relo/server build
# Add a computer (docs/site/guides/servers.md): the CLI this server hands out, packed with its skill. It has no
# dependencies, so the install script only unpacks it; the manifest names its version and digest.
COPY packages/cli ./packages/cli
COPY skills/relo-notifications ./skills/relo-notifications
RUN node packages/cli/scripts/bundle-skill.mjs \
  && mkdir -p apps/server/cli \
  && cd packages/cli && npm pack --ignore-scripts --silent --pack-destination /workspace/apps/server/cli >/dev/null \
  && cd /workspace/apps/server/cli && mv relo-cli-*.tgz relo-cli.tgz \
  && node -e 'const fs=require("fs"),c=require("crypto");const v=require("/workspace/packages/cli/package.json").version;fs.writeFileSync("manifest.json",JSON.stringify({version:v,sha256:c.createHash("sha256").update(fs.readFileSync("relo-cli.tgz")).digest("hex")}))'
WORKDIR /workspace/apps/server

FROM pnpm AS production-deps
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/owner-crypto/package.json ./packages/owner-crypto/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  --filter @relo/server --filter @relo/notification-contracts
COPY --from=build /workspace/apps/server/dist ./apps/server/dist
COPY --from=build /workspace/apps/server/fixtures ./apps/server/fixtures
COPY --from=build /workspace/apps/server/migrations ./apps/server/migrations
COPY --from=build /workspace/apps/server/cli ./apps/server/cli
COPY --from=build /workspace/apps/server/mac ./apps/server/mac
COPY --from=build /workspace/apps/server/windows ./apps/server/windows
COPY --from=build /workspace/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/apps/server
RUN groupadd --system --gid 10001 relo \
  && useradd --system --uid 10001 --gid relo --home-dir /nonexistent relo
COPY --from=production-deps --chown=relo:relo /workspace /workspace
USER relo
EXPOSE 8180
CMD ["node", "dist/index.js"]
