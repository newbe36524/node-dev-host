---
name: node-dev-host
description: "Run, configure and operate the node-dev-host Docker image (ghcr.io/newbe36524/node-dev-host). It copies a mounted source tree into a private build directory, builds it there, and serves the output with Caddy inside one long-lived container, rebuilding on every change without writing to the mounted project. Use when the user wants to preview or serve a Node, TypeScript, Vite or pnpm project in Docker without restarting the container, choose the host or demo variant, set BUILD_CMD, INSTALL_CMD, DIST_DIR, HTTP_PORT, SPA or API_UPSTREAM, proxy an API path, read build status, force a rebuild, or fix a container that serves stale or missing files. Keywords: node-dev-host, dev-host, live rebuild, 容器内构建, 本地预览, Caddy, dist, 热重载."
---

# node-dev-host

A Docker image that builds **source → `dist`** inside one container. `dev-host` (PID 1 via `tini`) runs Caddy to serve the output and a build loop that rebuilds it when the source changes. The container is long-lived: edit files on the host, and the container rebuilds without a restart. The mounted project is read-only input: install and build run in a private copy inside the container, so nothing is written into the project folder.

Inside the image: Node 24, `pnpm`, `typescript` (`tsc`), `tsx`, `git`, `curl`, and Caddy.

## Pick a variant

| Image tag | Use when |
| --- | --- |
| `ghcr.io/newbe36524/node-dev-host:latest` | The user has their own project. Mount it. |
| `ghcr.io/newbe36524/node-dev-host:demo` | The user wants to see the image work with no project. Nothing to mount. |
| `ghcr.io/newbe36524/node-dev-host:alpine` | The user has their own project and wants a smaller image. Alpine (musl). Use only if the project has no glibc-only native dependencies. |
| `ghcr.io/newbe36524/node-dev-host:demo-alpine` | The demo on Alpine. |

Use an exact version tag (`1.2.3`, `1.2.3-demo`, `1.2.3-alpine` or `1.2.3-demo-alpine`) when the user needs a pinned image. All variants run `linux/amd64` and `linux/arm64`. The Debian tags are the default; choose Alpine only on request or when the image size matters.

## Run it

Mount the project so that its `package.json` is at the root of `/workspace`:

```sh
docker run -d --name <name> \
  -p <host-port>:<HTTP_PORT> \
  -v "<absolute-path-to-project>":/workspace:ro \
  -v node-dev-host-pnpm:/var/lib/dev-host/pnpm \
  [-e VAR=value ...] \
  ghcr.io/newbe36524/node-dev-host:latest
```

The cache volume (the shared pnpm store) is part of the default command. See [Share the package cache](#share-the-package-cache).

Rules:

- Use an absolute host path (or `"$PWD"` from the project directory). Do not use a relative path.
- The `-p` host-side port is free to choose. The container-side port must equal `HTTP_PORT` (default `8080`). If `HTTP_PORT` is changed, change the container side of `-p` too.
- Mount the project read-only (`:ro`). The container copies it and never writes to it; install and build run in the copy.
- Without a `package.json` in `/workspace`, the container stays in state `waiting`. Mount the project when the container is created. A running container cannot gain a mount, so recreate it instead.
- Keep the container running. Use `--restart unless-stopped` if it should survive a reboot. If Caddy or the build loop dies, the container exits on purpose so that the restart policy can bring it back.
- Pass configuration with `-e`, for example `-e BUILD_CMD="pnpm build:prod" -e DIST_DIR=build`.
- Nothing is written into the project folder, so files there keep their host owner and no `--user` flag is needed. The container runs as root by default; `--user "$(id -u):$(id -g)" -e HOME=/tmp` also works.

## Share the package cache

A new container starts with an empty package cache, so it downloads every dependency again. Share the cache by default, as the run command above does. One cache can serve several containers at once, and several projects.

**pnpm (default).** The run command mounts the named volume `node-dev-host-pnpm` at `/var/lib/dev-host/pnpm`. The image sets `PNPM_CONFIG_STORE_DIR=/var/lib/dev-host/pnpm/store`, so pnpm keeps its store inside the volume. If you override that variable, keep the store inside the volume. Without it, pnpm sees that the volume is on a different device from the build copy and puts its store at `/.pnpm-store` inside the container. The volume then stays empty, nothing is shared, and the status still reads `ok`.

- The named volume is owned by root, so it works only with the default root user. With `--user`, pnpm logs `Permission denied` for each write, skips caching, and the status still reads `ok`. For a non-root container, mount a host directory instead:

  ```sh
  mkdir -p "$HOME/.cache/node-dev-host/pnpm"
  docker run -d --name <name> -p <host-port>:<HTTP_PORT> \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "<absolute-path-to-project>":/workspace:ro \
    -v "$HOME/.cache/node-dev-host/pnpm":/var/lib/dev-host/pnpm \
    ghcr.io/newbe36524/node-dev-host:latest
  ```

- Use the host directory when the user wants to see or delete the cache from the host.
- The store is on another device from the build copy, so pnpm copies packages into `node_modules` instead of hard-linking them. Each container's build copy therefore takes more container disk.

**npm (when `INSTALL_CMD` uses npm).** npm reads `/root/.npm`. That path is not mounted by default, and pnpm never reads it. Share it with:

```sh
-v node-dev-host-npm:/var/lib/dev-host/npm-cache \
-e npm_config_cache=/var/lib/dev-host/npm-cache
```

In a test, the second container's `npm install` took 1 s, against 15 s for the first.

**What sharing changes:**

- Two containers started at the same time on one volume both reached `ok`, with no store errors.
- After each successful install the loop runs `pnpm store prune`. That also removes packages that only another container's project uses, so that container downloads them again on its next install. In the test, one package was downloaded again.
- Containers do not remove the volume. To reset the cache, stop the containers that use it, then run `docker volume rm node-dev-host-pnpm`. To check its size, run `docker exec <name> du -sh /var/lib/dev-host/pnpm/store`.

## What happens at start

1. `dev-host` writes the Caddyfile (or copies `CADDYFILE`) and writes `status.json` with state `starting`.
2. Caddy starts on `HTTP_PORT` and serves `/var/lib/dev-host/www`, which is empty until the first successful build.
3. The build loop copies `/workspace` to `/var/lib/dev-host/build`, runs install there (when needed), runs the build there, and then copies `$DIST_DIR` to `www`. This is the initial build. If any step fails, `www` keeps the previous output.
4. Every `POLL_INTERVAL` seconds it hashes the source tree. A change starts a build only after the tree has been quiet for `DEBOUNCE_SECONDS`. Builds are at least `MIN_BUILD_INTERVAL` seconds apart, and a change that never settles still builds after `MAX_WAIT_SECONDS`. A burst of saves therefore gives one build, not one per save. An edit saved during a build starts another build after it.

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
| `ok` | Last build succeeded; the served output is current. | Nothing. |
| `failed` | Last build, install or copy failed. The previous output in `www` is still served. | Read `docker logs`, fix the source or the build command, and save the file or run `rebuild`. For a failed install, see Gotchas. |
| `waiting` | No `package.json` in `/workspace`. | Recreate the container with the project mounted. |

The container health check requests `status.json` on `HTTP_PORT`. A container that stays unhealthy while running usually has an `HTTP_PORT` that does not match the port Caddy serves, or a custom Caddyfile that listens elsewhere.

Responses for `dist` carry the build that produced them:

- `X-Build-Time`: UTC time the last successful build finished, for example `2026-11-11T08:00:00Z`.
- `X-Build-Duration`: seconds that build took, including the install when one ran.

Both are blank until this container completes a build. A failed build leaves them unchanged, because the served `dist` is still the earlier one. A custom `CADDYFILE` does not get these headers unless it adds them itself with `header X-Build-Time "{file./var/lib/dev-host/build-time}"`.

## Configuration

All variables are optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUILD_CMD` | `pnpm build` | Command that writes the output folder. Runs in `/var/lib/dev-host/build`, a copy of `/workspace`. |
| `INSTALL_CMD` | auto | Default: `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` exists, otherwise `pnpm install`. Runs in the build copy. |
| `DIST_DIR` | `dist` | Output folder, relative to the project root in the build copy. Must match what `BUILD_CMD` writes. It is copied to `www` after a successful build. |
| `HTTP_PORT` | `8080` | Port Caddy listens on inside the container. |
| `SPA` | `true` | Serve `index.html` for unknown paths. Set `false` for a multi-page site. |
| `API_UPSTREAM` | empty | For example `host.docker.internal:3000`. Enables the reverse proxy. Add `--add-host=host.docker.internal:host-gateway` on Linux. |
| `API_PATH` | `/api/*` | Path matcher forwarded to `API_UPSTREAM`. |
| `POLL_INTERVAL` | `2` | Seconds between source checks. |
| `DEBOUNCE_SECONDS` | `3` | Quiet time the source must have before a build starts. Raise it if saves come in slow bursts (for example from a formatter on save). |
| `MIN_BUILD_INTERVAL` | `10` | Minimum seconds between the end of one build and the start of the next. |
| `MAX_WAIT_SECONDS` | `60` | Longest a pending change waits even if edits keep coming. |
| `CADDYFILE` | unset | Path inside the container to a custom Caddyfile, copied over the generated one. `API_UPSTREAM`, `API_PATH` and `SPA` then have no effect. `HTTP_PORT` still drives the health check, so keep it matching the custom file's listen port. Its `root` must be `/var/lib/dev-host/www`. It must also keep the `/__dev-host/status.json` route, which the health check uses. Mount the file with `-v`. |
| `WORKSPACE` | `/workspace` | Mount point of the project. It is read, never written. Change only if the mount point changes. |

Rebuilds are triggered by changes to any file in `/workspace`, except paths under `node_modules`, `.git`, `dist` (or `DIST_DIR`), `.vite`, `.turbo`, `.cache`, `coverage` and `.pnpm-store`.

The copy into the build directory skips `node_modules`, `.git`, `.vite`, `.turbo`, `.cache`, `coverage` and `.pnpm-store` at any depth, and `/$DIST_DIR` at the project root. Nested `dist` folders are copied.

Inside the container: `/workspace` is the read-only input, `/var/lib/dev-host/build` is the copy (with its `node_modules` and the build output), `/var/lib/dev-host/www` is the served output, and `/var/lib/dev-host` holds the status files. The pnpm store is `/var/lib/dev-host/pnpm/store`, which the run command mounts as a volume (see Share the package cache).

Dependencies are reinstalled when `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` or `.pnpmfile.cjs` changes.

## Gotchas

- **Recovering a failed install.** A failed install still records the dependency state, so while `node_modules` exists in the build copy, later builds do not run the install again until a dependency file changes. A partial `node_modules` can also break every later build. Recover inside the container: `docker exec <name> rm -rf /var/lib/dev-host/build/node_modules`, then `docker exec <name> dev-host rebuild`. Do not delete it from the host; the build copy lives in the container.
- **Builds never touch `/workspace`.** Files the build writes (for example `tsconfig.tsbuildinfo`) stay in the build copy, so they cannot start a build. An edit saved during a build starts another build after it.
- **Demo installs at first start.** The demo image does not install during the image build, so its first start installs dependencies and needs network access.
- **A failed first build leaves nothing to serve.** If no build has ever succeeded, `www` is empty, so requests return 404 until a build works.
- **Ports.** A changed `HTTP_PORT` must be matched in `-p`, and it is also used by the health check.
- **Disk use.** The build copy and its `node_modules` live in the container and are removed with `docker rm`. The pnpm store lives in the `node-dev-host-pnpm` volume, which is kept until you remove it. The loop runs `pnpm store prune` after each successful install to drop packages no project uses. Docker keeps container logs without a size limit by default; add `--log-opt max-size=10m --log-opt max-file=3` to `docker run` on a long-lived container.
- **Memory use.** An idle container uses about 14 MiB of RAM (Caddy plus the polling loop). Memory peaks during `pnpm install` and the build, which exit when done. Use `--memory` to cap a large build on a small host.
- **Polling cost.** Each poll walks the source tree (not `node_modules`). Measured at about 50 ms of CPU for 10,000 source files. Raise `POLL_INTERVAL` on very large trees.
- **Not a production server.** The image is for development previews and local work. Deploy the built `dist` with the project's own hosting.

## Build the image locally

```sh
docker build -t node-dev-host:latest .               # host
docker build --target demo -t node-dev-host:demo .   # demo
docker build --target host-alpine -t node-dev-host:alpine .        # alpine host
docker build --target demo-alpine -t node-dev-host:demo-alpine .   # alpine demo
```

Build args: `NODE_VERSION` (24), `CADDY_VERSION` (2), `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## Files in this repo

- `Dockerfile`: Debian targets `base`, `demo`, `host`; Alpine targets `base-alpine`, `demo-alpine`, `host-alpine`. `host` stays last so a bare `docker build .` produces the Debian host image.
- `rootfs/usr/local/bin/dev-host`: the entrypoint script with `run`, `rebuild`, and `status` commands.
- `demo/`: the demo project copied into the `demo` image.
- `.github/workflows/publish.yml`: publishes both variants on push to `main`, on `v*` tags, weekly, and on manual dispatch.
- `.github/workflows/integration.yml`: builds all four targets and runs the integration tests against each one. It runs on pull requests that touch the image, the demo or the tests.
- `tests/integration/run.sh`: the integration tests. `run.sh <image> <target>` starts real containers from a fixture project and checks what they build and serve. Run it locally after `docker build -t node-dev-host:test-host --target host .`.
