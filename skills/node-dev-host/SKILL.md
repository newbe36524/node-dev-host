---
name: node-dev-host
description: "Run, configure and operate the node-dev-host Docker image (ghcr.io/newbe36524/node-dev-host). It copies a mounted source tree into a private build directory, builds it there, and serves the output with Caddy inside one long-lived container, rebuilding on every change without writing to the mounted project. The same image can also run a control node: a dashboard and API that list those containers and start, stop, restart, rebuild, remove or show the logs of them, through the mounted Docker socket. Use when the user wants to preview or serve a Node, TypeScript, Vite or pnpm project in Docker without restarting the container, choose the host, demo or Alpine variant, set BUILD_CMD, INSTALL_CMD, DIST_DIR, HTTP_PORT, SPA or API_UPSTREAM, proxy an API path, read build status, force a rebuild, fix a container that serves stale or missing files, or run and configure the control node dashboard (CONTROL_READONLY, CONTROL_ALLOWED_HOSTS, DOCKER_SOCKET). Keywords: node-dev-host, dev-host, live rebuild, 容器内构建, 本地预览, Caddy, dist, 热重载, control node, dashboard, Docker socket."
---

# node-dev-host

A Docker image that builds **source → `dist`** inside one container. `dev-host` (PID 1 via `tini`) runs Caddy to serve the output and a build loop that rebuilds it when the source changes. The container is long-lived: edit files on the host, and the container rebuilds without a restart. The mounted project is read-only input: install and build run in a private copy inside the container, so nothing is written into the project folder.

Inside the image: Node 24, `pnpm`, `typescript` (`tsc`), `tsx`, `git`, `curl`, `rsync`, `tini`, and Caddy.

## Pick a variant

| Image tag | Use when |
| --- | --- |
| `ghcr.io/newbe36524/node-dev-host:latest` | The user has their own project. Mount it. |
| `ghcr.io/newbe36524/node-dev-host:demo` | The user wants to see the image work with no project. Nothing to mount. |
| `ghcr.io/newbe36524/node-dev-host:alpine` | The user has their own project and wants a smaller image. Alpine (musl). Use only if the project has no glibc-only native dependencies. |
| `ghcr.io/newbe36524/node-dev-host:demo-alpine` | The demo on Alpine. |

Use an exact version tag (`1.2.3`, `1.2.3-demo`, `1.2.3-alpine` or `1.2.3-demo-alpine`) when the user needs a pinned image. All variants run `linux/amd64` and `linux/arm64`. The Debian tags are the default; choose Alpine only on request or when the image size matters.

All four tags support control mode on both architectures (`linux/amd64` and `linux/arm64`). The same image starts the control node when it is run with the argument `control`. See [Control node](#control-node).

## Choose the host port

Several containers often share one machine, and fixed ports collide. Every container takes its host port from the range **43100–43299**. The agent picks the port itself on every run. Never publish a fixed port such as `8080` unless the user names one.

Docker is the registry. Nothing is kept in a separate file:

- The port is recorded in the label `node-dev-host.port`, and the container name in `node-dev-host.name`.
- A port stays reserved while its container exists, running or stopped. `docker rm` frees it.
- A port that is listening on the host, or published by any other container, counts as taken, so other software is respected.
- The search starts at a point derived from the container name, so a name gets the same port on every run as long as that port is free.

Procedure:

1. **Name the container** `nd-<project>`. `<project>` is the project folder name in lowercase, with every character outside `a-z0-9` replaced by `-`. Use a name the user gives instead, if they give one.
2. **Pick the port** with `pick_port` below: `PORT=$(pick_port nd-<project>)`. It returns the port the container already has, if it has one.
3. **Replace an existing container of that name.** If the container exists and only needs starting, run `docker start` and stop here. Otherwise run `docker rm -f nd-<project>`. That frees the port, so the same port comes back.
4. **Run** with the port on loopback and the two labels, as in [Run it](#run-it).
5. **If `docker run` fails**, run `docker rm -f nd-<project>` first. A failed start can leave a container that still holds the label, and the same port would be picked again. Then go back to step 2. Stop after 5 tries and report the error.
6. **Tell the user** the address `http://127.0.0.1:<PORT>`.

**The control node** takes its port from the same range, with the name `nd-control`. It carries the label `node-dev-host.role=control` and no `node-dev-host.port` label. So `docker ps -a --filter label=node-dev-host.port` does not list it, and `pick_port` cannot read its port back: while the control node runs, `pick_port nd-control` returns a different port, because the port is taken. Remove it first, then pick again: `docker rm -f nd-control`, then `PORT=$(pick_port nd-control)`. Without a container, `pick_port` returns the port derived from the name, the same on every run while it is free. A stopped control node does not reserve its port, so another container may take it.

```sh
pick_port() {
  local name="$1" port listening taken start c i
  # The port this container already has, if any.
  port=$(docker inspect -f '{{index .Config.Labels "node-dev-host.port"}}' "$name" 2>/dev/null)
  if [ -n "$port" ] && [ "$port" != "<no value>" ]; then echo "$port"; return 0; fi
  # Taken: listening on the host, published by any container, or reserved by a labelled container.
  if command -v ss >/dev/null 2>&1; then
    listening=$(ss -Htln | awk '{print $4}' | sed 's/.*://')
  else
    listening=$(lsof -nP -iTCP -sTCP:LISTEN | awk 'NR>1 {print $9}' | sed 's/.*://')
  fi
  taken=$( { echo "$listening"
             docker ps --format '{{.Ports}}' | grep -oE '[0-9]+->' | tr -d '>-'
             docker ps -a --filter label=node-dev-host.port --format '{{.Label "node-dev-host.port"}}'
           } | grep -E '^[0-9]+$' | sort -un)
  start=$(( 43100 + $(printf '%s' "$name" | cksum | cut -d' ' -f1) % 200 ))
  for i in $(seq 0 199); do
    c=$(( 43100 + (start - 43100 + i) % 200 ))
    grep -qx "$c" <<<"$taken" || { echo "$c"; return 0; }
  done
  echo "no free port in 43100-43299" >&2
  return 1
}
```

To see the registry, run `docker ps -a --filter label=node-dev-host.port --format 'table {{.Names}}\t{{.Label "node-dev-host.port"}}\t{{.Status}}'`. To release a port, remove its container with `docker rm -f <name>`. Never give a container another container's name, and never reuse a port that a container of another name holds.

## Run it

Mount the project so that its `package.json` is at the root of `/workspace`:

```sh
docker run -d --name <name> \
  -p 127.0.0.1:<PORT>:<HTTP_PORT> \
  --label node-dev-host.port=<PORT> --label node-dev-host.name=<name> \
  -v "<absolute-path-to-project>":/workspace:ro \
  -v node-dev-host-pnpm:/var/lib/dev-host/pnpm \
  [-e VAR=value ...] \
  ghcr.io/newbe36524/node-dev-host:latest
```

The cache volume (the shared pnpm store) is part of the default command. See [Share the package cache](#share-the-package-cache).

Rules:

- Use an absolute host path (or `"$PWD"` from the project directory). Do not use a relative path.
- The host port (`<PORT>`) comes from `pick_port` in [Choose the host port](#choose-the-host-port). Never publish a fixed port. The container-side port must equal `HTTP_PORT` (default `8080`). If `HTTP_PORT` is changed, change the container side of `-p` too.
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
  docker run -d --name <name> -p 127.0.0.1:<PORT>:<HTTP_PORT> \
    --label node-dev-host.port=<PORT> --label node-dev-host.name=<name> \
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
curl http://127.0.0.1:<PORT>/__dev-host/status.json
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

## Control node

The control node is the same image started with the argument `control`. It lists the node-dev-host containers on the Docker host, shows their build state, runs a fixed set of actions on them, and serves a dashboard. It builds nothing and mounts no project. It needs the Docker socket.

### Run it

Use the same shape as `test_control_runtime` in `tests/integration/run.sh`. `<PORT>` comes from `pick_port nd-control`, as in [Choose the host port](#choose-the-host-port):

```sh
docker run -d --name nd-control \
  -p 127.0.0.1:<PORT>:8080 \
  --label node-dev-host.role=control \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v node-dev-host-control:/var/lib/dev-host/control \
  [-e VAR=value ...] \
  ghcr.io/newbe36524/node-dev-host:latest control
```

Rules:

- Publish on loopback only. The container port `8080` is the default `HTTP_PORT`. If `HTTP_PORT` changes, change the container side of `-p` too.
- It is healthy when `docker inspect -f '{{.State.Health.Status}}' nd-control` prints `healthy` (about 20 s after start). `curl -s http://127.0.0.1:<PORT>/__dev-host/status.json` answers `{"state":"ok","role":"control"}`.
- Without the socket mount, `status.json` answers 503 and its message names the missing mount (`Mount it with -v /var/run/docker.sock:/var/run/docker.sock`). The list answers 503 too. Recreate the container with the mount.
- The variables in [Configuration](#configuration) apply to project hosts. The control node reads only the variables below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | Port the control node listens on inside the container. |
| `CONTROL_READONLY` | `false` | `true` (also `1`, `yes` or `on`) rejects every POST and DELETE with 403. The dashboard shows read-only mode and disables the actions. Logs and the list still work. |
| `CONTROL_ALLOWED_HOSTS` | empty | Comma-separated extra Host names the guard accepts, for example `devbox.local`. Add only the names the user opens the dashboard with. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Socket path inside the container. Change it only when the socket is mounted at another path. |
| `CONTROL_DATA_DIR` | `/var/lib/dev-host/control` | Directory containing `nodes.json`. Mount a persistent volume there to keep node records across control-container recreation. |
| `CONTROL_ALLOWED_IMAGES` | `ghcr.io/newbe36524/node-dev-host,node-dev-host` | Comma-separated allowed image repositories for node creation. Tags may vary. |
| `CONTROL_WORKSPACE_ROOTS` | empty | Comma-separated absolute host path roots allowed for workspaces. Empty allows any absolute path without `..` segments. |

### Guards and API

Every request is checked in order. The `Host` header must be `127.0.0.1`, `localhost`, `[::1]` or in `CONTROL_ALLOWED_HOSTS`, or the answer is 403. POST and DELETE also need an `Origin` that matches the `Host` and the header `X-Dev-Host-Control: 1`, or 403. Read-only mode then rejects them with 403. There is no authentication beyond these checks.

| Request | Result |
| --- | --- |
| `GET /api/containers` | `{"readOnly":…,"containers":[…],"persistence":…,"nextPort":…}`. Each row also has `registered`, `schedule`, `operation`, `error` and `warning`; a saved node without a container is `not created`. |
| `GET /api/containers/<name>/logs?tail=N` | Plain text. `N` defaults to 200 and is capped at 1000. |
| `POST /api/containers/<name>/start`, `stop`, `restart` | 200 |
| `POST /api/containers/<name>/start` with `{"autoStart":true}` | Saves a seven-day auto-start expiry, then starts; a missing container is created from its record. |
| `POST /api/containers/<name>/rebuild` | 202. Runs `dev-host rebuild` in the container. 409 when the container is stopped. |
| `POST /api/containers/<name>/recreate` | 202. Pulls the latest image and recreates a registered node from its record. |
| `DELETE /api/containers/<name>` | 200. Removes the container and frees its port; a registered node record stays. |
| `POST /api/nodes` | 201. Saves a node record without creating a container. The body may list `networks`. |
| `DELETE /api/nodes/<name>` | 200. Removes the container if present, then deletes the record. |
| `POST /api/nodes/<name>/auto-start` | 200. Extends auto-start to seven days from now. |
| `DELETE /api/nodes/<name>/auto-start` | 200. Clears the auto-start expiry without stopping a running node. |
| `POST /api/scan` | 200 with `{imported, skipped}` for labelled containers not yet registered. |

Labelled containers and saved nodes are listed and actionable. Unlabelled containers without a node record are refused with 403, and an unknown name returns 404. A registered node without a container accepts Start, Recreate and Delete node only. The control node has no port label or node record, so it is refused too.

### Add a node through the API

Use the API for scripts and agents too; do not add managed nodes by editing a Compose file. `curl` supplies `Host` from the URL. For every POST or DELETE, send an `Origin` equal to that URL's origin and `X-Dev-Host-Control: 1`; `POST /api/nodes` also requires `Content-Type: application/json`. These guards are not authentication, so keep the port on loopback.

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

Optional `"networks": ["nd-console_default"]` attaches the container to user-defined networks instead of the default bridge (up to four names, each must exist). Use it when the control node has to reach the container, for example `nd-console_default` so the control node can read its build state; the control node is on `nd-console_default`. Without it the container is on the default bridge and the control node shows its build state as `unknown`.

The list provides `nextPort` and `persistence`; adding saves a node and leaves it `not created`, and Start queues pull and creation. Poll `GET /api/containers` until the row is running or contains an error.

| Status | Meaning |
| --- | --- |
| `400` | Invalid node fields or JSON, or a network that does not exist or is `bridge`, `host` or `none`. |
| `403` | Guard rejected the request or read-only mode is on. |
| `409` | Duplicate name or port is already in use. |
| `413` / `415` | Body exceeds 16 KB / content type is not JSON. |
| `503` | Node store is not writable or Docker is unreachable. |

Every error response is JSON with an `error` message. Scan imports reproducible labelled containers and reports skipped containers with extra mounts, a non-loopback published port, privileged mode, or no `/workspace` bind on a non-demo image. Imported nodes have no auto-start window. After import the console owns the record; Recreate uses that record and the new container will not retain Compose labels.

### Node records and scheduled startup

Node records live in `CONTROL_DATA_DIR/nodes.json`; mount a persistent volume at the data directory as in [Run it](#run-it). Add saves a record but creates nothing. Start without a container pulls its image, creates the fixed container shape and starts it. Recreate pulls the latest image; Remove container keeps the record; Delete node removes both.

When manually starting a node without an active schedule, choose Start only or Start and auto-start for seven days. On each control-node startup, active records are started in the background; there is no daily timer, and read-only mode skips both discovery and scheduled startup. Extend 7 days renews the expiry. Stop auto-start clears it without stopping the node. Stop alone is temporary: an active node starts again on a later control-node startup.

### Operate it

```sh
curl -s http://127.0.0.1:<PORT>/api/containers
curl -s -X POST -H "Origin: http://127.0.0.1:<PORT>" -H "X-Dev-Host-Control: 1" \
  http://127.0.0.1:<PORT>/api/containers/<name>/rebuild
```

The dashboard's Build column shows `starting`, `building`, `ok`, `failed`, `waiting` or `unknown`. A stopped container shows `stopped` there, and its API build state is `unknown`.

The header's **Theme** button picks Light, Dark or System (the default). The choice is stored in the user's browser (`localStorage`, key `dev-host-theme`) and is not part of the API, so change it in the browser, not with a request.

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

Rebuilds are triggered by changes to any file in `/workspace`, except `node_modules`, `.git`, `dist`, `.vite`, `.turbo`, `.cache`, `coverage` and `.pnpm-store`, which are excluded at any depth. `/$DIST_DIR` (for example `build` when `DIST_DIR=build`) is excluded at the project root only.

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
- **Control node: user-defined networks.** The control node reads each container's build state from the container's IP address. A running container on a user-defined network that the control node has not joined shows build state `unknown`. Join the control node to that network with `docker network connect <network> nd-control`, or add the node through the API with `"networks": ["<network>"]` so the container joins it from the start.
- **Control node: the socket is root-equivalent.** The control node mounts the Docker socket, so its process can run any Docker command on the host. A compromised control node means a compromised host. Keep the port on loopback, add to `CONTROL_ALLOWED_HOSTS` only the names the user needs, and run the control node only on a machine the user controls. The API has no authentication beyond the Host and Origin checks.
- **Control node: Docker Desktop (macOS and Windows).** Docker Desktop runs these Linux images in its Linux VM. Mount the socket and publish on loopback as on Linux. This is documented guidance; CI does not test control mode on those hosts. When the list answers 503, read the `error` message in the response first.

## Build the image locally

```sh
docker build -t node-dev-host:latest .               # host
docker build --target demo -t node-dev-host:demo .   # demo
docker build --target host-alpine -t node-dev-host:alpine .        # alpine host
docker build --target demo-alpine -t node-dev-host:demo-alpine .   # alpine demo
```

Build args: `NODE_VERSION` (24), `CADDY_VERSION` (2), `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## Files in this repo

- `Dockerfile`: Debian targets `base`, `demo`, `host`; Alpine targets `base-alpine`, `demo-alpine`, `host-alpine`. `host` stays last so a bare `docker build .` produces the Debian host image. A `control-ui` stage builds the dashboard on `$BUILDPLATFORM`, and `base` and `base-alpine` copy its output to `/usr/local/lib/dev-host/control/ui`.
- `rootfs/usr/local/bin/dev-host`: the entrypoint script with `run`, `rebuild`, `status`, and `control` commands.
- `rootfs/usr/local/lib/dev-host/control/server.mjs`: the control node server (`dev-host control`). It has the routes, guards and config in [Control node](#control-node). It uses no npm packages.
- `control-ui/`: the React dashboard, a pnpm project with `dev`, `build`, `test` and `typecheck` scripts. `pnpm dev` proxies `/api` to `CONTROL_URL` (default `http://127.0.0.1:43180`).
- `demo/`: the demo project copied into the `demo` image.
- `.github/workflows/publish.yml`: publishes all four variants for `linux/amd64` and `linux/arm64`, on push to `main`, on `v*` tags, weekly, and on manual dispatch. After each publish it checks that every platform's image contains the dashboard's `index.html`.
- `.github/workflows/integration.yml`: a `control-ui` job runs the dashboard's `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm build`. The `integration` job builds all four targets and runs the integration tests against each one, on a native amd64 runner (`ubuntu-latest`) and a native arm64 runner (`ubuntu-24.04-arm`). It runs on pull requests and on pushes to `main` that touch the image, the demo, the control dashboard or the tests, and on manual dispatch.
- `tests/integration/run.sh`: the integration tests. `run.sh <image> <target>` starts real containers from a fixture project and checks what they build and serve, including the control node scenarios (`test_control_runtime`, `test_control_dashboard_api`, `test_control_actions`). Run it locally after `docker build -t node-dev-host:test-host --target host .`.
