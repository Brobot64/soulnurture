#!/usr/bin/env bash
# natlas-frontend-deploy — release lane for the same-origin frontend (DEPLOYMENT §6A).
# Installed to /usr/local/bin/natlas-frontend-deploy by
# deploy/vps-frontend-same-origin.sh; run as the deploy user, never as root.
#
# Mirrors natlas-deploy's contract exactly: single-flight, the marker is written
# only after the health gate passes (so a run that died mid-build is still "not
# deployed" and reruns cleanly), and the last-known-good revision is rebuilt on
# failure instead of leaving the service pointing at a broken bundle.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

if [ "$(id -un)" = "root" ]; then
  echo "run as deploy, not root (npm output must stay deploy-owned)" >&2
  exit 1
fi

APP_DIR=/opt/natlas-frontend
SSR_URL=http://127.0.0.1:3100

cd "$APP_DIR"
exec 9>/tmp/natlas-frontend-deploy.lock
flock -n 9 || { echo "another frontend deploy is already running; aborting"; exit 1; }

# No marker means nothing has ever passed the health gate, so HEAD is NOT evidence
# of a deployment — the first run must build even when the checkout is already at
# origin/main.
MARKER="$HOME/.natlas-frontend-last-deploy"
LAST=$(cat "$MARKER" 2>/dev/null || echo '')

git fetch origin
git checkout -f main
# deterministic: the tree is exactly origin/main (local junk is discarded)
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
if [ -n "$LAST" ] && [ "$LAST" = "$NEW" ]; then
  echo "already deployed at $(git rev-parse --short "$NEW"); nothing to do"
  exit 0
fi

build() {
  npm ci
  # VITE_API_BASE_URL EMPTY, not unset. .env is gitignored in this repo, so the
  # clone has no value at all and src/lib/api.ts would fall back to
  # http://localhost:3000 — i.e. every student's phone calling its own localhost.
  # An empty base makes every call relative, so the page and the API stay one
  # origin and the session cookie stays first-party (the whole point of §6A).
  # NITRO_PRESET overrides the platform detection only here; Vercel's own build
  # keeps using its preset.
  NITRO_PRESET=node_server VITE_API_BASE_URL= npm run build
  # Same-origin is the contract, so refuse to ship a bundle that baked in an
  # absolute origin — that re-creates the iOS third-party-cookie bug silently.
  if grep -rqs -e 'localhost:3000' -e 'sslip\.io' .output/public .output/server; then
    echo "BUILD GUARD: an absolute API origin is baked into .output; not deploying" >&2
    exit 1
  fi
}

health_gate() {
  # Not just a port check: the SSR server has to actually render, so a process that
  # boots, holds 3100 open and errors every request still fails the gate.
  rm -f /tmp/natlas-frontend-probe.html
  for _ in $(seq 1 20); do
    sleep 2
    if curl -sf -m 5 "$SSR_URL/" -o /tmp/natlas-frontend-probe.html \
       && grep -qs '<html' /tmp/natlas-frontend-probe.html; then
      return 0
    fi
  done
  return 1
}

build
sudo systemctl restart natlas-frontend

if health_gate; then
  echo "$NEW" > "$MARKER"
  echo "FRONTEND DEPLOY OK: ${LAST:+$(git rev-parse --short "$LAST") -> }$(git rev-parse --short "$NEW")"
  exit 0
fi

if [ -z "$LAST" ]; then
  echo "HEALTH GATE FAILED on the first frontend release; nothing to roll back to." >&2
  echo "Check: systemctl status natlas-frontend --no-pager; journalctl -u natlas-frontend -n 50" >&2
  exit 1
fi

echo "HEALTH GATE FAILED after deploying $(git rev-parse --short "$NEW"); rolling back to $(git rev-parse --short "$LAST")" >&2
git reset --hard "$LAST"
build
sudo systemctl restart natlas-frontend
exit 1
