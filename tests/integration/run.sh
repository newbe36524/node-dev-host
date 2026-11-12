#!/usr/bin/env bash
# Integration tests for the node-dev-host image.
#
#   tests/integration/run.sh <image> <target>
#     <image>   a local image tag, for example node-dev-host:test-host
#     <target>  the Dockerfile target it was built from: host, demo, host-alpine or demo-alpine
#
# Each scenario starts a real container, waits for dev-host to build, and checks what Caddy serves.
# The control scenarios (test_control_*) start the same image with the argument `control` and the
# Docker socket mounted, then check its API, guards, actions and the built dashboard.
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

# ---- control node -------------------------------------------------------------
# The control node is the same image started with the argument `control`. It needs the Docker socket,
# and it carries no node-dev-host.port label, so it never lists or manages itself.

# start_control SHORT [docker run options...]: starts $IMAGE in control mode on a registered port.
start_control() {
  local name port
  name="$(cn "$1")"; shift
  CONTAINERS+=("$name")
  for _ in 1 2 3 4 5; do
    port="$(pick_port "$name")" || { fail "no free port for $name"; return 1; }
    if docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
         --label node-dev-host.role=control "$@" "$IMAGE" control >/dev/null 2>&1; then
      check "port $port for $name is in 43100-43299" in_range "$port"
      return 0
    fi
    docker rm -f "$name" >/dev/null 2>&1
  done
  fail "could not start $name after 5 tries"
  return 1
}

# code SHORT METHOD PATH [curl options...]: the HTTP status code of one request to a container.
code()  { local short="$1" method="$2" p="$3"; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$method" "$@" "$(url "$short" "$p")"; }
# reply SHORT METHOD PATH [curl options...]: the body of one request to a container.
reply() { local short="$1" method="$2" p="$3"; shift 3; curl -s -X "$method" "$@" "$(url "$short" "$p")"; }
# guarded_code / guarded_reply: a state-changing request with the Origin and control header the node expects.
guarded_code()  { local short="$1"; shift; code "$short" "$@" -H "Origin: http://127.0.0.1:$(port "$short")" -H 'X-Dev-Host-Control: 1'; }
guarded_reply() { local short="$1"; shift; reply "$short" "$@" -H "Origin: http://127.0.0.1:$(port "$short")" -H 'X-Dev-Host-Control: 1'; }

cstate()    { docker inspect -f '{{.State.Status}}' "$(cn "$1")" 2>/dev/null; }
cstate_is() { [ "$(cstate "$1")" = "$2" ]; }
clabel()    { docker inspect -f '{{index .Config.Labels "node-dev-host.port"}}' "$(cn "$1")" 2>/dev/null; }
body_any()  { curl -s "$(url "$1" "$2")" | grep -q -- "$3"; }
extra_host_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: devbox.local:$(port "$1")" "$(url "$1" /__dev-host/status.json)")" = 200 ]; }
# rows SHORT: one line per row the control node lists: "name docker-state build-state".
rows() {
  curl -fsS "$(url "$1" /api/containers)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).containers)console.log(c.name,c.state,c.build.state)})'
}
row_is()     { local out; out="$(rows "$1")" && grep -qx -- "$(cn "$2") $3 $4" <<<"$out"; }
not_listed() { local out; out="$(rows "$1")" && ! grep -q -- "$(cn "$2")" <<<"$out"; }
paused_message_is_shown() { guarded_reply act-ctrl POST "/api/containers/$(cn "$1")/start" | grep -q paused; }
gone() { local names; names="$(docker ps -a --format '{{.Names}}')"; ! grep -qx -- "$(cn "$1")" <<<"$names"; }
no_port_label() { local names; names="$(docker ps -a --filter label=node-dev-host.port --format '{{.Names}}')"; ! grep -qx -- "$(cn "$1")" <<<"$names"; }

test_control_runtime() {
  log "control: starts in control mode, answers health, and refuses bad requests before any Docker call"
  fresh_project rt
  start rt-target -v "$WORK/rt:/workspace:ro"
  check "target project container reaches state ok" poll 300 state_is rt-target ok
  start_control rt-ctrl -v /var/run/docker.sock:/var/run/docker.sock
  check "control container becomes healthy" poll 120 healthy rt-ctrl
  check "status.json reports state ok and role control" body_has rt-ctrl /__dev-host/status.json '"role":"control"'

  check "a foreign Host is rejected (403)" [ "$(code rt-ctrl GET /api/containers -H 'Host: attacker.example')" = 403 ]
  check "a cross-site POST is rejected (403)" \
    [ "$(code rt-ctrl POST "/api/containers/$(cn rt-target)/stop" -H 'Origin: http://evil.example' -H 'X-Dev-Host-Control: 1')" = 403 ]
  check "a POST without the control header is rejected (403)" \
    [ "$(code rt-ctrl POST "/api/containers/$(cn rt-target)/stop" -H "Origin: http://127.0.0.1:$(port rt-ctrl)")" = 403 ]
  check "the target is still running after the refused requests" cstate_is rt-target running

  start_control rt-allowed -e CONTROL_ALLOWED_HOSTS=devbox.local -v /var/run/docker.sock:/var/run/docker.sock
  check "an extra allowed host is accepted" poll 60 extra_host_ok rt-allowed
  check "the same Host is refused when it is not allowed (403)" \
    [ "$(code rt-ctrl GET /__dev-host/status.json -H "Host: devbox.local:$(port rt-ctrl)")" = 403 ]

  log "control: without the Docker socket"
  start_control rt-nosock
  check "status.json names the missing socket mount" poll 60 body_any rt-nosock /__dev-host/status.json 'Mount it with -v /var/run/docker.sock'
  check "the list answers 503 when Docker is unreachable" [ "$(code rt-nosock GET /api/containers)" = 503 ]
}

test_control_dashboard_api() {
  log "control: lists labelled containers with Docker and build state, logs, and serves the dashboard"
  fresh_project dash
  start dash-a -v "$WORK/dash:/workspace:ro"
  start dash-b -v "$WORK/dash:/workspace:ro"
  check "dash-a reaches state ok" poll 300 state_is dash-a ok
  check "dash-b reaches state ok" poll 300 state_is dash-b ok
  docker stop "$(cn dash-b)" >/dev/null
  CONTAINERS+=("$(cn plain)")
  docker run -d --name "$(cn plain)" --entrypoint sleep "$IMAGE" 600 >/dev/null
  start_control dash-ctrl -v /var/run/docker.sock:/var/run/docker.sock

  check "the list shows the running labelled container with build state ok" poll 60 row_is dash-ctrl dash-a running ok
  check "the list shows the stopped labelled container as exited, build state unknown" row_is dash-ctrl dash-b exited unknown
  check "the unlabelled container is not listed" not_listed dash-ctrl plain
  check "the control container does not list itself" not_listed dash-ctrl dash-ctrl
  check "the list reports readOnly false" body_has dash-ctrl /api/containers '"readOnly":false'

  touch "$WORK/dash/BREAK"
  check "a failed build shows as failed in the list" poll 180 row_is dash-ctrl dash-a running failed
  rm -f "$WORK/dash/BREAK"
  check "the list shows ok again after the next good build" poll 180 row_is dash-ctrl dash-a running ok

  check "logs of a running container show the dev-host build lines" body_has dash-ctrl "/api/containers/$(cn dash-a)/logs" '\[dev-host'
  check "logs of a stopped container show its stored lines" body_has dash-ctrl "/api/containers/$(cn dash-b)/logs" '\[dev-host'
  check "tail=5000 returns at most 1000 lines" [ "$(reply dash-ctrl GET "/api/containers/$(cn dash-a)/logs?tail=5000" | wc -l)" -le 1000 ]

  check "GET / serves the built dashboard" body_has dash-ctrl / '/assets/'
  local asset
  asset="$(curl -fsS "$(url dash-ctrl /)" | grep -o '/assets/[^"]*\.js' | head -n1)"
  check "a built asset is served with 200" [ "$(code dash-ctrl GET "$asset")" = 200 ]
  check "an SPA path serves the same page" [ "$(reply dash-ctrl GET /some/route)" = "$(reply dash-ctrl GET /)" ]
  check "an unknown /api path is a JSON 404" [ "$(code dash-ctrl GET /api/nope)" = 404 ]
  check "status.json still reports state ok" body_has dash-ctrl /__dev-host/status.json '"state":"ok"'
}

test_control_actions() {
  log "control: start, stop, restart, rebuild and remove act only on labelled containers"
  fresh_project act
  start act-a -v "$WORK/act:/workspace:ro"
  check "act-a reaches state ok" poll 300 state_is act-a ok
  CONTAINERS+=("$(cn plain)")
  docker run -d --name "$(cn plain)" --entrypoint sleep "$IMAGE" 600 >/dev/null
  start_control act-ctrl -v /var/run/docker.sock:/var/run/docker.sock
  check "the control node answers the list" poll 60 body_has act-ctrl /api/containers '"readOnly"'

  log "control: refusals"
  check "an unlabelled container is refused for stop (403)" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn plain)/stop")" = 403 ]
  check "an unlabelled container is refused for remove (403)" [ "$(guarded_code act-ctrl DELETE "/api/containers/$(cn plain)")" = 403 ]
  check "the control container is refused (403)" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-ctrl)/stop")" = 403 ]
  check "a missing container is refused (404)" [ "$(guarded_code act-ctrl POST /api/containers/ndit-missing/stop)" = 404 ]
  check "an unknown action is refused (400)" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/exec")" = 400 ]
  check "the unlabelled container is still running" cstate_is plain running
  check "the control container is still running" cstate_is act-ctrl running

  log "control: stop, start and restart keep the port and labels"
  local port_before
  port_before="$(clabel act-a)"
  check "stop answers 200" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/stop")" = 200 ]
  check "a stopped container is exited" poll 30 cstate_is act-a exited
  check "start answers 200" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/start")" = 200 ]
  check "a started container is running again" poll 30 cstate_is act-a running
  check "start keeps the same port label" [ "$(clabel act-a)" = "$port_before" ]
  check "restart answers 200" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/restart")" = 200 ]
  check "a restarted container is running" poll 30 cstate_is act-a running

  log "control: a Docker error comes back as a message"
  docker pause "$(cn act-a)" >/dev/null
  check "starting a paused container answers 409" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/start")" = 409 ]
  check "the message names the paused state" paused_message_is_shown act-a
  docker unpause "$(cn act-a)" >/dev/null
  check "the container runs again after unpause" poll 30 cstate_is act-a running

  log "control: rebuild runs dev-host rebuild in the container"
  check "act-a is ok before the rebuild" poll 300 state_is act-a ok
  local before
  before="$(builds act-a)"
  check "rebuild answers 202" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/rebuild")" = 202 ]
  check "the container's build count goes up" poll 180 builds_above act-a "$before"
  docker stop "$(cn act-a)" >/dev/null
  check "rebuild of a stopped container is refused (409)" [ "$(guarded_code act-ctrl POST "/api/containers/$(cn act-a)/rebuild")" = 409 ]
  check "the stopped container stays exited" cstate_is act-a exited
  docker start "$(cn act-a)" >/dev/null
  check "act-a is ok again after it starts" poll 300 state_is act-a ok

  log "control: remove deletes a labelled container and frees its port"
  start act-temp
  check "remove answers 200" [ "$(guarded_code act-ctrl DELETE "/api/containers/$(cn act-temp)")" = 200 ]
  check "the container is gone from docker ps -a" poll 30 gone act-temp
  check "its port label no longer appears" no_port_label act-temp

  log "control: read-only mode rejects every change and still lists"
  start_control act-ro -e CONTROL_READONLY=true -v /var/run/docker.sock:/var/run/docker.sock
  check "read-only mode is reported" poll 60 body_has act-ro /api/containers '"readOnly":true'
  check "a stop is rejected (403)" [ "$(guarded_code act-ro POST "/api/containers/$(cn act-a)/stop")" = 403 ]
  check "the container keeps running" cstate_is act-a running
  check "the list still shows the container" poll 60 row_is act-ro act-a running ok
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
test_control_runtime
test_control_dashboard_api
test_control_actions
