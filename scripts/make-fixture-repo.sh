#!/usr/bin/env bash
# Build the hermetic git fixture used by the Docker acceptance suite.
#
#   scripts/make-fixture-repo.sh <output-root>
#
# Creates <output-root>/demo/sample-app.git (bare) with one branch per sample
# release variant and writes <output-root>/shas.json. Test infrastructure only.
set -euo pipefail

out="${1:?usage: make-fixture-repo.sh <output-root>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME="DeployForge Fixture" GIT_AUTHOR_EMAIL="fixture@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_CONFIG_GLOBAL=/dev/null

git -C "$work" init -q -b main
cp "$here/examples/sample-app/server.js" "$here/examples/sample-app/Dockerfile" "$work/"

commit() { # <branch> <message>
  git -C "$work" add -A
  git -C "$work" commit -q -m "$2"
  if [ "$(git -C "$work" branch --show-current)" != "$1" ]; then git -C "$work" branch -f "$1" HEAD; fi
  git -C "$work" rev-parse HEAD
}

echo '{ "version": "A", "color": "#1d4ed8", "healthy": true }' > "$work/release.json"
A=$(commit release-a "Release A")
echo '{ "version": "B", "color": "#15803d", "healthy": true }' > "$work/release.json"
B=$(commit release-b "Release B")
echo '{ "version": "C-unhealthy", "color": "#b91c1c", "healthy": false }' > "$work/release.json"
U=$(commit unhealthy "Release C (fails health checks)")
echo '{ "version": "D-crash", "color": "#000000", "crashOnStart": true }' > "$work/release.json"
C=$(commit crash "Release D (crashes on start)")
git -C "$work" checkout -q -b broken "$B"
printf 'FROM node:22-alpine\nRUN exit 42\n' > "$work/Dockerfile"
X=$(commit broken "Broken Dockerfile")
git -C "$work" checkout -q main
git -C "$work" reset -q --hard "$B"

mkdir -p "$out/demo"
rm -rf "$out/demo/sample-app.git"
git clone -q --bare "$work" "$out/demo/sample-app.git"
cat > "$out/shas.json" <<EOF
{ "A": "$A", "B": "$B", "unhealthy": "$U", "crash": "$C", "broken": "$X" }
EOF
cat "$out/shas.json"
