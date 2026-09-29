#!/usr/bin/env bash
# Run the Go runner on the host for local development (requires access to the
# Docker socket). Reads RUNNER_SHARED_SECRET and RUNNER_WORK_DIR from .env.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$root/.env"; set +a
mkdir -p "${RUNNER_WORK_DIR:-$root/.tmp/runner-work}"
cd "$root/services/runner"
exec go run ./cmd/runner
