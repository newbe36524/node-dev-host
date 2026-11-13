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
- Configured with environment variables, and optionally by a `.node-dev-host.yaml` at the project root: a name and description for the dashboard, directories that never reach the build copy, and build and serve settings. See [Workspace configuration](#workspace-configuration).
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

## Workspace configuration

A project can describe itself with `.node-dev-host.yaml` at the root of the mounted folder. dev-host reads the file at the start of every build, so an edit applies from the next build without a restart. The file is optional: without it, everything behaves as before. dev-host reads the file and never writes to the folder.

```yaml
# Project settings for node-dev-host. Put this file at the root of the project folder.
version: 1
name: jjb
description: Personal JJB site
ignore: [.browser-profile/, apps/scraper/cache/, "*.log"]
build:
  install: pnpm install --frozen-lockfile
  command: pnpm build:site
  distDir: apps/web/dist
  spa: true
serve:
  apiUpstream: 172.25.0.1:3001
```

| Field | Type and limits |
| --- | --- |
| `version` | Required. The integer `1`. |
| `name` | 1 to 80 characters, no control characters. Shown on the dashboard. |
| `description` | At most 500 characters, no control characters. Shown on the dashboard. |
| `ignore` | A list of strings. Each entry is an exclude pattern relative to the project root; see below. |
| `build.install` | Not empty. The install command, run in the build copy. |
| `build.command` | Not empty. The build command, run in the build copy. |
| `build.distDir` | Not empty, relative to the project root, no `..` segment. The folder that is served after a build. |
| `build.spa` | `true` or `false`. |
| `serve.apiUpstream` | `host:port`, for example `172.25.0.1:3001`. Nothing else: no scheme, path, spaces or Caddy syntax. |

The file is at most 64 KiB. A field not listed above is refused at any level, and so is any field that would choose a network: networks stay in the control node's node record. The top level must be a mapping of fields, and a file with more than one document is refused.

**YAML that is accepted:** block mappings indented with spaces, block lists of scalars, plain, `"double"` and `'single'` quoted strings, integers, `true` and `false`, `null` or `~`, comments that start with ` #` on their own line or after a value, and one-line flow lists such as `[a, "b/"]`. **Refused, with the line number:** anchors, aliases, tags, flow mappings, multi-line strings, multiple documents, lists of mappings, and tabs in indentation. Quote a value that starts with `*`, `&`, `!`, `%`, `@`, `` ` ``, `|`, `>`, `?`, `,`, `{` or `}`, and a value with `: ` inside it.

**Precedence.** Each setting takes the first of these that is set. An empty variable counts as unset.

| Setting | Environment variable | File | Default |
| --- | --- | --- | --- |
| Install command | `INSTALL_CMD` | `build.install` | `pnpm install` (with `--frozen-lockfile` when `pnpm-lock.yaml` exists) |
| Build command | `BUILD_CMD` | `build.command` | `pnpm build` |
| Output folder | `DIST_DIR` | `build.distDir` | `dist` |
| SPA mode | `SPA` | `build.spa` | `true` |
| API upstream | `API_UPSTREAM` | `serve.apiUpstream` | unset |

A container with no file and the same variables behaves exactly as before. The variables are not checked by the file validation, as before.

**Exclusions.** These are always excluded from the build copy and from the change check, at any depth, and no file can remove them: `node_modules`, `.git`, `.vite`, `.turbo`, `.cache`, `coverage`, `.pnpm-store`, and the output folder at the project root. `ignore` adds to them. Entries follow rsync's exclude rules:

- `.browser-profile/` matches a directory of that name at any depth.
- `apps/scraper/cache/` matches only that path, because a slash in the entry anchors it to the project root.
- `*.log` matches with a wildcard.
- Refused: a blank entry; an absolute path, `~` or a drive letter (`/data`); a `..` segment (`../secrets`, `a/../../b`); an entry starting with `!`, `#`, `;`, `+ ` or `- `; a newline or NUL.

Files inside an ignored path do not trigger builds and are not copied. An entry added to a running project removes that directory from the existing build copy at the next build. `node_modules`, caches and the build output in that copy are kept.

**An invalid file fails the build.** A file that does not validate fails the build before anything is installed or built. The reason goes to the status as `configError`, naming the field or the line, and the last good output keeps being served, as for any failed build. Fix the file and the next build clears the error.

**Serving settings need a restart.** `build.spa` and `serve.apiUpstream` are applied when the container starts. A later edit does not change the running Caddy; the next build reports `serve settings changed: restart the container to apply` and the container keeps the values it started with. A custom `CADDYFILE` makes both settings ineffective.

**Copy retry.** When `rsync` exits with 24 (files vanished during the copy, usually because a tool is still writing), the copy runs once more and the status keeps the warning `copy retried once: files changed while copying`. A second 24 or any other `rsync` error fails the build. Putting the directory in `ignore` is the lasting fix.

**Status and dashboard.** `/__dev-host/status.json` and `dev-host status` gain these fields on every write: `name`, `description`, `configSource` (`.node-dev-host.yaml`, or `null` without a file), `configHash` (the SHA-256 of the file, or `null`), `configError`, `ignore` (the configured entries only, not the built-ins) and `warnings`. The control node's list gives each row a read-only `project` object with `name`, `description`, `configSource`, `configError` and `warnings`. The dashboard shows the name and description under the container name, a `Config:` line for a rejected file, and the warnings.

## Control node

The same image can run a control node instead of a project host. `dev-host control` serves a dashboard and a small JSON API for the node-dev-host containers on this Docker host. It builds nothing itself. Start it with the Docker socket mounted:

```sh
# Use a free port from 43100-43299. Keep it on loopback.
docker run -d --name nd-control -p 127.0.0.1:43190:8080 \
  --label node-dev-host.role=control \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v node-dev-host-control:/var/lib/dev-host/control \
  ghcr.io/newbe36524/node-dev-host:latest control
# open http://127.0.0.1:43190
```

The `node-dev-host.role=control` label marks the node. It has no `node-dev-host.port` label, so it never lists or manages itself. Every tag starts the control node the same way.

Pick its port with the same procedure as the project containers, from the skill's [port procedure](skills/node-dev-host/SKILL.md#choose-the-host-port). The control node has no port label to read back, so remove a running control node before you pick its port again.

### What the dashboard shows

The dashboard lists each container that carries the `node-dev-host.port` label, running or stopped, and each saved node that has no container (`not created`). For each it shows the name, port, image, state, health, build state, time of the last build, auto-start window and an **Open** link to its port on the same host. Containers without the label are not listed, and neither is the control node. The control node saves node records in `CONTROL_DATA_DIR`; mount a volume there or the records disappear when the control container is recreated. The dashboard warns when that directory is not a separate mount or is not writable.

Build states: `starting`, `building`, `ok`, `failed`, `waiting` and `unknown`. A stopped container shows `stopped`. `unknown` also appears when the status cannot be read within 2 seconds, and for a container on a user-defined network that the control node has not joined.

### What the dashboard does

- **Rebuild, Restart and Stop** for a running container, and **Start** for a stopped or not-created node. Starting a missing node pulls the image and creates it from its saved record. **Recreate** pulls the latest image and replaces a registered node's container while keeping its record.
- **Logs** shows the last 200 lines of the container's log.
- **Remove container** force-removes the container after a confirmation and keeps a registered node as `not created`; for an unregistered container its row disappears.
- **Delete node** removes both the container and its saved record after confirmation.
- **Extend 7 days** renews the auto-start window. **Stop auto-start** clears it; Stop only stops the current container and does not opt out.
- **Add node** saves a node without creating its container. **Scan** imports labelled containers the control node can reproduce safely.

Around the table the dashboard adds:

- **Fleet ribbon:** one segment per container with its state word, and totals with faults first. Past 12 containers it becomes a dense matrix (50 cells fit in two rows) that keeps the host's order, so a cell never moves; hover or focus a cell to read its name, state and port.
- **Live rows:** a badge morphs when its state changes, and "Last build" is a ticking relative time. An action shows `rebuilding…` and the like until the next refresh.
- **Session timeline:** the state changes this browser tab has seen since it was opened. The control node keeps no history, so nothing earlier is shown.
- **Shortcuts:** `j` and `k` select a row, `L` opens its logs, `R` rebuilds it, `S` starts a stopped node through the same auto-start prompt, and `Ctrl K` (`Cmd K` on macOS) opens a command palette. In read-only mode the palette hides commands that change a container. Logs follow the tail every 3 seconds, and Pause freezes them.

Working a large fleet (the host limit is 50 containers):

- **Triage order:** the table lists failed first, then building, then ok, then stopped, with ties by name. A refresh that moves a state slides the rows to their new place.
- **Filter:** the counts above the matrix are buttons (`3 failed` shows only those), and the search box matches name, image or port. The filter lives in the address bar (`#q=api&s=failed`), so a reload or a shared link keeps the view. `/` focuses the search box, and `Esc` clears it.
- **Batches:** tick rows (checkbox, `x`, Shift-click for a range, or the header checkbox for everything shown) and a bar offers Rebuild, Restart, Stop and Start, each with how many of the selection it applies to. Stop and Restart of several ask first. At most 4 containers are acted on at once, and one message reports the result. A batch only reaches rows the filter shows, and Remove is never batched.
- **Moving fast:** `f` jumps to the next failed row, and the palette opens on group commands (`Rebuild 3 failed`, `Start 2 stopped`, `Show only building`). Type a name to go to a container, read its logs or change it.
- **Quiet rows:** past 12 containers each row keeps `Logs` and folds the other actions into a menu.

On the first manual start with no active auto-start window, the dashboard asks whether to start the node only or to auto-start it for seven days. The control node checks that absolute expiry on its own startup; there is no daily timer. Read-only mode disables node changes and skips both import and scheduled startup.

Actions reach only labelled containers. Any other name is refused.

The dashboard is the only visual view of what the containers do. Its design rules, with the status colours and the observation principles behind them, are in [`DESIGN.md`](DESIGN.md).

### npm registry

The **npm registry** button in the header sets a registry for every node. Each node container gets it as `NPM_REGISTRY`, and `dev-host` passes it to pnpm and npm as `PNPM_CONFIG_REGISTRY` and `npm_config_registry`. It overrides the registry in the workspace `.npmrc`. Leave the field empty to use each workspace's `.npmrc` or the default registry.

- The setting applies to a node when its container is created: on Start of a not-created node, on Recreate, and on the startup pass for auto-started nodes. A running container keeps its value until you recreate it.
- A node's own `NPM_REGISTRY` in its Environment overrides the setting for that node only.
- The URL must be `http` or `https`, with no credentials and no query. Put registry credentials in the workspace `.npmrc`; the value is saved in `nodes.json` and returned by the API.
- Inside a container, `127.0.0.1` is the container itself. For a mirror on the host, use `host.docker.internal` with `--add-host=host.docker.internal:host-gateway` on Linux.
- The API is `POST /api/settings` with `{"npmRegistry": "http://mirror.example:4873/"}` (or `null` to clear). It uses the same guards as the other POST routes.

### Theme

The **Theme** button in the header switches between Light, Dark and System. System is the default and follows the operating system's colour scheme. The choice is saved in the browser under `localStorage` key `dev-host-theme`, so it is not shared between browsers or devices.

### Socket risk

The Docker socket is root-equivalent on the host. The process that holds it can run any Docker command, so a compromised control node means a compromised host. Keep the port on loopback (`127.0.0.1:...`). Every request passes these checks:

- The `Host` header must be `127.0.0.1`, `localhost`, `[::1]`, or a name listed in `CONTROL_ALLOWED_HOSTS`. This blocks DNS rebinding.
- POST and DELETE need an `Origin` that matches the `Host`, and the header `X-Dev-Host-Control: 1`.
- Read-only mode rejects every POST and DELETE.

There is no authentication beyond these checks.

### Self-upgrade

A control node started from a `latest` image upgrades itself when a newer `latest` appears. Every few hours (`CONTROL_SELF_UPDATE_INTERVAL_HOURS`, default 6) it pulls the image. If the image changed, it:

1. starts a candidate control node from the new image, in standby, with the same volumes, networks and labels, and no host port;
2. waits until the candidate reports healthy;
3. waits for the running node's operations to finish, then pauses record changes (`POST` and `DELETE` return `503`, so retry) and writes `handover.json` in `CONTROL_DATA_DIR`;
4. the candidate loads `nodes.json` and acknowledges in the same file;
5. the new node is renamed to the old name, and the old container is removed.

The dashboard and `GET` requests keep working during the switch: they go through `nd-gateway` (see `repos/nd-console`), which forwards to the container named `nd-control`. If the candidate is not healthy or does not acknowledge in time, the candidate is removed and the running node resumes. Child nodes are not touched.

Pinned tags (for example `:0.2.1` or `@sha256:...`) never upgrade themselves. `POST /api/upgrade` starts an upgrade now, for any tag; `GET /api/upgrade` returns its phase and last error. Set `CONTROL_SELF_UPDATE=false` to turn the timer off.

### Configuration

The control node reads these variables. The variables in the skill's Configuration table apply to project hosts, not to the control node.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | Port the control node listens on inside the container. Match it in `-p`. |
| `CONTROL_READONLY` | `false` | `true` (also `1`, `yes` or `on`) rejects every change. The dashboard then shows read-only mode and disables the actions. Logs still work. |
| `CONTROL_ALLOWED_HOSTS` | empty | Comma-separated extra Host names to accept, for example `devbox.local`. Add only the names you open the dashboard with. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Socket path inside the container. Change it only when the socket is mounted at another path. |
| `CONTROL_DATA_DIR` | `/var/lib/dev-host/control` | Directory containing `nodes.json`. Mount a persistent volume here to keep node records across control-container recreation. |
| `CONTROL_ALLOWED_IMAGES` | `ghcr.io/newbe36524/node-dev-host,node-dev-host` | Comma-separated allowed image repositories for node creation. Tags may vary. |
| `CONTROL_WORKSPACE_ROOTS` | empty | Comma-separated absolute host path roots allowed for workspaces. Empty allows any absolute path without `..` segments. |
| `CONTROL_SELF_UPDATE` | `true` | Upgrade to a newer `latest` image on a timer. `false` (also `0`, `no`, `off`) turns the timer off; `POST /api/upgrade` still works. |
| `CONTROL_SELF_UPDATE_INTERVAL_HOURS` | `6` | Hours between image checks for self-upgrade. |
| `CONTROL_STANDBY` | empty | Set only by a self-upgrade on the candidate. A standby node answers its health check and returns `503` for the API until it takes over. Do not set it by hand. |

### Add a node through the API

Scripts and agents use the same `POST /api/nodes` route as the dashboard; do not add managed nodes by editing a Compose file. `curl` supplies `Host` from the URL. Mutating calls also need a matching `Origin`, `X-Dev-Host-Control: 1`, and `Content-Type: application/json`. These guards are not authentication; keep the control port on loopback.

```sh
CONTROL=http://127.0.0.1:43190
WORKSPACE="$PWD"
IMAGE=node-dev-host:latest
NEXT_PORT=$(curl -fsS "$CONTROL/api/containers" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')
BODY=$(node -e 'console.log(JSON.stringify({name:"nd-api-demo",workspace:process.argv[1],port:Number(process.argv[2]),image:process.argv[3]}))' \
  "$WORKSPACE" "$NEXT_PORT" "$IMAGE")
curl -fsS "$CONTROL/api/containers" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).persistence;console.log(JSON.stringify(p));if(!p.mounted)process.exitCode=1})'
curl -fsS -X POST -H "Origin: $CONTROL" -H 'X-Dev-Host-Control: 1' \
  -H 'Content-Type: application/json' --data "$BODY" "$CONTROL/api/nodes"
curl -fsS -X POST -H "Origin: $CONTROL" -H 'X-Dev-Host-Control: 1' \
  "$CONTROL/api/containers/nd-api-demo/start"
```

The optional `networks` field (for example `["nd-console_default"]`) attaches the container to user-defined networks; each must exist, and up to four are allowed. Without it the container uses the default bridge, and the control node cannot read its build state when it sits on a different network.

The initial list returns `nextPort` and `persistence`; adding saves the node and leaves it `not created`, and the follow-up Start queues image pull and creation. Poll `GET /api/containers` until it is running or its row has an error.

| Status | Meaning |
| --- | --- |
| `400` | Invalid node fields or JSON, or a network that does not exist or is `bridge`, `host` or `none`. |
| `403` | Guard rejected the request or read-only mode is on. |
| `409` | Duplicate name or port is already in use. |
| `413` / `415` | Body exceeds 16 KB / content type is not JSON. |
| `503` | Node store is not writable or Docker is unreachable. |

Every error response is JSON with an `error` message. A scan imports labelled containers that the control node can reproduce. It skips containers with extra mounts, a non-loopback published port, privileged mode, or (for non-demo images) no `/workspace` bind, and reports each reason. Imported nodes have no auto-start window. Once imported, the console owns that record; Recreate builds from it and the resulting container will not retain Compose labels.

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

`tests/integration/run.sh <image> <target>` runs real containers against a built image and checks what they build and serve: the read-only workspace, rebuilds on edit, failed builds, the `/api` proxy, a custom `CADDYFILE`, the shared pnpm store volume, the control node, and the workspace configuration (`test_workspace_config`: an ignored directory stays out of the copy and starts no build, the purge of a copy made before the rule, a rejected file that keeps the last page, ten manual builds while the ignored directory is written, `BUILD_CMD` taking precedence, and the retry on exit 24). It needs Docker, curl, Node.js (for the `/api` upstream), GNU `find` and coreutils (`cksum`, `sha256sum`), and either `ss` or `lsof`. The control scenarios also mount `/var/run/docker.sock`.

```sh
docker build --target host -t node-dev-host:test-host .
tests/integration/run.sh node-dev-host:test-host host
```

The control scenarios are `test_control_runtime` (health, guards and the missing socket), `test_control_dashboard_api` (the list, logs and the dashboard) and `test_control_actions` (start, stop, restart, rebuild, remove and read-only mode). They run for all four targets.

The `integration` workflow runs the same script for all four variants on pull requests and on pushes to `main` that change the image, the demo, the control dashboard or the tests, and on manual dispatch. Each variant runs on a native amd64 runner (`ubuntu-latest`) and a native arm64 runner (`ubuntu-24.04-arm`), so the arm64 tests run on arm64 hardware and not under emulation. A `control-ui` job runs the dashboard's tests and build first.

## License

MIT
