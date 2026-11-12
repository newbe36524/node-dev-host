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

Every tag also runs the [control node](#control-node) on `linux/amd64` and `linux/arm64`, with both the Debian and the Alpine tags.

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
- Optional control node: `dev-host control` runs a dashboard and JSON API for the node-dev-host containers on the Docker host. It lists them with their build state and starts, stops, restarts, rebuilds, removes and shows the logs of them. See [Control node](#control-node).

## Quick start

```sh
# Use a free port from 43100-43299. Several containers on one machine must not share a port.
docker run --rm --name nd-demo -p 127.0.0.1:43100:8080 \
  --label node-dev-host.port=43100 --label node-dev-host.name=nd-demo \
  ghcr.io/newbe36524/node-dev-host:demo
# open http://127.0.0.1:43100

docker run -d --name nd-my-site -p 127.0.0.1:43101:8080 \
  --label node-dev-host.port=43101 --label node-dev-host.name=nd-my-site \
  -v "$PWD":/workspace:ro \
  -v node-dev-host-pnpm:/var/lib/dev-host/pnpm \
  ghcr.io/newbe36524/node-dev-host:latest
```

The `node-dev-host.port` label records the port, so `docker ps --filter label=node-dev-host.port` lists the ports in use. The control node (see [Control node](#control-node)) has a role label instead, so it is not in that list. The skill's [port procedure](skills/node-dev-host/SKILL.md#choose-the-host-port) picks ports the same way for agents.

## Share the package cache

The `-v` line above keeps the pnpm store in a named volume, so a new container reuses the packages that are already downloaded. In a test, a second container reused 17 of its 18 packages and downloaded only the one new package. The image sets `PNPM_CONFIG_STORE_DIR` for this. If you override it, keep the store inside the volume, or pnpm ignores the volume and the cache is not shared.

- **Host directory instead of a volume:** add `--user "$(id -u):$(id -g)" -e HOME=/tmp` and mount `"$HOME/.cache/node-dev-host/pnpm"` at `/var/lib/dev-host/pnpm`. A named volume is root-owned and does not work with `--user`.
- **npm projects:** mount a volume at `/var/lib/dev-host/npm-cache` and set `-e npm_config_cache=/var/lib/dev-host/npm-cache`.
- **Several containers at once** can share one volume. Removing containers does not remove the volume; `docker volume rm node-dev-host-pnpm` resets it.

The skill has the details and the trade-offs: [`skills/node-dev-host/SKILL.md`](skills/node-dev-host/SKILL.md#share-the-package-cache).

## Control node

The same image can run a control node instead of a project host. `dev-host control` serves a dashboard and a small JSON API for the node-dev-host containers on this Docker host. It builds nothing itself. Start it with the Docker socket mounted:

```sh
# Use a free port from 43100-43299. Keep it on loopback.
docker run -d --name nd-control -p 127.0.0.1:43190:8080 \
  --label node-dev-host.role=control \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/newbe36524/node-dev-host:latest control
# open http://127.0.0.1:43190
```

The `node-dev-host.role=control` label marks the node. It has no `node-dev-host.port` label, so it never lists or manages itself. Every tag starts the control node the same way.

Pick its port with the same procedure as the project containers, from the skill's [port procedure](skills/node-dev-host/SKILL.md#choose-the-host-port). The control node has no port label to read back, so remove a running control node before you pick its port again.

### What the dashboard shows

The dashboard lists each container that carries the `node-dev-host.port` label, running or stopped. For each one it shows the name, port, image, state, health, build state, time of the last build, and an **Open** link to its port on the same host. Containers without the label are not listed, and neither is the control node.

Build states: `starting`, `building`, `ok`, `failed`, `waiting` and `unknown`. A stopped container shows `stopped`. `unknown` also appears when the status cannot be read within 2 seconds, and for a container on a user-defined network that the control node has not joined.

### What the dashboard does

- **Rebuild, Restart and Stop** for a running container, and **Start** for a stopped one. Rebuild runs `dev-host rebuild` inside the container. It is refused for a stopped container.
- **Logs** shows the last 200 lines of the container's log.
- **Remove** force-removes the container after a confirmation, and frees its port.

Actions reach only labelled containers. Any other name is refused.

### Socket risk

The Docker socket is root-equivalent on the host. The process that holds it can run any Docker command, so a compromised control node means a compromised host. Keep the port on loopback (`127.0.0.1:...`). Every request passes these checks:

- The `Host` header must be `127.0.0.1`, `localhost`, `[::1]`, or a name listed in `CONTROL_ALLOWED_HOSTS`. This blocks DNS rebinding.
- POST and DELETE need an `Origin` that matches the `Host`, and the header `X-Dev-Host-Control: 1`.
- Read-only mode rejects every POST and DELETE.

There is no authentication beyond these checks.

### Configuration

The control node reads these variables. The variables in the skill's Configuration table apply to project hosts, not to the control node.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | Port the control node listens on inside the container. Match it in `-p`. |
| `CONTROL_READONLY` | `false` | `true` (also `1`, `yes` or `on`) rejects every change. The dashboard then shows read-only mode and disables the actions. Logs still work. |
| `CONTROL_ALLOWED_HOSTS` | empty | Comma-separated extra Host names to accept, for example `devbox.local`. Add only the names you open the dashboard with. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Socket path inside the container. Change it only when the socket is mounted at another path. |

### Docker Desktop (macOS and Windows)

On macOS and Windows, Docker Desktop runs the Linux images in its Linux VM. Mount the socket and publish the port on loopback, as above. This is documented guidance only: CI does not test control mode on those hosts.

### Develop the dashboard

The dashboard source is in [`control-ui/`](control-ui), a pnpm project. Run these commands in `control-ui/`:

```sh
pnpm install     # CI uses: pnpm install --frozen-lockfile
pnpm dev         # Vite dev server; proxies /api to a running control node
pnpm test        # unit and component tests
pnpm build       # type check, then the production build into control-ui/dist
```

`pnpm dev` proxies `/api` to `CONTROL_URL`, which defaults to `http://127.0.0.1:43180`. Publish a control node on that port, or set `CONTROL_URL` to where it runs.

## Use it with an AI agent

This repo ships an agent skill at [`skills/node-dev-host/SKILL.md`](skills/node-dev-host/SKILL.md). It explains how to run, configure, and operate the image: choosing a variant, mounting a project, setting environment variables, reading build status, forcing a rebuild, and fixing common problems.

Install it with your agent's skill installer, for example:

```sh
npx skills add newbe36524/node-dev-host
```

Or copy `skills/node-dev-host/` into your agent's skills directory.

Example requests once the skill is installed:

- "Serve my Vite project in `~/code/app` with node-dev-host on a free port in 43100-43299."
- "Proxy `/api` to `localhost:3000` in the node-dev-host container."
- "Check whether the node-dev-host build failed, and show the log."
- "Force a rebuild in `nd-my-site`."

The demo project is in [`demo/`](demo) if you want a template.

## Building locally

```sh
docker build -t node-dev-host:latest .               # host
docker build --target demo -t node-dev-host:demo .   # demo
docker build --target host-alpine -t node-dev-host:alpine .        # alpine host
docker build --target demo-alpine -t node-dev-host:demo-alpine .   # alpine demo
```

To build both platforms in one command, use buildx. The non-native platform needs QEMU/binfmt on the machine (or Docker Desktop), and the builder needs the `docker-container` driver (`docker buildx create --use`):

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target host .
```

A multi-platform result cannot be loaded into the local image store. It stays in the builder cache unless you add `--push` with a registry tag, or build one platform at a time with `--load`.

The image is kept small on purpose: each build step removes what it creates, and package caches are BuildKit cache mounts that never reach a layer. The published tags use zstd layers (about 24% smaller to pull than gzip), which needs a Docker client that can read zstd.

Build args: `NODE_VERSION`, `CADDY_VERSION`, `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## Integration tests

`tests/integration/run.sh <image> <target>` runs real containers against a built image and checks what they build and serve: the read-only workspace, rebuilds on edit, failed builds, the `/api` proxy, a custom `CADDYFILE`, the shared pnpm store volume and the control node. It needs Docker, curl, Node.js (for the `/api` upstream), GNU `find` and coreutils (`cksum`, `sha256sum`), and either `ss` or `lsof`. The control scenarios also mount `/var/run/docker.sock`.

```sh
docker build --target host -t node-dev-host:test-host .
tests/integration/run.sh node-dev-host:test-host host
```

The control scenarios are `test_control_runtime` (health, guards and the missing socket), `test_control_dashboard_api` (the list, logs and the dashboard) and `test_control_actions` (start, stop, restart, rebuild, remove and read-only mode). They run for all four targets.

The `integration` workflow runs the same script for all four variants on pull requests and on pushes to `main` that change the image, the demo, the control dashboard or the tests, and on manual dispatch. Each variant runs on a native amd64 runner (`ubuntu-latest`) and a native arm64 runner (`ubuntu-24.04-arm`), so the arm64 tests run on arm64 hardware and not under emulation. A `control-ui` job runs the dashboard's tests and build first.

## License

MIT
