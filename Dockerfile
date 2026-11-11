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

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN npm install -g "pnpm@${PNPM_VERSION}" "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}" \
 && npm cache clean --force \
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
RUN pnpm install --frozen-lockfile && pnpm build

# ---- host: the plain variant. Keep it LAST so a bare `docker build .` produces it. ----
FROM base AS host
