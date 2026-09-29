#!/usr/bin/env bash
# Start/stop the host-side development processes (API+worker, runner and,
# optionally, the git fixture) with pid files under .tmp/pids.
#
#   scripts/dev-procs.sh start [api|runner|fixture|all]
#   scripts/dev-procs.sh stop  [api|runner|fixture|all]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pids="$root/.tmp/pids"; logs="$root/.tmp/logs"
mkdir -p "$pids" "$logs"

start_one() {
  local name=$1; shift
  if [[ -f "$pids/$name" ]] && kill -0 "$(cat "$pids/$name")" 2>/dev/null; then echo "$name already running"; return; fi
  ( "$@" >"$logs/$name.log" 2>&1 & echo $! >"$pids/$name" )
  echo "started $name (pid $(cat "$pids/$name"), log .tmp/logs/$name.log)"
}

stop_one() {
  local name=$1
  if [[ -f "$pids/$name" ]]; then
    local pid; pid=$(cat "$pids/$name")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    rm -f "$pids/$name"; echo "stopped $name"
  fi
}

run() {
  local action=$1 what=${2:-all}
  set -a; source "$root/.env"; set +a
  for svc in fixture runner api; do
    [[ "$what" == all || "$what" == "$svc" ]] || continue
    if [[ $action == stop ]]; then stop_one "$svc"; continue; fi
    case $svc in
      fixture)
        [[ -n "${RUNNER_GIT_INSECURE_HTTP_HOSTS:-}" ]] || continue
        [[ -d "$root/.tmp/fixture/demo" ]] || "$root/scripts/make-fixture-repo.sh" "$root/.tmp/fixture" >/dev/null
        start_one fixture "$root/services/runner/bin/gitfixture" -root "$root/.tmp/fixture" -addr "${RUNNER_GIT_INSECURE_HTTP_HOSTS%%,*}" ;;
      runner)
        (cd "$root/services/runner" && go build -o bin/runner ./cmd/runner && go build -o bin/gitfixture ./cmd/gitfixture)
        mkdir -p "${RUNNER_WORK_DIR:-$root/.tmp/runner-work}"
        start_one runner "$root/services/runner/bin/runner" ;;
      api)
        start_one api env -C "$root/apps/api" DEPLOYFORGE_ENV_FILE="$root/.env" node dist/main.js ;;
    esac
  done
}

case ${1:-} in
  start|stop) run "$1" "${2:-all}" ;;
  restart) run stop "${2:-all}"; run start "${2:-all}" ;;
  *) echo "usage: $0 start|stop|restart [api|runner|fixture|all]"; exit 2 ;;
esac
