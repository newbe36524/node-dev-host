# node-dev-host

A Docker image that builds your mounted source into `dist` and serves it with Caddy, all inside one long-lived container. Edit files on the host; the container rebuilds by itself, so you never restart it for a change. The project is mounted read-only: the container copies it and builds the copy, so nothing is written into your project folder.

Image: `ghcr.io/newbe36524/node-dev-host` (`linux/amd64`, `linux/arm64`)

## Variants

| Tag | What it is |
| --- | --- |
| `latest` | Plain host. Mount your project at `/workspace`. |
| `demo` | Same host plus a small Vite + TypeScript project. It installs and builds on first start. |
| `alpine` | Plain host on Alpine (musl libc). About 28% smaller uncompressed. |
| `demo-alpine` | The demo on Alpine. |

Use the Alpine tags if your project has no glibc-only native dependencies; the Debian tags are the default.

A git tag `v1.2.3` also publishes `1.2.3`, `1.2.3-demo`, `1.2.3-alpine` and `1.2.3-demo-alpine`.

## Features

- Copies your mounted source into a private build directory, installs dependencies and runs your build command there, then serves the output. The project folder is never written to, so `node_modules` and `dist` do not appear in it.
- Polls the source tree and rebuilds once the changes settle. A burst of saves makes one build; `DEBOUNCE_SECONDS`, `MIN_BUILD_INTERVAL` and `MAX_WAIT_SECONDS` tune it.
- Keeps serving the last good build when a new build fails.
- Serves `index.html` for unknown paths (SPA mode) and can proxy an API path to another port.
- Reports build state as JSON at `/__dev-host/status.json` and `dev-host status`, and lets you trigger a rebuild with `dev-host rebuild`.
- Adds `X-Build-Time` (UTC, when the served build finished) and `X-Build-Duration` (seconds) response headers, so a client can tell how fresh `dist` is.
- Prunes unused pnpm packages after each dependency install, so the store does not grow without bound.
- Configured with environment variables.

## Quick start

```sh
docker run --rm -p 8080:8080 ghcr.io/newbe36524/node-dev-host:demo
# open http://localhost:8080

docker run -d --name my-site -p 8080:8080 \
  -v "$PWD":/workspace:ro \
  -v node-dev-host-pnpm:/var/lib/dev-host/pnpm \
  ghcr.io/newbe36524/node-dev-host:latest
```

## Share the package cache

The `-v` line above keeps the pnpm store in a named volume, so a new container reuses the packages that are already downloaded. In a test, a second container reused 17 of its 18 packages and downloaded only the one new package. The image sets `PNPM_CONFIG_STORE_DIR` for this. If you override it, keep the store inside the volume, or pnpm ignores the volume and the cache is not shared.

- **Host directory instead of a volume:** add `--user "$(id -u):$(id -g)" -e HOME=/tmp` and mount `"$HOME/.cache/node-dev-host/pnpm"` at `/var/lib/dev-host/pnpm`. A named volume is root-owned and does not work with `--user`.
- **npm projects:** mount a volume at `/var/lib/dev-host/npm-cache` and set `-e npm_config_cache=/var/lib/dev-host/npm-cache`.
- **Several containers at once** can share one volume. Removing containers does not remove the volume; `docker volume rm node-dev-host-pnpm` resets it.

The skill has the details and the trade-offs: [`skills/node-dev-host/SKILL.md`](skills/node-dev-host/SKILL.md#share-the-package-cache).

## Use it with an AI agent

This repo ships an agent skill at [`skills/node-dev-host/SKILL.md`](skills/node-dev-host/SKILL.md). It explains how to run, configure, and operate the image: choosing a variant, mounting a project, setting environment variables, reading build status, forcing a rebuild, and fixing common problems.

Install it with your agent's skill installer, for example:

```sh
npx skills add newbe36524/node-dev-host
```

Or copy `skills/node-dev-host/` into your agent's skills directory.

Example requests once the skill is installed:

- "Serve my Vite project in `~/code/app` with node-dev-host on port 8080."
- "Proxy `/api` to `localhost:3000` in the node-dev-host container."
- "Check whether the node-dev-host build failed, and show the log."
- "Force a rebuild in `my-site`."

The demo project is in [`demo/`](demo) if you want a template.

## Building locally

```sh
docker build -t node-dev-host:latest .               # host
docker build --target demo -t node-dev-host:demo .   # demo
docker build --target host-alpine -t node-dev-host:alpine .        # alpine host
docker build --target demo-alpine -t node-dev-host:demo-alpine .   # alpine demo
```

The image is kept small on purpose: each build step removes what it creates, and package caches are BuildKit cache mounts that never reach a layer. The published tags use zstd layers (about 24% smaller to pull than gzip), which needs a Docker client that can read zstd.

Build args: `NODE_VERSION`, `CADDY_VERSION`, `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## Integration tests

`tests/integration/run.sh <image> <target>` runs real containers against a built image and checks what they build and serve: the read-only workspace, rebuilds on edit, failed builds, the `/api` proxy, a custom `CADDYFILE` and the shared pnpm store volume. It needs Docker and curl.

```sh
docker build --target host -t node-dev-host:test-host .
tests/integration/run.sh node-dev-host:test-host host
```

The `integration` workflow runs the same script for all four variants on pull requests that change the image, the demo or the tests.

## License

MIT
