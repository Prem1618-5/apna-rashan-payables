# syntax=docker/dockerfile:1.7
#
# One image: API (services/api) + built PWA (apps/web) + in-process worker.
# Builds for linux/arm64 (Fargate Graviton) and linux/amd64:
#   docker buildx build --platform linux/arm64 -t arad:dev .
#
# Stages
#   manifests  only package.json files + lockfile, so dependency install is
#              cached until a manifest or the lockfile changes
#   build      install all deps, build web + api, `pnpm deploy` the api with
#              production deps only
#   runtime    slim Node, non-root, tini as PID 1

ARG NODE_VERSION=22.22.0

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src

# ---------------------------------------------------------------------------
FROM base AS manifests
COPY . /tmp/ctx
# Keep the directory layout, keep only what `pnpm install` needs.
RUN cd /tmp/ctx \
 && find . -name node_modules -prune -o \
      \( -name package.json -o -name pnpm-lock.yaml -o -name pnpm-workspace.yaml -o -name .npmrc \) \
      -type f -print \
    | while read -r f; do mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; done

# ---------------------------------------------------------------------------
FROM base AS build
# Toolchain only for packages that must compile native code (build stage only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY --from=manifests /manifests/ ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @arad/web build \
 && pnpm --filter @arad/api build

# Self-contained api folder with production dependencies only.
# --legacy: works without inject-workspace-packages in pnpm-workspace.yaml.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @arad/api deploy --prod --legacy /out/api \
 # Make sure build output and any non-JS assets (e.g. SQL migrations) are
 # there even if the package's "files"/ignore rules leave them out.
 && tar -C services/api --exclude=./node_modules -cf - . | tar -C /out/api -xf - \
 && test -f /out/api/dist/server.js \
 && cp -r apps/web/dist /out/web

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Amazon RDS CA bundle, so DB TLS can be verified (sslmode=verify-full).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST=/app/web \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

WORKDIR /app
COPY --from=build --chown=root:root /out/api ./
COPY --from=build --chown=root:root /out/web ./web
COPY --chmod=755 infra/docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# App files are root-owned and read-only for the app user.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node and reaps zombies.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
