# syntax=docker/dockerfile:1
ARG NODE_VERSION=24
ARG CADDY_VERSION=2

FROM caddy:${CADDY_VERSION}-alpine AS caddy

# ---- base: everything shared by both published variants ----
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
 && apt-get install -y --no-install-recommends ca-certificates git tini curl \
 && rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/ldconfig \
           /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian /usr/share/bug

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@${PNPM_VERSION}" "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}" \
 && rm -rf /tmp/* /root/.cache \
 && mkdir -p /var/lib/dev-host /workspace \
 && chmod 1777 /var/lib/dev-host

COPY rootfs/ /
ENV WORKSPACE=/workspace \
    PNPM_HOME=/pnpm-store-home \
    CI=true
WORKDIR /workspace
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:${HTTP_PORT:-8080}/__dev-host/status.json >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "dev-host"]
CMD ["run"]

# ---- demo: same image plus a ready-to-run source tree in /workspace ----
FROM base AS demo
COPY demo/ /workspace/
RUN --mount=type=cache,target=/root/.cache \
    pnpm install --frozen-lockfile && pnpm build \
 && rm -rf /tmp/*

# ---- alpine base: the same tools on Alpine (musl libc, smaller). Tags: alpine, demo-alpine ----
FROM node:${NODE_VERSION}-alpine AS base-alpine
LABEL org.opencontainers.image.source="https://github.com/newbe36524/node-dev-host" \
      org.opencontainers.image.description="Node dev host (Alpine): Caddy + pnpm + TypeScript, builds mounted source to dist in one container" \
      org.opencontainers.image.licenses="MIT"
ARG PNPM_VERSION=12.18.0
ARG TYPESCRIPT_VERSION=7.0.2
ARG TSX_VERSION=4.23.15

# bash, findutils and coreutils: dev-host needs bash and GNU `find -printf` (busybox has neither).
RUN apk add --no-cache ca-certificates git tini curl bash findutils coreutils

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@${PNPM_VERSION}" "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}" \
 && rm -rf /tmp/* /root/.cache \
 && mkdir -p /var/lib/dev-host /workspace \
 && chmod 1777 /var/lib/dev-host

COPY rootfs/ /
ENV WORKSPACE=/workspace \
    PNPM_HOME=/pnpm-store-home \
    CI=true
WORKDIR /workspace
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:${HTTP_PORT:-8080}/__dev-host/status.json >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "dev-host"]
CMD ["run"]

# ---- demo-alpine: alpine base plus the demo project, built in the image ----
FROM base-alpine AS demo-alpine
COPY demo/ /workspace/
RUN --mount=type=cache,target=/root/.cache \
    pnpm install --frozen-lockfile && pnpm build \
 && rm -rf /tmp/*

# ---- host-alpine: the plain alpine variant ----
FROM base-alpine AS host-alpine

# ---- host: the plain variant. Keep it LAST so a bare `docker build .` produces it. ----
FROM base AS host
