---
name: node-dev-host
description: "Run, configure and operate the node-dev-host Docker image (ghcr.io/newbe36524/node-dev-host). It builds a mounted source tree into dist and serves it with Caddy inside one long-lived container, rebuilding on every change. Use when the user wants to preview or serve a Node, TypeScript, Vite or pnpm project in Docker without restarting the container, choose the host or demo variant, set BUILD_CMD, INSTALL_CMD, DIST_DIR, HTTP_PORT, SPA or API_UPSTREAM, proxy an API path, read build status, force a rebuild, or fix a container that serves stale or missing files. Keywords: node-dev-host, dev-host, live rebuild, 容器内构建, 本地预览, Caddy, dist, 热重载."
---

# node-dev-host

A Docker image that keeps **source → `dist`** inside one container. `dev-host` (PID 1 via `tini`) runs Caddy to serve the output and a build loop that rebuilds it when the source changes. The container is long-lived: edit files on the host, and the container rebuilds without a restart.

Inside the image: Node 24, `pnpm`, `typescript` (`tsc`), `tsx`, `git`, `curl`, and Caddy.

## Pick a variant

| Image tag | Use when |
| --- | --- |
| `ghcr.io/newbe36524/node-dev-host:latest` | The user has their own project. Mount it. |
| `ghcr.io/newbe36524/node-dev-host:demo` | The user wants to see the image work with no project. Nothing to mount. |

Use an exact version tag (`1.2.3` or `1.2.3-demo`) when the user needs a pinned image. Both variants run `linux/amd64` and `linux/arm64`.

## Run it

Mount the project so that its `package.json` is at the root of `/workspace`:

```sh
docker run -d --name <name> \
  -p <host-port>:<HTTP_PORT> \
  -v "<absolute-path-to-project>":/workspace \
  [-e VAR=value ...] \
  ghcr.io/newbe36524/node-dev-host:latest
```

Rules:

- Use an absolute host path (or `"$PWD"` from the project directory). Do not use a relative path.
- The `-p` host-side port is free to choose. The container-side port must equal `HTTP_PORT` (default `8080`). If `HTTP_PORT` is changed, change the container side of `-p` too.
- Without a `package.json` in `/workspace`, the container stays in state `waiting` until source is mounted or copied in.
- Keep the container running. Use `--restart unless-stopped` if it should survive a reboot. If Caddy or the build loop dies, the container exits on purpose so that the restart policy can bring it back.
- Pass configuration with `-e`, for example `-e BUILD_CMD="pnpm build:prod" -e DIST_DIR=build`.
- Use `--user "$(id -u):$(id -g)" -e HOME=/tmp` on Linux if the user does not want root-owned `node_modules` and `dist` in the project folder. The container runs as root by default.

## What happens at start

1. `dev-host` writes the Caddyfile (or copies `CADDYFILE`) and writes `status.json` with state `starting`.
2. Caddy starts on `HTTP_PORT` and serves `/workspace/$DIST_DIR`.
3. The build loop runs install (when needed), then the build. This is the initial build.
4. Every `POLL_INTERVAL` seconds it hashes the source tree. When the hash changes and stays stable for one more interval, it rebuilds.

Polling is deliberate: file-watch events are unreliable across Docker bind mounts on macOS and Windows.

## Operate it

```sh
docker exec <name> dev-host status        # last build state as JSON
docker exec <name> dev-host rebuild       # queue a rebuild; picked up within POLL_INTERVAL seconds
docker logs <name>                        # build output, prefixed with [dev-host HH:MM:SS]
curl http://localhost:<host-port>/__dev-host/status.json
```

`status.json` example: `{"state":"ok","builds":3,"failures":0,"lastExitCode":0,"finishedAt":"2026-11-11T08:00:00Z"}`. While a build runs, it also carries `"reason"`.

| `state` | Meaning | What to do |
| --- | --- | --- |
| `starting` | Container just started. | Wait a few seconds. |
| `building` | Install or build is running. | Wait, or read `docker logs`. |
| `ok` | Last build succeeded; `dist` is current. | Nothing. |
| `failed` | Last build failed. The previous `dist` is still served. | Read `docker logs`, fix the source or the build command, and save the file or run `rebuild`. |
| `waiting` | No `package.json` in `/workspace`. | Mount or copy the project. |

The container health check requests `status.json` on `HTTP_PORT`. A container that stays unhealthy while running usually has an `HTTP_PORT` that does not match the port Caddy serves, or a custom Caddyfile that listens elsewhere.

## Configuration

All variables are optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUILD_CMD` | `pnpm build` | Command that writes the output folder. Runs in `/workspace`. |
| `INSTALL_CMD` | auto | Default: `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` exists, otherwise `pnpm install`. |
| `DIST_DIR` | `dist` | Output folder, relative to `/workspace`. Must match what `BUILD_CMD` writes. |
| `HTTP_PORT` | `8080` | Port Caddy listens on inside the container. |
| `SPA` | `true` | Serve `index.html` for unknown paths. Set `false` for a multi-page site. |
| `API_UPSTREAM` | empty | For example `host.docker.internal:3000`. Enables the reverse proxy. Add `--add-host=host.docker.internal:host-gateway` on Linux. |
| `API_PATH` | `/api/*` | Path matcher forwarded to `API_UPSTREAM`. |
| `POLL_INTERVAL` | `2` | Seconds between source checks. |
| `CADDYFILE` | unset | Path inside the container to a custom Caddyfile, copied over the generated one. `API_UPSTREAM`, `API_PATH` and `SPA` then have no effect. `HTTP_PORT` still drives the health check, so keep it matching the custom file's listen port. Mount the file with `-v`. |
| `WORKSPACE` | `/workspace` | Source root inside the container. Change only if the mount point changes. |

Rebuilds are triggered by changes to any source file, except paths under `node_modules`, `.git`, `dist` (or `DIST_DIR`), `.vite`, `.turbo`, `.cache`, `coverage` and `.pnpm-store`.

Dependencies are reinstalled when `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` or `.pnpmfile.cjs` changes.

## Gotchas

- **Root-owned output.** Without `--user`, files created in the bind mount (`node_modules`, `dist`) belong to root on Linux hosts. Fix ownership with the `--user` flag or with `sudo chown`.
- **Build-generated files do not retrigger.** Files written by the build inside the source tree (for example `tsconfig.tsbuildinfo`) do not start another build. An edit saved during a build is picked up on the next change, or with `dev-host rebuild`.
- **Demo image installs once at start.** The demo image already has dependencies, but the first build after start still runs the install command once, against the lockfile.
- **A failed first build leaves nothing to serve.** If no build has ever succeeded, `dist` is missing or empty, so requests return 404 until a build works.
- **Ports.** A changed `HTTP_PORT` must be matched in `-p`, and it is also used by the health check.
- **Not a production server.** The image is for development previews and local work. Deploy the built `dist` with the project's own hosting.

## Build the image locally

```sh
docker build -t node-dev-host:latest .               # host
docker build --target demo -t node-dev-host:demo .   # demo
```

Build args: `NODE_VERSION` (24), `CADDY_VERSION` (2), `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## Files in this repo

- `Dockerfile`: `base` (shared), `demo`, and `host` targets. `host` stays last so a bare `docker build .` produces it.
- `rootfs/usr/local/bin/dev-host`: the entrypoint script with `run`, `rebuild`, and `status` commands.
- `demo/`: the demo project copied into the `demo` image.
- `.github/workflows/publish.yml`: publishes both variants on push to `main`, on `v*` tags, weekly, and on manual dispatch.
