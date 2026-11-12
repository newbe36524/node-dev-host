# syntax=docker/dockerfile:1
ARG NODE_VERSION=24
ARG CADDY_VERSION=2
ARG PNPM_VERSION=12.18.0

FROM caddy:${CADDY_VERSION}-alpine AS caddy

# ---- control-ui: the control dashboard (React, Vite), built once into static files ----
# Pinned to $BUILDPLATFORM: the toolchain runs natively on the builder, not under QEMU once per target.
# Its output is plain HTML, JS and CSS, so the same dist is copied into every architecture and both bases.
# Only /app/dist is copied out. No node_modules, source or build tool reaches a published layer.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS control-ui
ARG PNPM_VERSION
ENV PNPM_CONFIG_STORE_DIR=/pnpm-store
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@${PNPM_VERSION}"
COPY control-ui/ ./
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --frozen-lockfile \
 && pnpm build

# ---- base: everything shared by all published variants ----
FROM node:${NODE_VERSION}-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/newbe36524/node-dev-host" \
      org.opencontainers.image.description="Node dev host: Caddy + pnpm + TypeScript, builds mounted source to dist in one container" \
      org.opencontainers.image.licenses="MIT"
ARG PNPM_VERSION=12.18.0
ARG TYPESCRIPT_VERSION=7.0.2
ARG TSX_VERSION=4.23.15

# Image layers are additive: a file deleted in a later RUN still takes space in the
# earlier layer. So each RUN removes what it created, and caches live in build-time
# cache mounts that never enter a layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini curl rsync \
 && rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/ldconfig \
           /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian /usr/share/bug

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@${PNPM_VERSION}" "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}" \
 && rm -rf /tmp/* /root/.cache \
 && mkdir -p /var/lib/dev-host /workspace \
 && chmod 1777 /var/lib/dev-host

COPY rootfs/ /
# The built control dashboard, served by `dev-host control` (rootfs/usr/local/lib/dev-host/control/server.mjs).
COPY --from=control-ui /app/dist /usr/local/lib/dev-host/control/ui
ENV WORKSPACE=/workspace \
    PNPM_HOME=/var/lib/dev-host/pnpm \
    PNPM_CONFIG_STORE_DIR=/var/lib/dev-host/pnpm/store \
    CI=true
WORKDIR /workspace
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:${HTTP_PORT:-8080}/__dev-host/status.json >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "dev-host"]
CMD ["run"]

# ---- demo: same image plus a ready-to-run source tree in /workspace ----
# Dependencies are installed when the container starts, in the build copy (see dev-host), not here.
FROM base AS demo
COPY demo/ /workspace/

# ---- alpine base: the same tools on Alpine (musl libc, smaller). Tags: alpine, demo-alpine ----
FROM node:${NODE_VERSION}-alpine AS base-alpine
LABEL org.opencontainers.image.source="https://github.com/newbe36524/node-dev-host" \
      org.opencontainers.image.description="Node dev host (Alpine): Caddy + pnpm + TypeScript, builds mounted source to dist in one container" \
      org.opencontainers.image.licenses="MIT"
ARG PNPM_VERSION=12.18.0
ARG TYPESCRIPT_VERSION=7.0.2
ARG TSX_VERSION=4.23.15

# bash, findutils and coreutils: dev-host needs bash and GNU `find -printf` (busybox has neither).
RUN apk add --no-cache ca-certificates git tini curl rsync bash findutils coreutils

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@${PNPM_VERSION}" "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}" \
 && rm -rf /tmp/* /root/.cache \
 && mkdir -p /var/lib/dev-host /workspace \
 && chmod 1777 /var/lib/dev-host

COPY rootfs/ /
# The built control dashboard, served by `dev-host control` (rootfs/usr/local/lib/dev-host/control/server.mjs).
COPY --from=control-ui /app/dist /usr/local/lib/dev-host/control/ui
ENV WORKSPACE=/workspace \
    PNPM_HOME=/var/lib/dev-host/pnpm \
    PNPM_CONFIG_STORE_DIR=/var/lib/dev-host/pnpm/store \
    CI=true
WORKDIR /workspace
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:${HTTP_PORT:-8080}/__dev-host/status.json >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "dev-host"]
CMD ["run"]

# ---- demo-alpine: alpine base plus the demo project in /workspace ----
FROM base-alpine AS demo-alpine
COPY demo/ /workspace/

# ---- host-alpine: the plain alpine variant ----
FROM base-alpine AS host-alpine

# ---- host: the plain variant. Keep it LAST so a bare `docker build .` produces it. ----
FROM base AS host
