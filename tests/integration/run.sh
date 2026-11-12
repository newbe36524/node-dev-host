#!/usr/bin/env bash
# Integration tests for the node-dev-host image.
#
#   tests/integration/run.sh <image> <target>
#     <image>   a local image tag, for example node-dev-host:test-host
#     <target>  the Dockerfile target it was built from: host, demo, host-alpine or demo-alpine
#
# Each scenario starts a real container, waits for dev-host to build, and checks what Caddy serves.
# The project folder is copied into a temporary directory and mounted read-only, the way the skill
# tells users to run it. A failed check prints the container logs and makes the script exit 1.
#
# Host ports come from the range 43100-43299 and are registered with the same Docker labels the
# skill uses (node-dev-host.port, node-dev-host.name). That keeps the tests clear of other
# node-dev-host containers on the same machine. Container names carry the run's PID, so
# concurrent or repeated runs do not collide either.
set -uo pipefail

IMAGE="${1:?usage: run.sh <image> <target>}"
TARGET="${2:?usage: run.sh <image> <target>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$HERE/fixtures/app"
WORK="$(mktemp -d)"
RUN="$$"
VOLUME="ndit-$RUN-pnpm"
CONTAINERS=()
API_PID=""
FAILS=0

case "$TARGET" in
  demo|demo-alpine) VARIANT=demo ;;
  host|host-alpine) VARIANT=host ;;
  *) echo "unknown target: $TARGET (expected host, demo, host-alpine or demo-alpine)" >&2; exit 2 ;;
esac

log()  { printf '\n== %s\n' "$*"; }
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local desc="$1"; shift; if "$@"; then pass "$desc"; else fail "$desc"; fi; }

cleanup() {
  local rc=$?
  if [ "$FAILS" -gt 0 ]; then
    for c in "${CONTAINERS[@]}"; do
      printf '\n---- last log lines of %s\n' "$c"
      docker logs "$c" 2>&1 | tail -n 80
    done
  fi
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done
  docker volume rm "$VOLUME" >/dev/null 2>&1
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  rm -rf "$WORK"
  if [ "$FAILS" -gt 0 ]; then
    printf '\n%s check(s) failed for %s\n' "$FAILS" "$TARGET"
    exit 1
  fi
  printf '\nall checks passed for %s\n' "$TARGET"
  exit "$rc"
}
trap cleanup EXIT

# ---- port registry (the same procedure as skills/node-dev-host/SKILL.md, "Choose the host port") ----

# pick_port NAME: prints the host port for the container NAME, from 43100-43299.
pick_port() {
  local name="$1" port listening taken start c i
  port=$(docker inspect -f '{{index .Config.Labels "node-dev-host.port"}}' "$name" 2>/dev/null)
  if [ -n "$port" ] && [ "$port" != "<no value>" ]; then echo "$port"; return 0; fi
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
in_range() { [ "$1" -ge 43100 ] && [ "$1" -le 43299 ]; }

# ---- container helpers ------------------------------------------------------

# cn SHORT: the container name for a scenario in this run.
cn() { echo "ndit-$RUN-$1"; }

# start SHORT [docker run options...]: starts $IMAGE on a registered port from 43100-43299.
start() {
  local name port
  name="$(cn "$1")"; shift
  CONTAINERS+=("$name")
  # Another process may take the port between pick and run. Then remove the failed container
  # (it still holds the label) and pick again, as the skill describes.
  for _ in 1 2 3 4 5; do
    port="$(pick_port "$name")" || { fail "no free port for $name"; return 1; }
    if docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
         --label "node-dev-host.port=$port" --label "node-dev-host.name=$name" \
         "$@" "$IMAGE" >/dev/null 2>&1; then
      check "port $port for $name is in 43100-43299" in_range "$port"
      return 0
    fi
    docker rm -f "$name" >/dev/null 2>&1
  done
  fail "could not start $name after 5 tries"
  return 1
}
port()    { docker port "$(cn "$1")" 8080/tcp | head -n1 | sed 's/.*://'; }
url()     { echo "http://127.0.0.1:$(port "$1")$2"; }
status()  { docker exec "$(cn "$1")" dev-host status 2>/dev/null; }
state()   { status "$1" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'; }
builds()  { status "$1" | sed -n 's/.*"builds":\([0-9]*\).*/\1/p'; }

# poll SECONDS COMMAND...: runs COMMAND once a second until it succeeds or the time is up.
poll() {
  local limit="$1"; shift
  local end=$((SECONDS + limit))
  until "$@"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}

state_is()     { [ "$(state "$1")" = "$2" ]; }
builds_above() { [ "$(builds "$1")" -gt "$2" ]; }
healthy()      { [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cn "$1")")" = healthy ]; }
body_has()     { curl -fsS "$(url "$1" "$2")" 2>/dev/null | grep -q -- "$3"; }
body_lacks()   { ! curl -fsS "$(url "$1" "$2")" 2>/dev/null | grep -q -- "$3"; }
header_value() { curl -sI "$(url "$1" "$2")" | tr -d '\r' | sed -n "s/^$3: //Ip"; }
snapshot()     { find "$1" -printf '%P %T@ %s\n' | sort | sha256sum | cut -d' ' -f1; }

# A fresh copy of the fixture for one scenario, so edits never reach the repository.
fresh_project() { mkdir -p "$WORK/$1" && cp -r "$FIXTURE/." "$WORK/$1/"; }

# ---- scenarios ----------------------------------------------------------------

test_demo() {
  log "demo: starts with no project mounted and serves its built-in site"
  start demo
  check "reaches state ok" poll 300 state_is demo ok
  check "serves the demo page" body_has demo / "node-dev-host demo"
  check "sends X-Build-Time" test -n "$(header_value demo / X-Build-Time)"
  check "container becomes healthy" poll 120 healthy demo
}

test_host() {
  log "host: builds a read-only mounted project and serves it"
  fresh_project p1
  local dir="$WORK/p1"
  local before; before="$(snapshot "$dir")"
  start host -v "$dir:/workspace:ro"
  check "reaches state ok" poll 300 state_is host ok
  check "serves the built page" body_has host / marker-v1
  check "serves a file from public/" body_has host /extra.txt extra-file
  check "sends X-Build-Time" test -n "$(header_value host / X-Build-Time)"
  check "container becomes healthy" poll 120 healthy host
  check "project folder is unchanged (no node_modules, no dist)" [ "$(snapshot "$dir")" = "$before" ]

  log "host: rebuilds after an edit and stops serving files deleted from the project"
  printf '<p>marker-v2</p>\n' > "$dir/public/index.html"
  rm -f "$dir/public/extra.txt"
  check "serves the edited page" poll 180 body_has host / marker-v2
  check "a deleted file is no longer served" poll 180 body_lacks host /extra.txt extra-file

  log "host: a failed build keeps serving the last good output"
  local stamp; stamp="$(header_value host / X-Build-Time)"
  touch "$dir/BREAK"
  check "status becomes failed" poll 180 state_is host failed
  check "still serves the last good page" body_has host / marker-v2
  check "X-Build-Time is unchanged by the failed build" [ "$(header_value host / X-Build-Time)" = "$stamp" ]
  rm -f "$dir/BREAK"
  printf '<p>marker-v3</p>\n' > "$dir/public/index.html"
  check "recovers and serves the next good build" poll 180 body_has host / marker-v3
  check "status is ok again" state_is host ok

  log "host: an edit made during a build starts another build without a rebuild command"
  touch "$dir/SLOW"
  check "a slow build starts" poll 120 state_is host building
  printf '<p>marker-v4</p>\n' > "$dir/public/index.html"
  rm -f "$dir/SLOW"
  check "serves the edit made during the build" poll 180 body_has host / marker-v4

  log "host: dev-host rebuild triggers a build"
  local before_builds; before_builds="$(builds host)"
  docker exec "$(cn host)" dev-host rebuild >/dev/null
  check "a manual build finishes" poll 120 builds_above host "$before_builds"
  check "status is ok after the manual build" poll 120 state_is host ok
}

test_waiting() {
  log "host: an empty project waits instead of failing"
  mkdir -p "$WORK/empty"
  start empty -v "$WORK/empty:/workspace:ro"
  check "reports state waiting" poll 120 state_is empty waiting
}

test_api_proxy() {
  log "host: /api/* is proxied to API_UPSTREAM"
  local api_port
  api_port="$(pick_port "$(cn api-upstream)")" || { fail "no free port for the API upstream"; return 1; }
  check "API upstream port $api_port is in 43100-43299" in_range "$api_port"
  node -e "require('http').createServer((q, s) => {
    s.setHeader('content-type', 'application/json');
    s.end(JSON.stringify({ from: 'upstream', path: q.url }));
  }).listen($api_port, '0.0.0.0')" &
  API_PID=$!
  fresh_project api
  start api -v "$WORK/api:/workspace:ro" \
    --add-host=host.docker.internal:host-gateway \
    -e "API_UPSTREAM=host.docker.internal:$api_port"
  check "reaches state ok" poll 300 state_is api ok
  check "/api/hello reaches the upstream" poll 60 body_has api /api/hello '"from":"upstream"'
  check "other paths are still served from the build" body_has api / marker-v1
}

test_custom_caddyfile() {
  log "host: a custom CADDYFILE serves the output from its own root"
  cat > "$WORK/Caddyfile" <<'EOF'
{
  admin off
  auto_https off
}
:8080 {
  handle /__dev-host/status.json {
    header Cache-Control no-store
    rewrite * /status.json
    root * /var/lib/dev-host
    file_server
  }
  handle {
    root * /var/lib/dev-host/www
    file_server
  }
}
EOF
  fresh_project custom
  start custom -v "$WORK/custom:/workspace:ro" \
    -v "$WORK/Caddyfile:/etc/dev-host/Caddyfile:ro" \
    -e CADDYFILE=/etc/dev-host/Caddyfile
  check "reaches state ok" poll 300 state_is custom ok
  check "serves the page through the custom Caddyfile" body_has custom / marker-v1
  check "container becomes healthy" poll 120 healthy custom
}

test_shared_cache() {
  log "host: two containers share one pnpm store volume"
  docker volume create "$VOLUME" >/dev/null
  fresh_project c1
  fresh_project c2
  start cache-1 -v "$WORK/c1:/workspace:ro" -v "$VOLUME:/var/lib/dev-host/pnpm"
  check "first container reaches state ok" poll 300 state_is cache-1 ok
  check "first container stores packages in the volume" \
    bash -c "docker logs $(cn cache-1) 2>&1 | grep -q 'store is at: /var/lib/dev-host/pnpm/store'"
  start cache-2 -v "$WORK/c2:/workspace:ro" -v "$VOLUME:/var/lib/dev-host/pnpm"
  check "second container reaches state ok" poll 300 state_is cache-2 ok
  check "second container reuses the packages from the first" \
    bash -c "docker logs $(cn cache-2) 2>&1 | grep -Eq 'reused [1-9][0-9]*, downloaded 0'"
}

# ---- run ----------------------------------------------------------------------

if [ "$VARIANT" = demo ]; then
  test_demo
else
  test_host
  test_waiting
  test_api_proxy
  test_custom_caddyfile
  test_shared_cache
fi
