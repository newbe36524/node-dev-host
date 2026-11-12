# node-dev-host

A Docker image that builds your mounted source into `dist` and serves it with Caddy, all inside one long-lived container. Edit files on the host; the container rebuilds by itself, so you never restart it for a change.

Image: `ghcr.io/newbe36524/node-dev-host` (`linux/amd64`, `linux/arm64`)

## Variants

| Tag | What it is |
| --- | --- |
| `latest` | Plain host. Mount your project at `/workspace`. |
| `demo` | Same host plus a small Vite + TypeScript project, already built and served. |

A git tag `v1.2.3` also publishes `1.2.3` (host) and `1.2.3-demo` (demo).

## Features

- Installs dependencies and runs your build command, then serves the output folder.
- Polls the source tree and rebuilds after changes settle.
- Keeps serving the last good build when a new build fails.
- Serves `index.html` for unknown paths (SPA mode) and can proxy an API path to another port.
- Reports build state as JSON at `/__dev-host/status.json` and `dev-host status`, and lets you trigger a rebuild with `dev-host rebuild`.
- Configured with environment variables.

## Quick start

```sh
docker run --rm -p 8080:8080 ghcr.io/newbe36524/node-dev-host:demo
# open http://localhost:8080

docker run -d --name my-site -p 8080:8080 \
  -v "$PWD":/workspace \
  ghcr.io/newbe36524/node-dev-host:latest
```

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
```

Build args: `NODE_VERSION`, `CADDY_VERSION`, `PNPM_VERSION`, `TYPESCRIPT_VERSION`, `TSX_VERSION`.

## License

MIT
