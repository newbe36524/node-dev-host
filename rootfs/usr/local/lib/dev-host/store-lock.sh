# node-dev-host: serialises pnpm store access between containers that share one store volume.
#
# Installs take a shared lock: several containers may install at once, pnpm handles that. `pnpm store prune`
# takes an exclusive lock: it waits for every install and blocks new ones while it runs. Without this, a prune
# in one container deletes files that another container's install is importing, and that install fails with
# "No such file or directory".
#
# Sourced by dev-host and by the unit tests. STORE_LOCK names the lock file; it sits next to the store folder,
# so every container that mounts the same store volume uses the same file.

: "${STORE_LOCK:=${PNPM_CONFIG_STORE_DIR:-/var/lib/dev-host/pnpm/store}.lock}"

# with_store_lock shared|exclusive COMMAND [ARGS...]: runs COMMAND while holding the lock. The exit status of
# COMMAND is returned. When flock is missing or the lock file cannot be opened, COMMAND runs without the lock
# and a line on stderr says so.
with_store_lock() {
  local mode="$1" flag
  shift
  case "$mode" in
    shared) flag=-s ;;
    exclusive) flag=-x ;;
    *) echo "with_store_lock: mode must be shared or exclusive" >&2; return 2 ;;
  esac
  (
    # The folder may not exist yet (a container without the store volume). The redirection's own error goes to
    # /dev/null too, because it is inside the braces.
    mkdir -p "$(dirname "$STORE_LOCK")" 2>/dev/null
    if command -v flock >/dev/null 2>&1 && { exec 9>>"$STORE_LOCK"; } 2>/dev/null; then
      if ! flock "$flag" 9; then
        echo "[store-lock] could not take the lock on $STORE_LOCK, running without it" >&2
      fi
    else
      echo "[store-lock] no lock available on $STORE_LOCK, running without it" >&2
    fi
    "$@"
  )
}
