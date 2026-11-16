#!/usr/bin/env bash
# Real-Docker acceptance suite for DeployForge.
#
#   scripts/acceptance.sh all      # build, start, run the scenario, keep stack up
#   scripts/acceptance.sh up       # build and start the acceptance stack
#   scripts/acceptance.sh run      # run the scenario against a running stack
#   scripts/acceptance.sh down     # stop and delete the acceptance stack and its data
#
# The stack is a full Compose installation (project "deployforge-acceptance",
# instance ID "acceptance") plus a hermetic git server with the sample app's
# release commits. It uses its own control network and ownership labels, so it
# can share a Docker daemon with another DeployForge installation.
#
# Behind a TLS-intercepting proxy, set DEPLOYFORGE_BUILD_CA=/path/to/ca.pem so
# image builds can download dependencies.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/.tmp/acceptance"
envf="$work/.env"
project=deployforge-acceptance
compose() { docker compose -p "$project" -f "$root/infra/compose.yaml" -f "$root/infra/compose.acceptance.yaml" --env-file "$envf" "$@"; }

rand() { head -c "$1" /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

write_env() {
  mkdir -p "$work"
  [[ -f "$envf" ]] && return
  cat >"$envf" <<EOF
NODE_ENV=production
DEPLOYFORGE_INSTANCE_ID=acceptance
DEPLOYFORGE_CONTROL_NETWORK=deployforge-acceptance-control
PUBLIC_URL=http://deploy.acceptance.localhost:18080
DASHBOARD_HOSTNAME=deploy.acceptance.localhost
DASHBOARD_UPSTREAM=api:3000
TRUST_PROXY=true
SETUP_TOKEN=$(rand 32)
SESSION_SECRET=$(rand 48)
DEPLOYFORGE_MASTER_KEYS=k1:$(head -c 32 /dev/urandom | base64)
DEPLOYFORGE_ACTIVE_KEY_ID=k1
RUNNER_SHARED_SECRET=$(rand 48)
PROXY_PROBE_TOKEN=$(rand 32)
POSTGRES_PASSWORD=$(rand 32)
APPS_DOMAIN=acceptance.localhost
APPS_URL_SCHEME=http
APPS_PUBLIC_PORT=18080
TLS_MODE=off
HTTP_PORT=18080
HTTPS_PORT=18443
DRAIN_SECONDS=5
LEASE_SECONDS=20
RECONCILE_INTERVAL_SECONDS=15
RELEASES_TO_RETAIN=5
GITHUB_MODE=disabled
ACCEPTANCE_FIXTURE_DIR=$work/fixture
DEPLOYFORGE_BUILD_CA=${DEPLOYFORGE_BUILD_CA:-$root/infra/build-ca.empty}
EOF
  chmod 600 "$envf"
}

up() {
  write_env
  if [[ ! -f "$work/fixture/shas.json" ]]; then "$root/scripts/make-fixture-repo.sh" "$work/fixture" >/dev/null; fi
  compose up -d --build --wait --wait-timeout 300
  echo "Waiting for the dashboard route through Caddy…"
  for _ in $(seq 1 90); do
    if curl -sf -H 'Host: deploy.acceptance.localhost' http://127.0.0.1:18080/readyz >/dev/null; then echo "ready"; return; fi
    sleep 2
  done
  echo "stack did not become ready" >&2
  compose ps
  exit 1
}

run() {
  write_env
  ACCEPTANCE_ENV="$envf" ACCEPTANCE_PROJECT="$project" ACCEPTANCE_ROOT="$root" python3 "$root/scripts/acceptance.py"
}

down() {
  [[ -f "$envf" ]] || { echo "nothing to do"; return; }
  compose down -v --remove-orphans
  # Remove application resources owned by the acceptance instance only.
  docker ps -aq --filter label=io.deployforge.instance=acceptance | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter label=io.deployforge.instance=acceptance | xargs -r docker network rm >/dev/null
  docker images -q --filter label=io.deployforge.instance=acceptance | sort -u | xargs -r docker rmi -f >/dev/null || true
  rm -rf "$work"
}

case "${1:-all}" in
  up) up ;;
  run) run ;;
  down) down ;;
  all) up; run ;;
  *) echo "usage: $0 all|up|run|down"; exit 2 ;;
esac
