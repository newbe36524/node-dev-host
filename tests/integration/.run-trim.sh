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
REG_PID=""
SLOW_VOLUME=""
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
  [ -n "$SLOW_VOLUME" ] && docker volume rm "$SLOW_VOLUME" >/dev/null 2>&1
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  [ -n "$REG_PID" ] && kill "$REG_PID" 2>/dev/null
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
    local err
    if err="$(docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
         --label "node-dev-host.port=$port" --label "node-dev-host.name=$name" \
         "$@" "$IMAGE" 2>&1 >/dev/null)"; then
      check "port $port for $name is in 43100-43299" in_range "$port"
      return 0
    fi
    printf '        docker run on port %s failed: %s\n' "$port" "$err"
    docker rm -f "$name" >/dev/null 2>&1
  done
  fail "could not start $name after 5 tries"
  return 1
}
port()    { docker port "$(cn "$1")" 8080/tcp | head -n1 | sed 's/.*://'; }
url()     { echo "http://127.0.0.1:$(port "$1")$2"; }
status()  { docker exec "$(cn "$1")" dev-host status 2>/dev/null; }
state()   { status "$1" | sed -n 's/^{"state":"\([a-z]*\)".*/\1/p'; }
builds()  { status "$1" | sed -n 's/.*"builds":\([0-9]*\).*/\1/p'; }
# service_field SHORT FIELD: one field of the status "service" object (empty when there is none).
service_field() { status "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).service?.[process.argv[1]];console.log(v ?? "")})' "$2"; }

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

service_pid_differs()      { [ "$(service_field service pid)" != "$1" ]; }
service_restarts_at_least() { [ "$(service_field service restarts)" -ge "$1" ]; }

test_service() {
  log "service: a process started from the workspace config serves /api/*, and a build or a crash restarts it"
  fresh_project service
  printf 'version: 1\nservice:\n  command: node server.mjs\n  port: 3311\n' > "$WORK/service/.node-dev-host.yaml"
  cat > "$WORK/service/server.mjs" <<'SERVER'
import http from 'node:http';
http.createServer((q, s) => {
  s.setHeader('content-type', 'application/json');
  s.end(JSON.stringify({ from: 'service', mark: process.env.SERVICE_MARK, host: process.env.HOST, port: process.env.PORT, path: q.url }));
}).listen(Number(process.env.PORT), process.env.HOST);
SERVER
  start service -v "$WORK/service:/workspace:ro" -e SERVICE_MARK=from-env
  check "reaches state ok" poll 300 state_is service ok
  check "/api/hello reaches the service" poll 60 body_has service /api/hello '"from":"service"'
  check "the service gets PORT and HOST=127.0.0.1" body_has service /api/hello '"host":"127.0.0.1","port":"3311"'
  check "the container environment reaches the service" body_has service /api/hello '"mark":"from-env"'
  check "other paths are still served from the build" body_has service / marker-v1
  check "status shows the running service" [ "$(service_field service state)" = running ]

  local pid before
  pid="$(service_field service pid)"
  before="$(builds service)"
  docker exec "$(cn service)" dev-host rebuild >/dev/null
  check "the rebuild finishes" poll 120 builds_above service "$before"
  check "a successful build starts the service again with a new pid" poll 60 service_pid_differs "$pid"
  check "the restarted service answers" poll 60 body_has service /api/again '"from":"service"'

  pid="$(service_field service pid)"
  docker exec "$(cn service)" bash -c "kill -9 $pid"
  check "a service that exits is restarted and the restart is counted" poll 60 service_restarts_at_least 1
  check "the service answers after the restart" poll 60 body_has service /api/after-crash '"from":"service"'
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
    local err
    if err="$(docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
         --label node-dev-host.role=control "$@" "$IMAGE" control 2>&1 >/dev/null)"; then
      check "port $port for $name is in 43100-43299" in_range "$port"
      return 0
    fi
    printf '        docker run on port %s failed: %s\n' "$port" "$err"
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
  curl -fsS "$(url "$1" /api/containers)" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).containers)console.log(c.name,c.state,c.build.state)})' 2>/dev/null
}
row_is()     { local out; out="$(rows "$1")" && grep -qx -- "$(cn "$2") $3 $4" <<<"$out"; }
not_listed() { local out; out="$(rows "$1")" && awk -v name="$(cn "$2")" '$1 == name { found=1 } END { if (found) exit 1; exit 0 }' <<<"$out"; }
row_registered() {
  curl -fsS "$(url "$1" /api/containers)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).containers.find(c=>c.name===process.argv[1]);process.exit(r&&r.registered===(process.argv[2]==="true")?0:1)})' \
      "$(cn "$2")" "$3"
}
row_schedule_is() {
  curl -fsS "$(url "$1" /api/containers)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).containers.find(c=>c.name===process.argv[1]);process.exit(r?.schedule?.state===process.argv[2]?0:1)})' \
      "$(cn "$2")" "$3"
}
# row_phase_is SHORT NAME PHASE: the row's operation is in PHASE (pulling, creating, starting or removing).
row_phase_is() {
  curl -fsS "$(url "$1" /api/containers)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).containers.find(c=>c.name===process.argv[1]);process.exit(r?.operation?.phase===process.argv[2]?0:1)})' \
      "$(cn "$2")" "$3"
}
# row_failed_is SHORT NAME: the row is not created, has no operation in progress, and keeps an error.
row_failed_is() {
  curl -fsS "$(url "$1" /api/containers)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).containers.find(c=>c.name===process.argv[1]);process.exit(r&&r.state==="not created"&&!r.operation&&typeof r.error==="string"&&r.error.length>0?0:1)})' \
      "$(cn "$2")"
}
scan_skipped() {
  local result
  result="$(guarded_reply "$1" POST /api/scan)" &&
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.exit(v.skipped.some(x=>x.name===process.argv[1]&&x.reason===process.argv[2])?0:1)})' \
      "$(cn "$2")" "$3" <<<"$result"
}
paused_message_is_shown() { guarded_reply act-ctrl POST "/api/containers/$(cn "$1")/start" | grep -q paused; }
gone() { local names; names="$(docker ps -a --format '{{.Names}}')"; ! grep -qx -- "$(cn "$1")" <<<"$names"; }
no_port_label() { local names; names="$(docker ps -a --filter label=node-dev-host.port --format '{{.Names}}')"; ! grep -qx -- "$(cn "$1")" <<<"$names"; }
json_error_has() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.exit(typeof v.error==="string"&&v.error.includes(process.argv[1])?0:1)})' "$2" <<<"$1"
}

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
  local extra_name extra_port
  extra_name="$(cn dash-extra)"
  extra_port="$(pick_port "$extra_name")"
  CONTAINERS+=("$extra_name")
  docker create --name "$extra_name" -p "127.0.0.1:$extra_port:8080" \
    --label "node-dev-host.port=$extra_port" --label "node-dev-host.name=$extra_name" \
    -v "$WORK/dash:/workspace:ro" -v /etc:/etc:ro "$IMAGE" >/dev/null
  check "dash-a reaches state ok" poll 300 state_is dash-a ok
  check "dash-b reaches state ok" poll 300 state_is dash-b ok
  docker stop "$(cn dash-b)" >/dev/null
  CONTAINERS+=("$(cn dash-plain)")
  docker run -d --name "$(cn dash-plain)" --entrypoint sleep "$IMAGE" 600 >/dev/null
  start_control dash-ctrl -v /var/run/docker.sock:/var/run/docker.sock

  check "the list shows the running labelled container with build state ok" poll 60 row_is dash-ctrl dash-a running ok
  check "the list shows the stopped labelled container as exited, build state unknown" row_is dash-ctrl dash-b exited unknown
  check "the unlabelled container is not listed" not_listed dash-ctrl dash-plain
  check "the control container does not list itself" not_listed dash-ctrl dash-ctrl
  check "the list reports readOnly false" body_has dash-ctrl /api/containers '"readOnly":false'
  check "the startup scan imports a labelled container without an auto-start window" \
    poll 60 row_registered dash-ctrl dash-a true
  check "the imported node starts unscheduled" row_schedule_is dash-ctrl dash-a none
  check "a labelled container with an /etc bind stays listed but is not imported" \
    row_registered dash-ctrl dash-extra false
  check "the scan reports the unsupported /etc mount" scan_skipped dash-ctrl dash-extra "unsupported mount: /etc"

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

test_control_nodes() {
  log "control: add nodes through the guarded API, create and recreate containers, and persist records"
  docker volume create "$VOLUME" >/dev/null
  fresh_project node-workspace
  start_control nodes-ctrl \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUME:/var/lib/dev-host/control"
  check "the control node lists its data directory" poll 60 body_any nodes-ctrl /api/containers '"persistence"'
  check "the default data directory is reported" body_any nodes-ctrl /api/containers '"dir":"/var/lib/dev-host/control"'

  local control_url next_port node_port node_name body invalid_body invalid_response
  local ended_name ended_port ended_body readonly_name readonly_port readonly_body
  control_url="$(url nodes-ctrl "")"
  next_port="$(curl -fsS "$control_url/api/containers" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')"
  node_port="$next_port"
  if [ "$node_port" = "$(port nodes-ctrl)" ]; then
    node_port=$((node_port + 1))
    [ "$node_port" -le 43299 ] || node_port=43100
  fi
  node_name="$(cn lifecycle)"
  body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],workspace:process.argv[2],port:Number(process.argv[3]),image:process.argv[4]}))' \
    "$node_name" "$WORK/node-workspace" "$node_port" "$IMAGE")"

  check "an add without Origin is rejected (403)" \
    [ "$(code nodes-ctrl POST /api/nodes -H 'X-Dev-Host-Control: 1' -H 'Content-Type: application/json' --data "$body")" = 403 ]
  check "an add without the control header is rejected (403)" \
    [ "$(code nodes-ctrl POST /api/nodes -H "Origin: $control_url" -H 'Content-Type: application/json' --data "$body")" = 403 ]
  check "an add with the wrong content type is rejected (415)" \
    [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: text/plain' --data "$body")" = 415 ]

  invalid_body="$(node -e 'const body=JSON.parse(process.argv[1]);body.name += "-invalid";body.port=43300;console.log(JSON.stringify(body))' "$body")"
  invalid_response="$(guarded_reply nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$invalid_body")"
  check "an out-of-range port answers 400" [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$invalid_body")" = 400 ]
  check "the out-of-range port response is JSON with an error" json_error_has "$invalid_response" "43100-43299"

  check "the documented guarded add answers 201" \
    [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$body")" = 201 ]
  check "a repeated add is rejected (409)" \
    [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$body")" = 409 ]
  check "Start with autoStart answers 202" \
    [ "$(guarded_code nodes-ctrl POST "/api/containers/$node_name/start" -H 'Content-Type: application/json' --data '{"autoStart":true}')" = 202 ]
  check "Start with autoStart saves an active window" poll 30 body_any nodes-ctrl /api/containers '"state":"active"'
  check "start creates and builds a container from the local test image" poll 420 row_is nodes-ctrl lifecycle running ok

  check "recreate answers 202" [ "$(guarded_code nodes-ctrl POST "/api/containers/$node_name/recreate")" = 202 ]
  check "recreate returns the node to running" poll 420 row_is nodes-ctrl lifecycle running ok
  remove_reply="$(guarded_reply nodes-ctrl DELETE "/api/containers/$node_name" -w '\n%{http_code}')"
  remove_status="${remove_reply##*$'\n'}"
  [ "$remove_status" = 200 ] || printf '  Remove container answered %s: %s\n' "$remove_status" "${remove_reply%$'\n'*}"
  check "Remove container answers 200" [ "$remove_status" = 200 ]
  check "Remove container keeps the saved node record" poll 60 row_is nodes-ctrl lifecycle "not created" unknown

  ended_name="$(cn lifecycle-ended)"
  ended_port="$(curl -fsS "$(url nodes-ctrl /api/containers)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')"
  ended_body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],workspace:process.argv[2],port:Number(process.argv[3]),image:process.argv[4]}))' \
    "$ended_name" "$WORK/node-workspace" "$ended_port" "$IMAGE")"
  check "an additional node can be recorded for an ended startup window" \
    [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$ended_body")" = 201 ]
  docker exec "$(cn nodes-ctrl)" node -e \
    'const fs=require("node:fs");const p=process.argv[1];const name=process.argv[2];const data=JSON.parse(fs.readFileSync(p,"utf8"));const node=data.nodes.find((item)=>item.name===name);if(!node)process.exit(1);node.autoStartUntil=new Date(Date.now()-60000).toISOString();fs.writeFileSync(p,JSON.stringify(data))' \
    /var/lib/dev-host/control/nodes.json "$ended_name"

  docker rm -f "$(cn nodes-ctrl)" >/dev/null
  start_control nodes-ctrl \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUME:/var/lib/dev-host/control"
  check "the record survives control-container recreation and its active window starts the node" \
    poll 420 row_is nodes-ctrl lifecycle running ok
  check "a node with an ended startup window stays uncreated" \
    row_is nodes-ctrl lifecycle-ended "not created" unknown
  check "the ended window remains ended" row_schedule_is nodes-ctrl lifecycle-ended ended
  check "startup does not create the ended node's container" gone lifecycle-ended

  readonly_name="$(cn readonly-active)"
  readonly_port="$(curl -fsS "$(url nodes-ctrl /api/containers)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')"
  readonly_body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],workspace:process.argv[2],port:Number(process.argv[3]),image:process.argv[4]}))' \
    "$readonly_name" "$WORK/node-workspace" "$readonly_port" "$IMAGE")"
  check "an active but uncreated node can be recorded" \
    [ "$(guarded_code nodes-ctrl POST /api/nodes -H 'Content-Type: application/json' --data "$readonly_body")" = 201 ]
  check "the second node gets an active startup window" \
    [ "$(guarded_code nodes-ctrl POST "/api/nodes/$readonly_name/auto-start")" = 200 ]
  start_control nodes-readonly -e CONTROL_READONLY=true \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUME:/var/lib/dev-host/control"
  check "read-only control node becomes ready" poll 60 body_any nodes-readonly /api/containers '"readOnly":true'
  check "read-only startup leaves an active node uncreated" \
    row_is nodes-readonly readonly-active "not created" unknown
  check "read-only startup preserves the active window" row_schedule_is nodes-readonly readonly-active active
  check "read-only startup does not create the active node's container" gone readonly-active
  check "Delete node answers 200" [ "$(guarded_code nodes-ctrl DELETE "/api/nodes/$node_name")" = 200 ]
  check "Delete node removes the container and its saved record" poll 60 not_listed nodes-ctrl lifecycle
  check "Delete node removes an ended record without a container" \
    [ "$(guarded_code nodes-ctrl DELETE "/api/nodes/$ended_name")" = 200 ]
  check "Delete node removes the active record left untouched by read-only startup" \
    [ "$(guarded_code nodes-ctrl DELETE "/api/nodes/$readonly_name")" = 200 ]

  check "read-only mode rejects node creation (403)" \
    [ "$(guarded_code nodes-readonly POST /api/nodes -H 'Content-Type: application/json' --data "$readonly_body")" = 403 ]
  check "read-only mode rejects extending auto-start (403)" \
    [ "$(guarded_code nodes-readonly POST "/api/nodes/$readonly_name/auto-start")" = 403 ]
  check "read-only mode rejects stopping auto-start (403)" \
    [ "$(guarded_code nodes-readonly DELETE "/api/nodes/$readonly_name/auto-start")" = 403 ]

  start_control nodes-readonly-store \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUME:/var/lib/dev-host/control:ro"
  check "control node with read-only storage becomes ready" poll 60 body_any nodes-readonly-store /api/containers '"readOnly":false'
  check "a non-writable node store rejects creation with 503" \
    [ "$(guarded_code nodes-readonly-store POST /api/nodes -H 'Content-Type: application/json' --data "$readonly_body")" = 503 ]
}

test_control_startup_pull() {
  log "control: a slow pull at startup does not block health, and a failed pull leaves the other node running"
  local reg_port ctrl slow_name good_name slow_port good_port slow_body good_body
  reg_port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  # Docker treats localhost as an insecure registry. The manifest request waits, then reports the image as unknown,
  # so the startup pull is slow and then fails, with no network access needed.
  cat > "$WORK/slow-registry.mjs" <<'EOF'
import http from 'node:http';
const port = Number(process.argv[2]);
const delay = Number(process.argv[3]);
http.createServer((req, res) => {
  const headers = { 'Docker-Distribution-Api-Version': 'registry/2.0', 'content-type': 'application/json' };
  if (req.url === '/v2/' || req.url.startsWith('/v2/?')) { res.writeHead(200, headers); return res.end('{}'); }
  setTimeout(() => {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }));
  }, delay);
}).listen(port, '127.0.0.1');
EOF
  node "$WORK/slow-registry.mjs" "$reg_port" 20000 >/dev/null 2>&1 &
  REG_PID=$!
  SLOW_VOLUME="ndit-$RUN-slow-data"
  docker volume create "$SLOW_VOLUME" >/dev/null
  fresh_project slow-workspace
  ctrl=nodes-slow-ctrl
  slow_name="$(cn slow-pull)"
  good_name="$(cn slow-good)"
  start_control "$ctrl" -e "CONTROL_ALLOWED_IMAGES=node-dev-host,localhost:$reg_port/nd-slow" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$SLOW_VOLUME:/var/lib/dev-host/control"

  # Docker's port proxy can accept a connection before the server listens, so wait for the server itself.
  check "the control node answers before the first request" poll 60 body_has "$ctrl" /__dev-host/status.json '"state":"ok"'
  slow_port="$(curl -fsS "$(url "$ctrl" /api/containers)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')"
  slow_body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],workspace:process.argv[2],port:Number(process.argv[3]),image:process.argv[4]}))' \
    "$slow_name" "$WORK/slow-workspace" "$slow_port" "localhost:$reg_port/nd-slow:latest")"
  check "the node whose image cannot be pulled is recorded" \
    [ "$(guarded_code "$ctrl" POST /api/nodes -H 'Content-Type: application/json' --data "$slow_body")" = 201 ]
  good_port="$(curl -fsS "$(url "$ctrl" /api/containers)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).nextPort)))')"
  good_body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],workspace:process.argv[2],port:Number(process.argv[3]),image:process.argv[4]}))' \
    "$good_name" "$WORK/slow-workspace" "$good_port" "$IMAGE")"
  check "the node with the local test image is recorded" \
    [ "$(guarded_code "$ctrl" POST /api/nodes -H 'Content-Type: application/json' --data "$good_body")" = 201 ]
  check "the failing node gets an active window" [ "$(guarded_code "$ctrl" POST "/api/nodes/$slow_name/auto-start")" = 200 ]
  check "the good node gets an active window" [ "$(guarded_code "$ctrl" POST "/api/nodes/$good_name/auto-start")" = 200 ]

  docker rm -f "$(cn "$ctrl")" >/dev/null
  start_control "$ctrl" -e "CONTROL_ALLOWED_IMAGES=node-dev-host,localhost:$reg_port/nd-slow" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$SLOW_VOLUME:/var/lib/dev-host/control"
  check "the restarted control node answers" poll 60 body_has "$ctrl" /__dev-host/status.json '"state":"ok"'
  check "the startup pass shows the slow pull on its row" poll 120 row_phase_is "$ctrl" slow-pull pulling
  check "the control node answers health during the slow pull" body_has "$ctrl" /__dev-host/status.json '"state":"ok"'
  check "the list answers during the slow pull" body_any "$ctrl" /api/containers '"containers"'
  check "the other node with an active window still starts" poll 420 row_is "$ctrl" slow-good running ok
  check "the failed pull leaves its node not created with the error on the row" poll 180 row_failed_is "$ctrl" slow-pull
  check "the failed node has no container" gone slow-pull
  check "the control node is still healthy after the failed pull" body_has "$ctrl" /__dev-host/status.json '"state":"ok"'

  check "Delete node answers 200 for the good node" [ "$(guarded_code "$ctrl" DELETE "/api/nodes/$good_name")" = 200 ]
  check "Delete node answers 200 for the failed node" [ "$(guarded_code "$ctrl" DELETE "/api/nodes/$slow_name")" = 200 ]
  kill "$REG_PID" 2>/dev/null
  REG_PID=""
}

# field NAME EXPRESSION: one value of the container's status.json. EXPRESSION sees the parsed object as j.
# Strings print bare; anything else prints as JSON.
field() {
  status "$1" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=eval(process.argv[1]);console.log(typeof r==="string"?r:JSON.stringify(r))})' "$2" 2>/dev/null
}

test_workspace_config() {
  log "workspace config: the file sets the name and ignores a directory; the status and the copy follow it"
  fresh_project wsconf
  cp "$FIXTURE/../workspace-config/.node-dev-host.yaml" "$WORK/wsconf/"
  mkdir -p "$WORK/wsconf/.browser-profile"
  echo cache > "$WORK/wsconf/.browser-profile/Cache_Data.bin"
  start wsconf -v "$WORK/wsconf:/workspace:ro"
  check "reaches state ok" poll 300 state_is wsconf ok
  check "status names the project" [ "$(field wsconf 'j.name')" = jjb ]
  check "status carries the description" [ "$(field wsconf 'j.description')" = "Personal JJB site" ]
  check "status names the configuration file" [ "$(field wsconf 'j.configSource')" = .node-dev-host.yaml ]
  check "status carries a 64-character configHash" [ "$(field wsconf 'j.configHash.length')" = 64 ]
  check "status lists the configured ignore entry" [ "$(field wsconf 'j.ignore')" = '[".browser-profile/"]' ]
  check ".browser-profile is absent from the build copy" docker exec "$(cn wsconf)" test ! -e /var/lib/dev-host/build/.browser-profile

  log "workspace config: creating, changing and deleting ignored files starts no build"
  local before i
  before="$(builds wsconf)"
  for i in 1 2 3; do
    echo "$i" > "$WORK/wsconf/.browser-profile/w$i.bin"; sleep 1
    echo "$i$i" >> "$WORK/wsconf/.browser-profile/Cache_Data.bin"
    rm -f "$WORK/wsconf/.browser-profile/w$i.bin"; sleep 1
  done
  sleep 15
  check "no build from the ignored files" [ "$(builds wsconf)" = "$before" ]
  echo "changed" > "$WORK/wsconf/public/extra.txt"
  check "a change to another file still rebuilds" poll 120 builds_above wsconf "$before"
  check "the change is served" poll 120 body_has wsconf /extra.txt changed

  log "workspace config: ten manual builds with the ignored directory written all the time"
  ( while :; do echo "$RANDOM" > "$WORK/wsconf/.browser-profile/churn.bin"; sleep 0.2; done ) &
  local writer=$! ok=0 warned=0 leftover=0 n
  for i in $(seq 1 10); do
    n="$(builds wsconf)"
    docker exec "$(cn wsconf)" dev-host rebuild >/dev/null
    poll 180 builds_above wsconf "$n" || true
    poll 120 state_is wsconf ok && ok=$((ok + 1))
    [ "$(field wsconf 'j.warnings.length')" = 0 ] || warned=$((warned + 1))
    docker exec "$(cn wsconf)" test ! -e /var/lib/dev-host/build/.browser-profile || leftover=$((leftover + 1))
  done
  kill "$writer" 2>/dev/null; wait "$writer" 2>/dev/null
  check "all ten manual builds end ok" [ "$ok" = 10 ]
  check "none carries a warning" [ "$warned" = 0 ]
  check ".browser-profile is absent from the build copy after each build" [ "$leftover" = 0 ]

  log "workspace config: adding an ignore entry purges a copy made before it; a rejected file keeps the last page"
  fresh_project wsadd
  mkdir -p "$WORK/wsadd/.browser-profile"
  echo cache > "$WORK/wsadd/.browser-profile/Cache_Data.bin"
  start wsadd -v "$WORK/wsadd:/workspace:ro"
  check "reaches state ok without a configuration" poll 300 state_is wsadd ok
  check "the first build copied .browser-profile" docker exec "$(cn wsadd)" test -e /var/lib/dev-host/build/.browser-profile
  before="$(builds wsadd)"
  cp "$FIXTURE/../workspace-config/.node-dev-host.yaml" "$WORK/wsadd/"
  check "the rule edit starts a build" poll 120 builds_above wsadd "$before"
  check "that build reaches ok" poll 120 state_is wsadd ok
  sleep 15
  check "exactly one build for the edit" [ "$(builds wsadd)" = "$((before + 1))" ]
  check ".browser-profile is purged from the copy" docker exec "$(cn wsadd)" test ! -e /var/lib/dev-host/build/.browser-profile
  check "node_modules survives the purge" docker exec "$(cn wsadd)" test -d /var/lib/dev-host/build/node_modules
  printf 'version: 1\nignor: [.cache-x/]\n' > "$WORK/wsadd/.node-dev-host.yaml"
  check "a rejected file fails the build" poll 180 state_is wsadd failed
  check "the reason names the unknown field" grep -q 'ignor' <<< "$(field wsadd 'j.configError')"
  check "the earlier page is still served" body_has wsadd / marker-v1
  cp "$FIXTURE/../workspace-config/.node-dev-host.yaml" "$WORK/wsadd/"
  check "a corrected file recovers to ok" poll 180 state_is wsadd ok
  check "configError is cleared" [ "$(field wsadd 'j.configError')" = null ]

  log "workspace config: BUILD_CMD from the environment beats build.command; a copy that loses files once is retried"
  fresh_project wsprec
  printf 'version: 1\nbuild:\n  command: "exit 1"\n' > "$WORK/wsprec/.node-dev-host.yaml"
  mkdir -p "$WORK/shim"
  cat > "$WORK/shim/rsync" <<'EOF'
#!/bin/sh
# Test shim: the first copy from the workspace exits 24 (files vanished); every other call is the real rsync.
case " $* " in
  *" --delete-excluded "*)
    if [ ! -e /var/lib/dev-host/shim-used ]; then
      touch /var/lib/dev-host/shim-used
      echo "rsync: shim reports files vanished" >&2
      exit 24
    fi ;;
esac
exec /usr/bin/rsync "$@"
EOF
  chmod +x "$WORK/shim/rsync"
  start wsprec -v "$WORK/wsprec:/workspace:ro" -v "$WORK/shim:/shim:ro" \
    -e "BUILD_CMD=pnpm build" \
    -e "PATH=/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  check "BUILD_CMD runs, so the failing build.command does not" poll 300 state_is wsprec ok
  check "the copy was retried once" docker exec "$(cn wsprec)" test -e /var/lib/dev-host/shim-used
  check "the retry is a warning on the status" grep -q retried <<< "$(field wsprec 'j.warnings.join("|")')"

  log "external folders: a read-write mount over data/covers is reached through a link; writes there start no build"
  fresh_project wsext
  mkdir -p "$WORK/wsext/data/covers" "$WORK/wsext-covers"
  echo seed > "$WORK/wsext-covers/seed.jpg"
  local ext_cfg plain_cfg
  ext_cfg='version: 1
external: [data/covers]
build:
  command: "node scripts/build.mjs && test -f data/covers/seed.jpg && echo built > data/covers/built.txt"'
  plain_cfg='version: 1
build:
  command: "node scripts/build.mjs && test -f data/covers/seed.jpg && echo built > data/covers/built.txt"'
  printf '%s\n' "$ext_cfg" > "$WORK/wsext/.node-dev-host.yaml"
  start wsext -v "$WORK/wsext:/workspace:ro" -v "$WORK/wsext-covers:/workspace/data/covers"
  check "reaches state ok" poll 300 state_is wsext ok
  check "the build wrote a new file through the link into the host folder" test -f "$WORK/wsext-covers/built.txt"
  check "the build copy holds a link at data/covers" docker exec "$(cn wsext)" test -L /var/lib/dev-host/build/data/covers
  check "status lists external" [ "$(field wsext 'j.external')" = '["data/covers"]' ]
  local before i
  before="$(builds wsext)"
  for i in 1 2 3; do echo "$i" > "$WORK/wsext-covers/cache-$i.jpg"; sleep 1; done
  rm -f "$WORK/wsext-covers/cache-1.jpg"
  sleep 15
  check "no build from creating and deleting files in the folder" [ "$(builds wsext)" = "$before" ]
  check "a file written into the folder is read through the link" docker exec "$(cn wsext)" test -f /var/lib/dev-host/build/data/covers/cache-2.jpg

  log "external folders: removing the entry copies the folder back and leaves the original intact"
  original_intact() { [ "$(cat "$WORK/wsext-covers/seed.jpg" 2>/dev/null)" = seed ] && [ -f "$WORK/wsext-covers/cache-2.jpg" ]; }
  printf '%s\n' "$plain_cfg" > "$WORK/wsext/.node-dev-host.yaml"
  check "the removal starts a build" poll 120 builds_above wsext "$before"
  check "that build reaches ok" poll 120 state_is wsext ok
  check "the build copy holds a real folder again" docker exec "$(cn wsext)" sh -c 'test -d /var/lib/dev-host/build/data/covers && test ! -L /var/lib/dev-host/build/data/covers'
  check "the original keeps its files" original_intact
  check "status no longer lists external" [ "$(field wsext 'j.external')" = '[]' ]

  log "external folders: adding the entry again replaces the stale real folder with a link"
  before="$(builds wsext)"
  printf '%s\n' "$ext_cfg" > "$WORK/wsext/.node-dev-host.yaml"
  check "the entry starts a build" poll 120 builds_above wsext "$before"
  check "that build reaches ok" poll 120 state_is wsext ok
  check "the stale folder is a link again" docker exec "$(cn wsext)" test -L /var/lib/dev-host/build/data/covers
  check "the original keeps its files" original_intact

  log "external folders: a read-only workspace fails a write through the link without failing the build; a missing original warns, then clears"
  fresh_project wsro
  mkdir -p "$WORK/wsro/data"
  cat > "$WORK/wsro/.node-dev-host.yaml" <<'EOF'
version: 1
external: [data/covers]
build:
  command: "node scripts/build.mjs && (echo x > data/covers/built.txt || echo refused > dist/refused.txt)"
EOF
  start wsro -v "$WORK/wsro:/workspace:ro"
  check "a missing original is a warning and the build still ends ok" poll 300 state_is wsro ok
  check "the warning names the entry" grep -q 'data/covers' <<< "$(field wsro 'j.warnings.join("|")')"
  check "status lists the entry" [ "$(field wsro 'j.external')" = '["data/covers"]' ]
  check "the write without a folder fails inside the build" body_has wsro /refused.txt refused
  mkdir -p "$WORK/wsro/data/covers"
  before="$(builds wsro)"
  docker exec "$(cn wsro)" dev-host rebuild >/dev/null
  check "the rebuild starts" poll 120 builds_above wsro "$before"
  check "that build reaches ok" poll 120 state_is wsro ok
  check "the link appears once the folder exists" docker exec "$(cn wsro)" test -L /var/lib/dev-host/build/data/covers
  check "the warning is gone" [ "$(field wsro 'j.warnings.length')" = 0 ]
  check "the write through the read-only link fails and the workspace is unchanged" test ! -e "$WORK/wsro/data/covers/built.txt"
}

test_service
