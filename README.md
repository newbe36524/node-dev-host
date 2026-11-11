# node-dev-host

A public Docker image that keeps **source → `dist`** inside one long-lived container, so you do not have to restart a local dev container for every change. Caddy serves the result.

Inside the image: Node 24, `pnpm`, `typescript` (`tsc`), `tsx`, `git`, and Caddy as the web server / reverse proxy.

## Two variants, one image name

Image: `ghcr.io/newbe36524/node-dev-host`

| Tag | What it is |
| --- | --- |
| `latest` | Plain host. Mount your own source at `/workspace`. |
| `demo` | Same host plus a small Vite + TypeScript project already in `/workspace`, built and served on start. |

Versioned tags: a git tag `v1.2.3` also publishes `1.2.3` and `1.2.3-demo`. Both variants are `linux/amd64` and `linux/arm64`.

## Quick start

Try the demo (nothing to mount):

```sh
docker run --rm -p 8080:8080 ghcr.io/newbe36524/node-dev-host:demo
# open http://localhost:8080
```

Use it on your own project:

```sh
docker run -d --name my-site -p 8080:8080 \
  -v "$PWD":/workspace \
  ghcr.io/newbe36524/node-dev-host:latest
```

The container installs dependencies, runs the build, and serves `/workspace/dist`. It then polls the source tree and rebuilds when files change. The demo source lives in [`demo/`](demo) if you want a template to start from.

## How it works

`dev-host` (PID 1 via `tini`) starts two things:

1. **Caddy** on `HTTP_PORT`, serving `/workspace/$DIST_DIR`. It falls back to `index.html` for SPA routes and, if you set `API_UPSTREAM`, reverse-proxies `API_PATH` to it.
2. **A build loop.** On start it runs install + build. After that it hashes the source files every `POLL_INTERVAL` seconds (ignoring `node_modules`, `.git`, `dist` and common caches), waits for the change to settle, and rebuilds. If a build fails, the previous `dist` keeps being served and the failure is logged.

Polling is used on purpose: file-watch events do not cross Docker bind mounts reliably on macOS and Windows.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUILD_CMD` | `pnpm build` | Command that produces `dist`. |
| `INSTALL_CMD` | auto | Default is `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` exists, else `pnpm install`. It re-runs when a `package.json`, lockfile, `pnpm-workspace.yaml` or `.npmrc` changes. |
| `DIST_DIR` | `dist` | Build output, relative to `/workspace`. |
| `HTTP_PORT` | `8080` | Port Caddy listens on. |
| `SPA` | `true` | Serve `index.html` for unknown paths. |
| `API_UPSTREAM` | empty | e.g. `host.docker.internal:3000`. Enables the reverse proxy. |
| `API_PATH` | `/api/*` | Path matcher sent to `API_UPSTREAM`. |
| `POLL_INTERVAL` | `2` | Seconds between source checks. |
| `CADDYFILE` | unset | Path to your own Caddyfile (inside the container). Replaces the generated one. |

## Operating it

```sh
docker exec my-site dev-host status    # last build as JSON
docker exec my-site dev-host rebuild   # rebuild now
curl localhost:8080/__dev-host/status.json
```

Status looks like `{"state":"ok","builds":3,"failures":0,"lastExitCode":0,"finishedAt":"..."}`. `state` is one of `starting`, `building`, `ok`, `failed`, `waiting` (no `package.json` yet). The container health check reads the same endpoint.

## Notes

- The container runs as root, so `node_modules` and `dist` created in a bind-mounted folder are owned by root on Linux hosts. Pass `--user "$(id -u):$(id -g)" -e HOME=/tmp` to avoid that.
- Files that a build writes into the source tree (for example `tsconfig.tsbuildinfo`) do not retrigger a build. An edit saved *during* a build is picked up on the next change, or with `dev-host rebuild`.
- Changing `package.json` dependencies works through the mount. In the `demo` image, dependencies are already installed in the image layer.

## Building locally

```sh
docker build -t node-dev-host:latest .                 # plain
docker build --target demo -t node-dev-host:demo .     # demo
```

Build args: `NODE_VERSION`, `CADDY_VERSION`, `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## License

MIT
