#!/usr/bin/env bash
# vps-frontend-same-origin.sh — install the same-origin frontend lane (DEPLOYMENT §6A).
#
# Run ON THE VPS as the deploy user, from the deployed backend checkout:
#     ssh -p 2222 deploy@YOUR_VPS_IP
#     bash /opt/natlas/deploy/vps-frontend-same-origin.sh
#
# It creates https://app.<ip>.sslip.io, where the web app and /api answer on the
# SAME origin — which is the fix for iPhone: while the page was on Vercel the
# session cookie was third-party, and Safari's ITP drops it, so sign-in could
# never stick.
#
# Re-runnable by design. If the frontend repo is private, step 2 stops with the
# public key it just made and exits 0: add it as a read-only Deploy Key on
# Brobot64/soulnurture-frontend (a GitHub deploy key is bound to one repo, so the
# API's key cannot be reused), then run the same command again and it carries on.
# A public repo is cloned over anonymous HTTPS and never pauses.
#
# Flags:  -y | --yes          don't ask before restarting the API
#         --skip-api-env       leave /opt/natlas/.env untouched (you patch it yourself)
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=/opt/natlas-frontend
FRONTEND_REPO=Brobot64/soulnurture-frontend
FRONTEND_HTTPS=https://github.com/$FRONTEND_REPO.git
# only needed if the repo is private: a GitHub deploy key is bound to exactly one
# repository, so the API's natlas_github key cannot be reused here.
FRONTEND_SSH=git@github-frontend:$FRONTEND_REPO.git
FRONTEND_REMOTE="$FRONTEND_SSH"   # decided for real in step 2
NGINX_SITE=/etc/nginx/sites-available/natlas
ENV_FILE=/opt/natlas/.env
LINEAGE_DIR=/etc/letsencrypt/live
TS=$(date +%Y%m%d%H%M%S)

ASSUME_YES=0
SKIP_ENV=0
PENDING=""   # steps only a human can finish; echoed at the end
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --skip-api-env) SKIP_ENV=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n=== %s\n' "$*"; }
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r reply
  [ "$reply" = y ] || [ "$reply" = Y ]
}

if [ "$(id -un)" = root ]; then
  echo "run as deploy, not root (npm output must stay deploy-owned)" >&2
  exit 1
fi
for f in natlas-frontend-deploy.sh natlas-frontend.service nginx-app-vhost.conf; do
  [ -r "$SRC_DIR/$f" ] || { echo "missing $SRC_DIR/$f — deploy from the repo checkout, not a copy of this file alone" >&2; exit 1; }
done

# ---------------------------------------------------------------- 1. which host?
step "Resolving the sslip.io hostnames from the installed nginx site"
if [ ! -r "$NGINX_SITE" ]; then
  echo "$NGINX_SITE is unreadable or missing — this box has no natlas vhost yet (§7)" >&2
  exit 1
fi
# `|| true` on purpose: head -1 closes the pipe early, so grep would otherwise die of
# SIGPIPE and pipefail would abort the script before the helpful message below runs.
IP="${NATLAS_VPS_IP:-$(grep -ohE '(api|s3|monitor)\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.sslip\.io' "$NGINX_SITE" | head -1 | sed -E 's/^[a-z]+\.//; s/\.sslip\.io$//' || true)}"
if ! printf '%s' "$IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "could not derive the server IP; re-run as: NATLAS_VPS_IP=<ipv4> $0" >&2
  exit 1
fi
API_HOST="api.$IP.sslip.io"
APP_HOST="app.$IP.sslip.io"
# The origin lists in .env store scheme-prefixed origins, so membership is tested
# against this and never against the bare hostname — comparing the two is how a
# "already lists it" check silently stops firing and a re-run appends duplicates.
ORIGIN="https://$APP_HOST"
echo "API host   : $API_HOST (already live)"
echo "New app host: https://$APP_HOST  ->  / = 127.0.0.1:3100 (SSR), /api = 127.0.0.1:3000"
id natlas >/dev/null 2>&1 || { echo "user 'natlas' does not exist — the backend unit runs as it (§6); fix that first" >&2; exit 1; }

# ------------------------------------------ 2. how does the box read the repo?
step "Source access for $FRONTEND_REPO"
# A public repo needs no credential at all, so probe anonymous HTTPS first and only
# mint a read-only deploy key when that is refused. GIT_TERMINAL_PROMPT=0 because a
# private repo otherwise hangs here waiting for a username.
NEED_KEY=0
if GIT_TERMINAL_PROMPT=0 git ls-remote -h "$FRONTEND_HTTPS" HEAD >/dev/null 2>&1; then
  FRONTEND_REMOTE="$FRONTEND_HTTPS"
  echo "answers anonymously over HTTPS (public) — no deploy key, no new credential on this box"
else
  echo "HTTPS read refused (private repo) — a dedicated read-only deploy key is required"
  NEED_KEY=1
fi

if [ "$NEED_KEY" = 1 ]; then
KEYFILE="$HOME/.ssh/natlas_github_frontend"
[ -f "$KEYFILE" ] || ssh-keygen -t ed25519 -a 100 -f "$KEYFILE" -N '' -C 'natlas-vps-frontend-pull' -q
touch "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"
grep -q '^Host github-frontend$' "$HOME/.ssh/config" || cat >> "$HOME/.ssh/config" <<'EOF'

# second read-only pair: a GitHub deploy key is bound to exactly one repository,
# so the API's natlas_github key cannot be reused for the frontend repo.
Host github-frontend
  HostName github.com
  User git
  IdentityFile ~/.ssh/natlas_github_frontend
  IdentitiesOnly yes
EOF
# GitHub's host key must be known under the alias too, or the first fetch dies
# with "Host key verification failed" (verify the fingerprint out-of-band once:
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
grep -qs 'github.com' "$HOME/.ssh/known_hosts" || ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

HELLO=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github-frontend 2>&1 || true)
if ! printf '%s' "$HELLO" | grep -q 'successfully authenticated'; then
  cat <<EOF

PAUSED — one human step. Add this as a READ-ONLY Deploy Key on
Brobot64/soulnurture-frontend (repo Settings -> Deploy keys -> Add deploy key,
do NOT tick "Allow write access"), then re-run this script:

$(cat "$KEYFILE.pub")

GitHub said: $(printf '%s' "$HELLO" | head -1)
(and if that line is a network error rather than "Permission denied", the key is
already added and something else is wrong — fix that and re-run.)

EOF
  exit 0
fi
echo "GitHub answers for the frontend repo: $(printf '%s' "$HELLO" | head -1)"
fi   # end of the deploy-key path (step 2)

# ------------------------------------------------------------ 3. the app checkout
step "Syncing $APP_DIR to origin/main"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo install -d -o deploy -g deploy -m 0755 "$APP_DIR"
  git clone "$FRONTEND_REMOTE" "$APP_DIR"
else
  git -C "$APP_DIR" remote set-url origin "$FRONTEND_REMOTE"
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout -f main
  git -C "$APP_DIR" reset --hard origin/main
fi
echo "frontend at $(git -C "$APP_DIR" rev-parse --short HEAD) ($(git -C "$APP_DIR" log -1 --format=%s | cut -c1-60))"

# ------------------------------------------------------- 4. release lane + service
step "Installing natlas-frontend-deploy and natlas-frontend.service"
sudo install -m 0755 -o root -g root "$SRC_DIR/natlas-frontend-deploy.sh" /usr/local/bin/natlas-frontend-deploy
sudo install -m 0644 -o root -g root "$SRC_DIR/natlas-frontend.service" /etc/systemd/system/natlas-frontend.service
sudo systemctl daemon-reload
# enabled, not started: the unit would spin on a .output that does not exist yet —
# the release script below builds first and then restarts it.
sudo systemctl enable natlas-frontend

# ------------------------------------------------------------- 5. TLS for the host
step "Certificate coverage for $APP_HOST"
FULLCHAIN="$LINEAGE_DIR/$API_HOST/fullchain.pem"
# Ask openssl through sudo: certbot keeps the lineage root-readable (0600/0700), so a
# plain `[ -r ]` as the unprivileged user reports a real certificate as missing — the
# first run of this script died exactly that way on a box with a healthy three-SAN cert.
if ! sudo openssl x509 -in "$FULLCHAIN" -noout -subject >/dev/null 2>&1; then
  echo "no certificate lineage readable at $FULLCHAIN — issue the API certificate first (§7)" >&2
  exit 1
fi
if sudo openssl x509 -in "$FULLCHAIN" -noout -text | grep -q "DNS:$APP_HOST"; then
  echo "already covered by the existing lineage"
else
  mapfile -t SANS < <(sudo openssl x509 -in "$FULLCHAIN" -noout -text | grep -o 'DNS:[^,]*' | sed 's/DNS://; s/ //g')
  DARGS=()
  for san in "${SANS[@]}" "$APP_HOST"; do DARGS+=(-d "$san"); done
  # --cert-name grows the SAME lineage, so renewal stays one job for every vhost
  if ! sudo certbot certonly --webroot -w /var/www/html --cert-name "$API_HOST" \
    "${DARGS[@]}" --non-interactive --deploy-hook "systemctl reload nginx"; then
    echo "certbot failed. The usual cause on a fresh box is no registered ACME account:" >&2
    echo "run it once interactively (drop --non-interactive, add -m you@example.com --agree-tos)." >&2
    echo "If the HTTP-01 challenge itself failed, sslip.io has not resolved yet — dig +short $APP_HOST" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------ 6. the vhost
step "nginx: adding the $APP_HOST server blocks"
if grep -q "server_name $APP_HOST;" "$NGINX_SITE"; then
  echo "vhost already present"
else
  sudo cp -a "$NGINX_SITE" "$NGINX_SITE.bak-$TS"
  sed -e "s/@@APP_HOST@@/$APP_HOST/g" -e "s/@@API_HOST@@/$API_HOST/g" \
    "$SRC_DIR/nginx-app-vhost.conf" | sudo tee -a "$NGINX_SITE" > /dev/null
  if ! sudo nginx -t; then
    echo "nginx -t failed — restoring $NGINX_SITE (nothing reloaded, api. untouched)" >&2
    sudo cp -a "$NGINX_SITE.bak-$TS" "$NGINX_SITE"
    sudo nginx -t
    exit 1
  fi
  sudo systemctl reload nginx
  echo "nginx reloaded (backup: $NGINX_SITE.bak-$TS)"
fi

# ------------------------------------------------------- 7. the API knows the host
if [ "$SKIP_ENV" = 1 ]; then
  step "Skipping /opt/natlas/.env (--skip-api-env)"
  PENDING="$PENDING
  - $ENV_FILE: ALLOWED_ORIGINS, BETTER_AUTH_TRUSTED_ORIGINS and WEB_APP_URL need https://$APP_HOST, then 'sudo systemctl restart natlas'"
else
  step "Backend origins in $ENV_FILE"
  # sed -i and tee replace the file, and the replacement can come back root:root —
  # which silently unreads .env for natlas.service, because EnvironmentFile is read
  # as the service user (§6 installs it root:natlas 640). Capture before touching it.
  ENV_OWNER=$(sudo stat -c '%U:%G' "$ENV_FILE")
  ENV_MODE=$(sudo stat -c '%a' "$ENV_FILE")
  NEED_RESTART=0
  env_value() { sudo grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
  # Append, never replace wholesale: these lists also carry the Vercel origin while
  # it is still live (§6A step 5). A key listed twice is worse than useless (the
  # parser wins by position, not by intent), so duplicates are collapsed here.
  set_origin() {
    local key=$1 value=$2
    sudo sed -i "/^$key=/d" "$ENV_FILE"
    printf '%s=%s\n' "$key" "$value" | sudo tee -a "$ENV_FILE" > /dev/null
  }
  append_origin() {
    local key=$1 cur
    cur=$(env_value "$key")
    if [ -z "$cur" ]; then
      echo "$key is UNSET in $ENV_FILE — not guessed; add: $key=$ORIGIN"
      PENDING="$PENDING
  - $ENV_FILE: $key=$ORIGIN (currently unset), then 'sudo systemctl restart natlas'"
      return
    fi
    case ",$cur," in
      *",$ORIGIN,"*) echo "$key already lists the app origin" ;;
      *) set_origin "$key" "$cur,$ORIGIN"
         echo "$key += $ORIGIN"; NEED_RESTART=1 ;;
    esac
  }
  append_origin ALLOWED_ORIGINS
  append_origin BETTER_AUTH_TRUSTED_ORIGINS
  # WEB_APP_URL is what redirects emailed verify links into the app
  # (src/auth/auth.config.ts:61-65); BETTER_AUTH_URL deliberately stays on api.
  if [ "$(env_value WEB_APP_URL)" != "$ORIGIN" ]; then
    set_origin WEB_APP_URL "$ORIGIN"
    echo "WEB_APP_URL = $ORIGIN"; NEED_RESTART=1
  else
    echo "WEB_APP_URL already correct"
  fi

  if [ "$NEED_RESTART" = 1 ]; then
    sudo chown "$ENV_OWNER" "$ENV_FILE" && sudo chmod "$ENV_MODE" "$ENV_FILE"
    echo ".env permissions kept as $ENV_OWNER $ENV_MODE"
  fi

  if [ "$NEED_RESTART" = 1 ]; then
    echo "Both origin lists are read once at boot, so the API restarts (a few seconds of downtime)."
    if confirm "Restart natlas now?"; then
      sudo cp -a "$ENV_FILE" "$ENV_FILE.bak-$TS"
      sudo systemctl restart natlas
      healthy=0
      for _ in $(seq 1 20); do
        sleep 2
        if curl -sf -m 5 http://127.0.0.1:3000/api/health/auth > /dev/null; then healthy=1; break; fi
      done
      if [ "$healthy" = 1 ]; then
        echo "API healthy (env backup: $ENV_FILE.bak-$TS)"
      else
        echo "API unhealthy after the env change — restoring $ENV_FILE and restarting" >&2
        sudo cp -a "$ENV_FILE.bak-$TS" "$ENV_FILE"
        sudo systemctl restart natlas
        exit 1
      fi
    else
      echo "not restarted — until the API restarts it does not know the app origin, so sign-in from https://$APP_HOST fails at CORS"
      PENDING="$PENDING
  - sudo systemctl restart natlas (the edited origins are read once at boot)"
    fi
  else
    echo "no env change needed"
  fi
fi

# ------------------------------------------------------------- 8. build + release
step "First frontend release"
/usr/local/bin/natlas-frontend-deploy

# ---------------------------------------------------------------- 9. acceptance
step "Checking the lane from the outside"
check() {   # one line per URL — curl's own -w, so no printf %-collision
  printf 'GET  %-46s -> HTTP %s\n' "https://$1$2" \
    "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$1$2" || echo 'no answer')"
}
check "$APP_HOST" "/"
check "$APP_HOST" "/api/health/auth"
check "$APP_HOST" "/api/socket.io/?EIO=4&transport=websocket"   # 400/401 here is fine: nginx reached the API
check "$API_HOST" "/api/health/auth"                            # the Vercel lane must still work

cat <<EOF

App URL   https://$APP_HOST
EOF
if [ -n "$PENDING" ]; then
  cat <<EOF

STILL YOURS TO DO (the lane is not finished until these are):
$PENDING
EOF
fi
cat <<EOF

200 on both lines means the page and the API are one origin, which is the whole
iOS fix. The only remaining acceptance is a device check that no desktop browser
can fake: open https://$APP_HOST on an iPhone, sign in, reload the page, and stay
signed in. Until that passes, keep the Vercel URL and the api. vhost live, and
leave BETTER_AUTH_CROSS_SITE_COOKIES=true (a SameSite=None cookie is still fine
first-party — flipping it now would break the Vercel site).

Distribute https://$APP_HOST to the pilot students. Next release:
    ssh -p 2222 deploy@YOUR_VPS_IP /usr/local/bin/natlas-frontend-deploy
Logs: sudo journalctl -u natlas-frontend -f
Re-run this script any time: it changes only what is missing.
EOF

