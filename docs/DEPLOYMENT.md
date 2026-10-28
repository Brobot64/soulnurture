# Natlas — VPS Production Deployment Runbook

Target hardware: **Contabo Cloud VPS 6 — 6 vCPU, 12 GB RAM, 200 GB NVMe, Ubuntu 24.04 LTS, no GPU.**
Provision in an **EU region** (nearest to Nigerian users). Contabo Cloud VPS has no provider-level
firewall — ufw below is the only gate — and the control panel's **VNC console** is the rescue path
if SSH ever locks you out.

No domain yet, so everything is served under **sslip.io hostnames**: `<name>.<IP>.sslip.io`
resolves to the embedded IP automatically, and certbot can issue real Let's Encrypt certificates
with zero DNS setup. Replace `YOUR_VPS_IP` everywhere below with your Contabo IPv4 (e.g. `203.0.113.42`):

| Hostname | Serves |
|---|---|
| `app.YOUR_VPS_IP.sslip.io` | **The web app, and the API under its `/api` path** — the browser's only entry point (§6A) |
| `api.YOUR_VPS_IP.sslip.io` | NestJS backend (this repo) — still needed while the frontend is also hosted on Vercel |
| `s3.YOUR_VPS_IP.sslip.io` | RustFS object storage (S3 API + console) |
| `monitor.YOUR_VPS_IP.sslip.io` | Grafana dashboards |

Swapping in a real domain later: point its `A` records at the same IP, update `server_name` and the
env hostnames, re-run the certbot command (§7), reload nginx — nothing else changes.
SSH runs on **port 2222** throughout (§1): `ssh -p 2222 deploy@YOUR_VPS_IP`.

---

## 0. What runs where (and why)

| Component | Runtime | Port (bind) | Memory cap | Persistence |
|---|---|---|---|---|
| NestJS API | systemd (`natlas.service`), native Node 24 | 127.0.0.1:3000 | ~512 MB | — (stateless) |
| Frontend (TanStack Start SSR) | systemd (`natlas-frontend.service`), native Node 24 | 127.0.0.1:3200 | ~256 MB | — (stateless) |
| N-ATLaS LLM (vernacular lane) | **Off this box** — Hugging Face Inference Endpoint (vLLM on an AWS L4, scale-to-zero) | — | none | the weights never live here (§5) |
| Vernacular ASR (yo/ha/ig) | **Off this box** — three Hugging Face Inference Endpoints, one per language | — | none | §5 |
| Ollama — **vestigial** | native systemd, still enabled but unread | 127.0.0.1:11434 | 34 MB idle | `/opt/ollama/models` (§5 fallback A) |
| PostgreSQL 17 | Docker Compose | 127.0.0.1:5432 | 1.5 GB | named volume `pgdata` |
| RustFS (S3) | Docker Compose | 127.0.0.1:9000 / 9001 | 512 MB | named volume `rustfs-data` |
| Prometheus | Docker Compose | 127.0.0.1:9090 | 512 MB | volume `prom-data` |
| Grafana | Docker Compose | 127.0.0.1:3001 | 384 MB | volume `grafana-data` |
| Loki | Docker Compose | 127.0.0.1:3100 | 384 MB | volume `loki-data` |
| Promtail | Docker Compose | — | 128 MB | — (reads host journals) |
| node_exporter | Docker Compose | 127.0.0.1:9100 | 64 MB | — |
| cAdvisor | Docker Compose | 127.0.0.1:8080 | 128 MB | — |
| postgres_exporter | Docker Compose | 127.0.0.1:9187 | 64 MB | — |
| blackbox-exporter | Docker Compose | 9115 (host network) | 64 MB | — |
| Nginx | apt (native) | 0.0.0.0:80/443 | ~50 MB | /etc/nginx, certs |

Rationale: **infra with state runs in Docker Compose** (clean upgrades, isolated volumes), **Node runs natively under systemd** (native Node avoids bind-mounting source into containers), and **both model services run off-box** as Hugging Face Inference Endpoints (§5) — which is what lets a 12 GB box with no GPU carry this stack at all. Nginx is the only public listener. **Nothing else touches the internet.**

Memory budget on 12 GB, measured on the running box (2026-10-28): **1.4 GB used, ~10.4 GB available** — Postgres ≤1.5 GB, API ≤0.5 GB, frontend SSR ≤0.25 GB, observability ~1.5 GB, OS ~1 GB. This is *not* the original budget: the Q4_K_M model used to sit resident at 5–6 GB and the whole plan assumed ≈10 GB of the 12 GB. Moving the vernacular lane to the hosted endpoint is what freed it. Keep the 4 GB swap as the pressure valve.

**Vernacular ASR — hosted by default.** Yoruba/Hausa/Igbo voice notes run on the NCAIR1 whisper-small fine-tunes served as three Hugging Face Inference Endpoints (one per language, `NATLAS_ASR_URL_*` in §6): a T4 each, scale-to-zero so idle hours cost nothing, ~2.5 s per note when warm and ~3 min to wake from cold — the provider retries inside `NATLAS_ASR_TIMEOUT_MS` and then answers "the voice model is starting up, try again in a moment". Those endpoints decode audio with libsndfile, so the browser records 16 kHz mono WAV and webm/opus is rejected. `services/n-atlas-asr` stays as the self-hosted alternative when there is no HF account (run + systemd unit at the end of §5); a per-language endpoint URL wins over `NATLAS_ASR_BASE_URL`. With neither configured, yo/ha/ig voice notes get the friendly "type your message instead" 503, while English and Pidgin ride the Groq Whisper chain normally.

**N-ATLaS license obligations** (bind with the deployment): display attribution — *"N-ATLaS is an initiative of the Federal Ministry of Communications, Innovation and Digital Economy, powered by Awarri Technologies"* — and stay within the **1000 active end-users / 30 days** cap (school pilots are far below; track enrolment before scaling). Attribution belongs in the product footer and `GET /api/v1/ai/config`.

---

## 1. Secure server baseline

```bash
# --- from your laptop: the SSH key is the ONLY door after hardening — make
#     sure it exists, because the bootstrap below has nothing to install without
#     one (that failure is silent until the lockout)
ls ~/.ssh/*.pub || ssh-keygen -t ed25519   # empty passphrase is fine for a deploy laptop

# --- first login: root + the password Contabo emailed you
#     (the panel VNC console is the rescue path if SSH ever locks you out)
ssh root@YOUR_VPS_IP

# --- base system
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban unattended-upgrades build-essential

# --- install your public key for root BEFORE any hardening: password auth
#     goes away below, so keys must already work. Paste the output of
#     `cat ~/.ssh/id_ed25519.pub` from your laptop in place of the key:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAA... your-laptop-comment' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# GATE: from a second laptop terminal, prove the key door opens — must print OK
# with no password prompt and no "Permission denied":
#   ssh -o BatchMode=yes root@YOUR_VPS_IP 'echo OK'
# Failing here costs one VNC-console trip now; the SAME failure after hardening
# looks identical ("Permission denied (publickey,password)") — but password and
# root auth are already dead by then.

# --- deploy user (no root logins afterwards)
adduser --disabled-password --gecos '' deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# --- swap (memory pressure valve for the model)
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-natlas.conf && sysctl --system

# --- ssh hardening: custom port 2222, keys only
sed -i 's/^#\?Port .*/Port 2222/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# Ubuntu cloud images ship drop-ins in sshd_config.d/, and sshd takes the FIRST
# value it sees — drop-ins are parsed before sshd_config, so the stock
# 60-cloudimg-settings.conf (PasswordAuthentication yes) silently beats the sed
# above. Beat it with a file that sorts earlier (00- < 60-):
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/00-natlas-hardening.conf

# verify the EFFECTIVE config BEFORE restarting sshd:
sshd -T | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication)'
# want: port 2222 / permitrootlogin no / passwordauthentication no / kbdinteractiveauthentication no

# Ubuntu 24.04 starts sshd socket-activated: ssh.socket owns the listening port
# and the Port directive above is IGNORED (sshd -T cannot see this). Pinning
# ssh.socket to 2222 instead produced an IPv6-only listener ([::]:2222) that
# refused every IPv4 client even with net.ipv6.bindv6only=0. Don't fight the
# socket unit — turn it off and run the plain daemon; sshd_config becomes the
# single source of truth:
systemctl disable --now ssh.socket   # "Unit ssh.socket does not exist" = already off, fine
systemctl restart ssh
systemctl enable ssh                 # socket activation was the only reason ssh was
                                     # enabled; without this sshd does NOT start after a reboot

# PROVE the port is really bound — "Connection refused" from your laptop means
# nothing listens on 2222 yet, no matter what sshd -T printed:
ss -tlnp | grep -w 2222   # want 0.0.0.0:2222 owned by sshd — NOT a [::]: only entry

# --- firewall: ssh on 2222 (rate-limited), web only
# GATE: enabling ufw kills port 22 from the outside — for real. If the ss
# check above did not show a listener on :2222, stop; fix it from the VNC
# console first.
ufw default deny incoming && ufw default allow outgoing
ufw limit 2222/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# --- brute-force protection + automatic security patches
systemctl enable --now fail2ban
dpkg-reconfigure -plow unattended-upgrades    # answer Yes when prompted

# --- sudo without a password: deploy was created --disabled-password, so it has
#     no password to type at a sudo prompt and cannot use sudo at all. NOPASSWD
#     is the norm for a solo-admin box (cloud default users on AWS/GCP ship it);
#     prefer a sudo password instead? skip this and run `passwd deploy` — SSH
#     password login stays disabled either way.
printf 'deploy ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/00-natlas-deploy
chmod 440 /etc/sudoers.d/00-natlas-deploy
visudo -c                  # want "parsed OK" — do not continue otherwise
```

**Keep this root session open** and prove the new door from a second terminal on your laptop: `ssh -p 2222 deploy@YOUR_VPS_IP 'whoami; sudo -n true && echo sudo-ok'`. **Read the failure — it tells you exactly where you are: "Connection refused" = nothing bound to 2222 (re-run the daemon block above); "Permission denied (publickey,password)" = the door is open but the deploy key was never installed (from this console: write your laptop's pubkey into `/home/deploy/.ssh/authorized_keys`); port 22 timing out = ufw working as intended.** Root login and password auth are dead now — catching a typo while this session is still open costs nothing; a lockout costs a VNC-console session. All further commands run as `deploy`: `ssh -p 2222 deploy@YOUR_VPS_IP` (with `sudo` where needed).

---

## 2. Docker + Compose (container management)

```bash
# official docker repo install
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker deploy   # re-login afterwards
docker compose version           # sanity
```

Container log rotation (prevents the 200 GB disk filling silently) — `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

```bash
sudo systemctl restart docker
```

Every compose service below sets `restart: unless-stopped` and memory limits so containers can never starve the two Node services (§0 table).

---

## 3. PostgreSQL (database + persistence)

Layout: infra lives in `/opt/infra`, one compose file, one shared network.

`/opt/infra/.env`:

```ini
POSTGRES_USER=natlas
POSTGRES_PASSWORD=<generate: openssl rand -hex 24>
POSTGRES_DB=natlas
RUSTFS_ACCESS_KEY=natlas-storage
RUSTFS_SECRET_KEY=<generate>
GRAFANA_ADMIN_PASSWORD=<generate>
GF_SMTP_HOST=smtp.ethereal.email:587        # test-only default — replace with real SMTP before relying on email alerts
GF_SMTP_USER=...
GF_SMTP_PASSWORD=...
```

`/opt/infra/docker-compose.yml`:

```yaml
name: natlas-infra

services:
  postgres:
    image: pgvector/pgvector:pg17     # pg17 + pgvector — the memory migration needs the extension
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "127.0.0.1:5432:5432"        # host access for prisma migrate / psql only
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits: { memory: 1536M }

  rustfs:
    image: rustfs/rustfs:latest
    restart: unless-stopped
    environment:
      RUSTFS_VOLUMES: /data
      RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY}
      RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY}
      RUSTFS_CONSOLE_ENABLE: "true"
      RUSTFS_CONSOLE_ADDRESS: 0.0.0.0:9001
    ports:
      - "127.0.0.1:9000:9000"        # S3 API (proxied via s3.YOUR_VPS_IP.sslip.io)
      - "127.0.0.1:9001:9001"        # web console (proxied via s3.YOUR_VPS_IP.sslip.io/console)
    volumes:
      - rustfs-data:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:9000/health"]
      interval: 30s
      timeout: 5s
      start_period: 20s
    deploy:
      resources:
        limits: { memory: 512M }

  prometheus:
    image: prom/prometheus:v2.53.0
    restart: unless-stopped
    ports: ["127.0.0.1:9090:9090"]
    extra_hosts: ["host.docker.internal:host-gateway"]   # so probes can reach native 127.0.0.1 services
    volumes:
      - ./prometheus:/etc/prometheus:ro
      - prom-data:/prometheus
    deploy:
      resources:
        limits: { memory: 512M }

  grafana:
    image: grafana/grafana:11.5.0
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
      GF_SERVER_ROOT_URL: https://monitor.YOUR_VPS_IP.sslip.io
      GF_SMTP_ENABLED: "true"
      GF_SMTP_HOST: ${GF_SMTP_HOST}
      GF_SMTP_USER: ${GF_SMTP_USER}
      GF_SMTP_PASSWORD: ${GF_SMTP_PASSWORD}
    ports: ["127.0.0.1:3001:3000"]
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
    depends_on: [prometheus, loki]
    deploy:
      resources:
        limits: { memory: 384M }

  loki:
    image: grafana/loki:3.4.2
    restart: unless-stopped
    command: -config.file=/etc/loki/local-config.yaml
    ports: ["127.0.0.1:3100:3100"]
    volumes:
      - loki-data:/loki
    deploy:
      resources:
        limits: { memory: 384M }

  promtail:
    image: grafana/promtail:3.4.2
    restart: unless-stopped
    volumes:
      - ./promtail/promtail.yaml:/etc/promtail/config.yaml:ro
      - /var/log/journal:/var/log/journal:ro
      - /run/log/journal:/run/log/journal:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    depends_on: [loki]
    deploy:
      resources:
        limits: { memory: 128M }

  node-exporter:
    image: prom/node-exporter:v1.9.0
    restart: unless-stopped
    ports: ["127.0.0.1:9100:9100"]
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - --path.procfs=/host/proc
      - --path.sysfs=/host/sys
      - --path.rootfs=/rootfs

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    restart: unless-stopped
    ports: ["127.0.0.1:8080:8080"]
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    deploy:
      resources:
        limits: { memory: 128M }

  postgres-exporter:
    image: prometheuscommunity/postgres-exporter:v0.15.0
    restart: unless-stopped
    # v0.15.x ignores the old EXTEND_QUERY_PATH env var — pass the (deprecated
    # but working) flag explicitly. stat_bgwriter is disabled: PG17 dropped
    # checkpoints_timed and that collector errors on every scrape otherwise.
    command:
      - --extend.query-path=/queries.yaml
      - --no-collector.stat_bgwriter
    environment:
      DATA_SOURCE_NAME: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable
    ports: ["127.0.0.1:9187:9187"]
    volumes:
      - ./postgres-exporter/queries.yaml:/queries.yaml:ro
    depends_on: [postgres]
    deploy:
      resources:
        limits: { memory: 64M }

  blackbox-exporter:
    image: prom/blackbox-exporter:v0.25.0
    restart: unless-stopped
    # host networking: probes must reach the native services bound to
    # 127.0.0.1 (API :3000, Ollama :11434, RustFS :9000) — unreachable
    # from a bridge network, and the backend is not containerized
    network_mode: host
    deploy:
      resources:
        limits: { memory: 64M }

volumes:
  pgdata:
  rustfs-data:
  prom-data:
  grafana-data:
  loki-data:
```

> **Before `docker compose up`**: write `/opt/infra/postgres-exporter/queries.yaml` first (content in §8). If the file is missing, Docker silently creates a *directory* at the bind-mount path and the custom metrics never load — this bit us on first bring-up.

Bring it up:

```bash
mkdir -p /opt/infra/{prometheus,grafana/provisioning/datasources,grafana/provisioning/dashboards,promtail,postgres-exporter}
cd /opt/infra && docker compose up -d && docker compose ps
```

**Database management essentials:**

```bash
docker compose exec postgres psql -U natlas -c '\l'          # list DBs
# manual backup (also automated in §7):
docker compose exec -T postgres pg_dump -U natlas natlas | gzip > /opt/backups/natlas-$(date +%F).sql.gz
# restore drill (do it once before go-live):
gunzip -c /opt/backups/natlas-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U natlas natlas
```

**Why `pgvector/pgvector:pg17`:** the Phase C memory migration (`prisma/migrations/20261006193000_phase_c_memory`) runs `CREATE EXTENSION IF NOT EXISTS vector` and stores 1536-dim embeddings — stock `postgres:17-alpine` does not ship pgvector and `prisma migrate deploy` would fail there. The `natlas` container user is a superuser, so the extension installs on first migrate with no extra grants.

Persistence model: `pgdata` is a named Docker volume — survives `compose down`, rebuilds, and host reboots. **Disk filling watch:** the observability stack alerts at 85% (§6).

---

## 4. RustFS — object storage & file uploads

RustFS speaks the standard S3 API on the usual 9000 (API) / 9001 (console) split, so the app's
AWS-SDK configuration does not change — only the container. Bucket setup and backups use the
**AWS CLI** (the backend already runs on `@aws-sdk`, so no extra S3 tooling to maintain):

```bash
sudo apt install -y awscli

# one-time bucket setup from the host (credentials come from the infra .env)
set -a; . /opt/infra/.env; set +a
export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"
aws --endpoint-url http://127.0.0.1:9000 --region us-east-1 s3api create-bucket --bucket natlas-uploads

# S3 buckets are private by default — prove it: an unauthenticated read must return 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/natlas-uploads/anything
```

(The bucket stays private — access only via presigned URLs or the backend's service credentials;
the `403` above proves it.)

**Upload pattern for the NestJS app** (files like student voice notes ≥ the current 10 MB multipart cap should go direct-to-RustFS):

- **Preferred:** backend issues a **presigned PUT URL** (`@aws-sdk/client-s3` → `getSignedUrl`), the client uploads straight to `https://s3.YOUR_VPS_IP.sslip.io/natlas-uploads/...` — large files never transit Node. Nginx sets `client_max_body_size 512m` on the `s3.` vhost.
- **Small files / server-validated writes:** keep the existing Fastify multipart route (10 MB cap in `main.ts`) and stream into S3 with `@aws-sdk/client-s3` `PutObject`.

App env additions (`.env`):

```ini
S3_ENDPOINT=https://s3.YOUR_VPS_IP.sslip.io
S3_REGION=us-east-1
S3_BUCKET=natlas-uploads
S3_ACCESS_KEY=<RUSTFS_ACCESS_KEY from the infra .env>
S3_SECRET_KEY=<its secret>
```

Never expose the RustFS credentials to clients — the API's presigned URLs are the only client-facing door.

**Daily data backup** (mirrors object storage next to the DB dumps):

```bash
. /opt/infra/.env
export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"
aws --endpoint-url http://127.0.0.1:9000 s3 sync s3://natlas-uploads /opt/backups/rustfs
```

---

## 5. N-ATLaS — the vernacular lane (hosted off-box; Ollama is now a fallback)

**What runs on this server is a client, not a model.** The vernacular understanding,
language-identify, render and translate lanes call an OpenAI-compatible chat API hosted as a
Hugging Face Inference Endpoint, and the app never loads a weight:

```bash
# /opt/natlas/.env — the four lines that route the vernacular lane off-box.
# Values are secrets; never paste them into a chat, terminal log or commit.
NATLAS_LLM_BASE_URL=https://<endpoint-id>.endpoints.huggingface.cloud   # no /v1 — the provider appends it
NATLAS_LLM_MODEL=NCAIR1/N-ATLaS
NATLAS_LLM_API_KEY=<HF token of the account that accepted the NCAIR1 terms>
AI_VERNACULAR_REPLY_MODE=n-atlas-translate   # render the finished reply into the turn's language
```

The provider posts `POST {NATLAS_LLM_BASE_URL}/v1/chat/completions` with `model: NCAIR1/N-ATLaS`
and reads `choices[0].message.content` plus `usage` (`src/ai/providers/natlas/natlas-llm.provider.ts:169`);
every failure throws `NatlasUnavailableError`, which is what lets the OpenAI fallback stay intact.
`Authorization` is sent only when `NATLAS_LLM_API_KEY` is set — that is how a local Ollama (below)
works with no key at all.

**Endpoint configuration** (managed through the Hugging Face Endpoints MCP, not SSH — see §5's
verification list): account `Cocolette`, **AWS us-east-1, L4 x1, $0.80/hr while allocated**,
`minReplica 0 / maxReplica 1 / 15-minute scale-to-zero` so idle hours cost nothing, image
`vllm/vllm-openai:v0.23.0`, gated repo pinned at revision `e294476928aca9030e924ca27bb8e085e8581273`,
and `model.args: ["--max-model-len","16384"]`. That last one is load-bearing, not cosmetic: the repo
declares a 131 072-token context, vLLM reserves KV cache for the whole thing, and an L4 leaves ~4 GB
after the BF16 weights — the endpoint boots to `failed` with `_check_enough_kv_cache_memory` unless
the cap is passed. HF's schema has no max-model-len knob; `model.args` is the only way in.

**The four timeouts are a hierarchy, and the shortest ones win.** A student is waiting on the sync
lanes, so a cold endpoint must fall through to OpenAI fast; only the async worker can afford to wait.

| Knob | Default | Lane | Budget logic |
|---|---|---|---|
| `NATLAS_LLM_TIMEOUT_MS` | 45 000 | async understanding (worker) | the only lane that can absorb a slow model |
| `NATLAS_TRANSLATE_TIMEOUT_MS` | 10 000 | sync translation | N-ATLaS is the only translator |
| `NATLAS_RENDER_TIMEOUT_MS` | 12 000 | sync reply render | fall through to the OpenAI render, then keep English |
| `NATLAS_IDENTIFY_TIMEOUT_MS` | 4 000 | sync language-ID | strictest — fail open to preference, then English |

### Cold starts are the failure mode, not the model

A sleeping replica answers **503 and does not queue**; that first call is what wakes it, and a full
wake measured **~14 min** (range 10–16 min) — two orders of magnitude beyond every timeout above.
So **re-warm the endpoint before any probe that must show the lane working** (call it through the MCP
~15 min ahead and wait for 200), or the run records `understanding.via='openai'` and reads like a
model failure when it is a scheduling fact. Related distinction that costs people time:
**`scaledToZero` ≠ `paused`.** A scaled-to-zero endpoint wakes; a **paused** one answers an instant
400 ("The endpoint is paused, ask a maintainer to restart it") to every request and will not wake
itself — and `resume_endpoint` can 403 with *"Payment method required for namespace: Cocolette"*,
which is a billing action, not an infra one. `resume_endpoint` on a `failed` endpoint (GCP/AWS
"scheduling failure: unable to schedule") reschedules onto a fresh replica.

**Prod state, verified 2026-10-28** (counts only — never echo the values):
`NATLAS_LLM_BASE_URL` set to an `https://` endpoint, `NATLAS_LLM_API_KEY` set,
`AI_VERNACULAR_REPLY_MODE=n-atlas-translate`, and all three `NATLAS_ASR_URL_{YO,HA,IG}` +
`NATLAS_ASR_API_KEY` set with `NATLAS_ASR_BASE_URL` empty (so voice uses the hosted endpoints, not
the sidecar). Check without printing secrets:

```bash
ssh -p 2222 deploy@YOUR_VPS_IP 'for k in NATLAS_LLM_BASE_URL NATLAS_LLM_API_KEY AI_VERNACULAR_REPLY_MODE NATLAS_ASR_URL_YO NATLAS_ASR_URL_HA NATLAS_ASR_URL_IG NATLAS_ASR_API_KEY NATLAS_ASR_BASE_URL; do printf "%s=%s\n" "$k" "$(grep -cE "^$k=." /opt/natlas/.env)"; done'
# 1 = configured, 0 = not. A key that must be set and reads 0 explains a fallback silently.
```

**Still open on this lane:** no production message has been observed with
`aiPayload.understanding.via='n-atlas-local'` — the endpoint is proven to serve, and the wiring is
proven to be read by the app's config layer, but the end-to-end accept needs a warmed endpoint plus
a real vernacular turn through the VPS (`test/yoruba-live-probe.mjs`, which writes prod data, so it
is the owner's call). Read-back without burning chat turns: `test/conversation-inspector.mjs` reads
`GET /api/v1/conversations/:id`, where `aiPayload.understanding`/`render`/`applicationNotes` are
persisted per message. Note that a **duplicate** `KEY=` line in `/opt/natlas/.env` silently loses —
systemd `EnvironmentFile` takes the last occurrence (`grep -cE '^KEY='` before blaming the code).

**License:** display the attribution (*"N-ATLaS is an initiative of the Federal Ministry of
Communications, Innovation and Digital Economy, powered by Awarri Technologies"* — the verbatim line
is in the product footer and `GET /api/v1/ai/config`), and stay ≤ 1000 active end-users / 30 days.

### Fallback A — Ollama on this box (retired 2026-10-09; the unit is still installed)

This is the original all-on-VPS lane: the same OpenAI-compatible provider, pointed at a CPU-quantized
GGUF instead of an endpoint. It is **the dev/offline path and the no-HF-account answer** — a machine
running its own Ollama serves the vernacular lane with no token at all, which is exactly what the
provider's keyless branch is for. Nothing in the app reads the box's
install any more: `NATLAS_LLM_BASE_URL` points at the endpoint, so `ollama.service` sits **active +
enabled with 34 MB resident and 127.0.0.1:11434 bound** — verified 2026-10-28. Removing it is a live
change on a production box and is the owner's call, not a cleanup an agent should run.

To use it, set `NATLAS_LLM_BASE_URL=http://127.0.0.1:11434`, leave `NATLAS_LLM_API_KEY` **empty**
(the provider then omits `Authorization`), and restart `natlas`. Expect ~4–10 tokens/sec on 6 shared
vCPUs and ~5–6 GB of the 12 GB held by the resident model — i.e. it only competes with the hosted
lane because the box no longer has to carry the weights.

```bash
# --- ollama (native service, binds 127.0.0.1:11434 by default)
curl -fsSL https://ollama.com/install.sh | sh

# --- gated-model access: accept the licence terms on the HF model page for
#     the account that owns the token, then authenticate
sudo apt install -y python3-pip python3-venv
python3 -m venv /opt/hfenv && /opt/hfenv/bin/pip install -U huggingface_hub
# huggingface_hub ≥ 0.34 dropped the `huggingface-cli` entrypoint; the binary is `hf`
/opt/hfenv/bin/hf auth login           # paste the hf_... token (account has accepted NCAIR1 terms)

# --- download the CPU quant (Q4_K_M ≈ 5 GB; Q8_0 ≈ 8.5 GB if RAM allows)
sudo mkdir -p /opt/models/natlas && sudo chown deploy:deploy /opt/models/natlas
/opt/hfenv/bin/hf download tosinamuda/N-ATLaS-GGUF \
  --include "*Q4_K_M*" --local-dir /opt/models/natlas

# --- import with N-ATLaS-recommended generation params
cat > /opt/models/natlas/Modelfile <<'EOF'
FROM /opt/models/natlas/N-ATLaS.Q4_K_M.gguf
PARAMETER temperature 0.1
PARAMETER repeat_penalty 1.12
PARAMETER num_ctx 8192
PARAMETER num_parallel 1
EOF
ollama create natlas -f /opt/models/natlas/Modelfile
ollama run natlas --verbose "I feel overwhelmed about my exams"
```

Tuning notes if you do bring this lane back up:

- `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` (default service env) keep a single resident copy — the model stays loaded (~5–6 GB) thanks to Ollama's default `keep_alive`, so the async worker's jobs don't pay a load penalty per request. On a 12 GB box that is the difference between headroom and swapping, so `NATLAS_KEEP_ALIVE`/`ollama ps` are worth watching.
- Expected throughput on 6 shared vCPUs: **~4–10 tokens/sec**. Real-time student chat always rides the OpenAI→Groq provider chain (`AI_PROVIDER_CHAIN` in §6 — N-ATLaS is deliberately *not* a chat-chain member); it only ever serves the **vernacular lanes**. Either way the app talks to it the same way as the hosted endpoint: `POST /v1/chat/completions` on the origin in `NATLAS_LLM_BASE_URL`, no `/api/chat` and no key.
- Ollama must remain on `127.0.0.1` — never open 11434 in ufw.

### Fallback B — self-hosted vernacular ASR sidecar (built, never installed)

**Voice is not waiting on this.** Yoruba/Hausa/Igbo voice notes transcribe on the three hosted
endpoints (`NATLAS_ASR_URL_{YO,HA,IG}` + `NATLAS_ASR_API_KEY`, all set in prod as of 2026-10-28) and
`NATLAS_ASR_BASE_URL` is deliberately empty. This section is the alternative for a deployment that
cannot hold an HF account; a per-language endpoint URL always wins over the sidecar, and with
neither configured that language's voice note answers the friendly "type your message instead" 503
while English and Pidgin ride Groq Whisper. The unit has never been executed anywhere (the dev
machine has no Python), so treat first boot as a real smoke test, not a formality.

```bash
sudo apt install -y python3-venv ffmpeg        # ffmpeg decodes browser webm/opus
cd /opt/natlas/services/n-atlas-asr
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

`/etc/systemd/system/natlas-asr.service` (same hardening posture as `natlas.service`; the Hugging Face token must belong to an account that accepted the NCAIR1 terms — prefer an `EnvironmentFile` over inlining it):

```ini
[Unit]
Description=Natlas vernacular ASR sidecar (Yoruba/Hausa/Igbo)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=natlas
WorkingDirectory=/opt/natlas/services/n-atlas-asr
Environment=HF_TOKEN=hf_...
ExecStart=/opt/natlas/services/n-atlas-asr/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8100
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now natlas-asr
curl -s http://127.0.0.1:8100/health
# then set NATLAS_ASR_BASE_URL=http://127.0.0.1:8100 in /opt/natlas/.env and:
sudo systemctl restart natlas
```

whisper-small runs ~1 GB RAM **per warm language** (×3 ≈ 3 GB), loads lazily on first request (~10–30 s cold) and unloads languages idle for `NATLAS_ASR_IDLE_UNLOAD_SECONDS` (600). The VPS is sized for 2–4 concurrent streams; overflow degrades to the same friendly 503. Watch `journalctl -u natlas-asr` on first boot.

Unlike the hosted endpoints (libsndfile only — wav/flac/mp3, and the reason the browser records 16 kHz mono WAV), the sidecar shells out to **ffmpeg**, so it also accepts webm/m4a. Recording format is the same either way: the browser sends WAV, which both lanes decode. To actually route a language here, clear its `NATLAS_ASR_URL_<lang>` — a per-language endpoint URL outranks `NATLAS_ASR_BASE_URL`.

---

## 6. NestJS deployment (this repo)

```bash
# --- node 24 (must match CI's node-version and the laptop — npm 10 on Node 22
#     resolves the lockfile differently and rejects `npm ci` with
#     "Missing: typescript@5.9.3 from lock file")
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs

# --- service user FIRST (owns the .env group, and must exist before chown)
sudo useradd -r -U -s /usr/sbin/nologin natlas
sudo usermod -aG natlas deploy
newgrp natlas    # activate the new group now — or just log out and back in

# --- code (checkout stays deploy-owned, so git pull / npm ci never need sudo)
# private repo: configure a deploy key or use a token-bearing clone URL
sudo mkdir -p /opt/natlas && sudo chown deploy:deploy /opt/natlas
git clone https://github.com/Brobot64/soulnurture.git /opt/natlas && cd /opt/natlas
npm ci

# --- production .env — replace every <placeholder>; key reference: .env.example
#     (root writes; the natlas service reads via file perms, deploy via the group)
sudo tee /opt/natlas/.env > /dev/null <<'EOF'
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://natlas:<PG_PASSWORD>@127.0.0.1:5432/natlas?schema=public
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://api.YOUR_VPS_IP.sslip.io
# Browser origins allowed to call the API; add the deployed frontend origin before it goes live
# (comma-separated; entries are trimmed, but keep it space-free out of habit)
ALLOWED_ORIGINS=https://app.example.com
# Cross-origin frontend (e.g. Vercel): better-auth origin checks + SameSite=None session cookie
# (with Lax cookies the browser never stores the session cookie from a cross-site call).
# MUST be set — better-auth merges it natively for origin checks, and the NestJS wrapper
# needs it in trustedOrigins to answer CORS preflights on /api/auth/* (else they 404
# and the browser blocks cross-origin sign-up/sign-in before it even starts).
BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.com
BETTER_AUTH_CROSS_SITE_COOKIES=true
# Where emailed verification links land the user after the API consumes the
# token (optional — defaults to the first concrete trusted origin above)
WEB_APP_URL=https://app.example.com

# SMTP (verification + password reset emails)
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_USER=<smtp-user>
SMTP_PASS=<smtp-pass>
MAIL_FROM="Natlas <no-reply@soulnurture.ai>"

# Provider chain — OpenAI primary, Groq fallback (try-order on failures)
AI_PROVIDER_CHAIN=openai,groq
OPENAI_API_KEY=<sk-...>
OPENAI_CHAT_MODEL=gpt-5.6-luna
OPENAI_MAX_OUTPUT_TOKENS=1000
# Reasoning models may reject temperature — leave empty unless you know the model accepts it
OPENAI_TEMPERATURE=
# After this many OpenAI generations in a day, the chain starts at Groq until midnight
OPENAI_DAILY_REQUEST_CAP=400
# Estimator pricing (USD cents per 1M tokens) — feeds AiUsageDaily.estimatedUsdCents
OPENAI_INPUT_USD_CENTS_PER_1M=15
OPENAI_OUTPUT_USD_CENTS_PER_1M=60
GROQ_API_KEY=<gsk_...>
GROQ_CHAT_MODEL=openai/gpt-oss-20b
GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
GROQ_MAX_OUTPUT_TOKENS=600
GROQ_TEMPERATURE=0.2
GROQ_INPUT_USD_CENTS_PER_1M=10
GROQ_OUTPUT_USD_CENTS_PER_1M=30

# Bounded AI context (privacy/cost control) — the reply prompt replays the most
# recent 40 messages, capped by characters first
AI_CONTEXT_MESSAGE_LIMIT=40
AI_CONTEXT_CHARACTER_LIMIT=30000

# Async AI generation (in-app DB queue)
AI_ASYNC_POLL_MS=5000
AI_ASYNC_HOLDING_MESSAGE=Thank you for sharing that with me — I am still thinking on it and will be right here.

# Guardrails — input/output caps + per-student rate windows
AI_MAX_MESSAGE_CHARS=1200
AI_MAX_REPLY_CHARS=700
AI_RATE_LIMIT_DAILY=120
AI_RATE_LIMIT_PER_MINUTE=6

# Session-summary memory (requires the pgvector image from §3).
# This is the check-in's expiry: 3 = a conversation closes 180 s after the
# student's last message. A check-in has no turn cap — it ends here, or when
# the student taps "Complete".
AI_SESSION_IDLE_MINUTES=3
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Language layer
AI_LANGUAGE_OFFER_ENABLED=true
# 'n-atlas-translate' (the default, and what prod runs): the model writes the reply in
# English with full context + guardrails, then N-ATLaS renders the finished reply into the
# turn's language in the same request (falls back to an OpenAI render, then to English).
# 'openai-native' is the rollback if the vernacular endpoint is down.
AI_VERNACULAR_REPLY_MODE=n-atlas-translate
# N-ATLaS vernacular lane — the hosted HF Inference Endpoint (§5). This is NOT the Ollama
# lane any more: base URL = the endpoint origin with NO /v1 (the provider appends it),
# model = the repo id, key = the HF token (env-only, never echoed, never on AiConfig).
# Leave BASE_URL empty to route the vernacular lane straight to the OpenAI fallback.
NATLAS_LLM_BASE_URL=https://<endpoint-id>.endpoints.huggingface.cloud
NATLAS_LLM_MODEL=NCAIR1/N-ATLaS
NATLAS_LLM_API_KEY=<hf token>
NATLAS_LLM_TIMEOUT_MS=45000
NATLAS_RENDER_TIMEOUT_MS=12000
NATLAS_IDENTIFY_TIMEOUT_MS=4000
NATLAS_TRANSLATE_TIMEOUT_MS=10000

# Vernacular ASR — hosted NCAIR1 whisper fine-tunes, one HF Inference Endpoint
# per language (T4, scale-to-zero, ~3 min cold boot). The endpoints are
# 'authenticated', so NATLAS_ASR_API_KEY is an HF token — env-only, never here.
NATLAS_ASR_URL_YO=
NATLAS_ASR_URL_HA=
NATLAS_ASR_URL_IG=
NATLAS_ASR_API_KEY=
# Self-hosted alternative (§5) — a language's endpoint URL wins over this.
# Empty everywhere = yo/ha/ig voice gets a friendly 503.
NATLAS_ASR_BASE_URL=
NATLAS_ASR_TIMEOUT_MS=60000

# Staff enrolment secret; leave empty once staff accounts exist
STAFF_BOOTSTRAP_KEY=<openssl rand -hex 24>

# Object storage (RustFS from §4; empty S3_* = upload endpoints answer a friendly 503)
S3_ENDPOINT=https://s3.YOUR_VPS_IP.sslip.io
S3_REGION=us-east-1
S3_BUCKET=natlas-uploads
S3_ACCESS_KEY=<RUSTFS_ACCESS_KEY from the infra .env>
S3_SECRET_KEY=<its secret>
EOF
sudo chown root:natlas /opt/natlas/.env && sudo chmod 640 /opt/natlas/.env

# --- generate client, build, migrate, seed (prisma + seed load .env from the repo root)
npx prisma generate --config prisma7.config.ts
npm run build
npx prisma migrate deploy --config prisma7.config.ts
npm run seed
```

`/etc/systemd/system/natlas.service`:

```ini
[Unit]
Description=Natlas API (NestJS)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=natlas
WorkingDirectory=/opt/natlas
EnvironmentFile=/opt/natlas/.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/natlas

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now natlas
curl -s http://127.0.0.1:3000/api/health/auth   # {"authenticated":true,...}
sudo journalctl -u natlas -f                    # live logs (deploy isn't in systemd-journal)
```

**Release procedure** (repeatable, rollback-safe) — automated on merge to `main` by CI/CD (§12); this is the manual equivalent:

```bash
cd /opt/natlas
git pull
npm ci
npx prisma generate --config prisma7.config.ts
npm run build
npx prisma migrate deploy --config prisma7.config.ts
sudo systemctl restart natlas
curl -sf https://api.YOUR_VPS_IP.sslip.io/api/health/auth   # health gate; on failure: systemctl status natlas + journalctl
```

Rollback: `git checkout <previous-tag> && npm ci && npx prisma generate --config prisma7.config.ts && npm run build && sudo systemctl restart natlas`.

---

## 6A. Frontend on the VPS — the same-origin lane (this is what fixes iPhone)

**The problem this solves.** While the web app is hosted on Vercel and the API on
`api.YOUR_VPS_IP.sslip.io`, the session cookie is **third-party** to the page. The
backend therefore runs with `BETTER_AUTH_CROSS_SITE_COOKIES=true`, which makes
better-auth emit `SameSite=None; Secure` (§6) — Chrome and Edge still accept that,
**Safari on iOS does not**: its Intelligent Tracking Prevention drops third-party
cookies by default. The visible symptom is exactly "I can't access it on my phone":
sign-in POSTs succeed, the cookie is never stored, the very next request is
anonymous, and the app bounces the user back to sign-in or renders as unreachable.
Nothing in the app is broken — the browser refused to carry the credential.

**The fix is topology, not code.** Serve the frontend from the *same host* the API is
reached on, and the cookie becomes first-party: no SameSite exception, no CORS
preflight, no ITP case. nginx does the joining — `app.YOUR_VPS_IP.sslip.io` routes
`/api*` to the NestJS API on 127.0.0.1:3000 and everything else to the SSR server on
127.0.0.1:3200, so the browser only ever talks to one origin. The frontend's
`VITE_API_BASE_URL` is deliberately **empty**, which makes every call relative
(`src/lib/api.ts` → `fetch('/api/…')`, `src/lib/socket.ts` → falls back to
`window.location.origin`).

Do not delete the `api.` vhost yet: it is what the Vercel deployment (and the probes
in `test/*.mjs`) still use, and `BETTER_AUTH_CROSS_SITE_COOKIES=true` keeps that
combination working — a `None` cookie is still fine first-party. Flip it to `false`
only once Vercel is retired (step 5 below).

**Steps 1–4 are scripted.** `deploy/vps-frontend-same-origin.sh` runs the whole lane
from the deployed backend checkout — key, clone, unit, release script, certificate,
vhost, `.env` origins, first build, acceptance curls — and is idempotent, so it can be
re-run at any point:

```bash
ssh -p 2222 deploy@YOUR_VPS_IP
bash /opt/natlas/deploy/vps-frontend-same-origin.sh      # as deploy, never root
```

On today's repo it never pauses: `Brobot64/soulnurture-frontend` is **public**, so step 2 probes
anonymous HTTPS (`GIT_TERMINAL_PROMPT=0`) and clones with no credential — nothing is minted and
nothing is pasted into GitHub. The pause exists only for the private-repo fallback, where the
installer mints a read-only keypair and exits 0 for you to paste the public half; re-run it after.
Pass `--skip-api-env` to leave `/opt/natlas/.env` alone, `-y` to skip the restart
prompt. The sections below stay as the manual reference for what it changes and why.

### 1. One-time server setup

The frontend is a second repo the `deploy` user clones and builds; its `.output/` and
`node_modules/` are untracked, exactly like the backend's.

**If the repo is public, no credential is needed** — and that is the smaller-blast-radius
choice, so the installer probes for it first (`GIT_TERMINAL_PROMPT=0 git ls-remote
https://github.com/Brobot64/soulnurture-frontend HEAD`) and clones over anonymous HTTPS
when that answers. `Brobot64/soulnurture-frontend` is public today, verified from the box
on 2026-10-25, so the lane runs with no new key at all. Make it private later and the
same script switches to the deploy-key path below and pauses once for the paste — a
GitHub deploy key is bound to exactly one repository, so the API's
`~deploy/.ssh/natlas_github` key (§12) cannot be reused here; it would be rejected as
"already in use". Mint a second read-only pair and reach it through a Host alias, leaving
the API's fetch path untouched:

```bash
sudo -u deploy ssh-keygen -t ed25519 -a 100 -f /home/deploy/.ssh/natlas_github_frontend \
  -N '' -C 'natlas-vps-frontend-pull'
cat /home/deploy/.ssh/natlas_github_frontend.pub
# GitHub → Brobot64/soulnurture-frontend → Settings → Deploy keys → Add (read-only, NO write access)

cat >> /home/deploy/.ssh/config <<'EOF'
Host github-frontend
  HostName github.com
  User git
  IdentityFile ~/.ssh/natlas_github_frontend
  IdentitiesOnly yes
EOF
# pin GitHub's host key under the new alias too (same fingerprint as §12), or fetch dies with
# "Host key verification failed" on the first deploy
ssh-keyscan -t ed25519 github.com >> /home/deploy/.ssh/known_hosts
sudo -u deploy chown deploy:deploy /home/deploy/.ssh/config /home/deploy/.ssh/known_hosts

sudo -u deploy git clone git@github-frontend:Brobot64/soulnurture-frontend.git /opt/natlas-frontend
sudo -u deploy ssh -T git@github-frontend    # "Hi Brobot64/soulnurture-frontend!" = the key works
cd /opt/natlas-frontend && sudo -u deploy git remote -v   # must show github-frontend, not github.com
```

`natlas-frontend.service` lives in the repo at
[`deploy/natlas-frontend.service`](deploy/natlas-frontend.service) (same hardening
posture as `natlas.service`; nitro's Node server reads `PORT`/`HOST` from the
environment; nitro needs no `EnvironmentFile` because every value it uses is baked at
build time). The installer `install`s it to `/etc/systemd/system/` and **enables
without starting** — the unit would otherwise restart-loop on a `.output/` that does
not exist yet, and the release script builds first and then restarts.

Manual equivalent, once the file is in place:

```bash
sudo install -m 0644 /opt/natlas/deploy/natlas-frontend.service /etc/systemd/system/natlas-frontend.service
sudo systemctl daemon-reload && sudo systemctl enable natlas-frontend
# 3200, deliberately: Loki already publishes 127.0.0.1:3100 on this box, so that port
# can never be the frontend's. Before a build exists there is nothing to answer on 3200.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/
```

### 2. `/usr/local/bin/natlas-frontend-deploy` (root-owned, 755)

The lane is
[`deploy/natlas-frontend-deploy.sh`](deploy/natlas-frontend-deploy.sh); the installer
`install`s it to `/usr/local/bin/natlas-frontend-deploy`. It is run as `deploy` and
refuses root, because the npm output must stay deploy-owned — the `natlas` service
user only needs read access to `dist`/`.output`, which group perms already give it
(`.output` and `node_modules` are untracked, exactly like the backend's).

Mirror of `natlas-deploy` (§12): single-flight (`flock -n`), marker written only after
the health gate passes, auto-rollback that rebuilds the last-known-good revision
instead of leaving the service pointing at a broken bundle. Two things it guards that
a plain build does not:

- **`VITE_API_BASE_URL=` empty, not unset.** `.env` is gitignored in the frontend
  repo, so a fresh clone has no value at all and `src/lib/api.ts` would fall back to
  `http://localhost:3000` — every student's phone calling its own localhost. An empty
  base makes every call relative, which is what keeps the cookie first-party.
  `NITRO_PRESET=node_server` overrides platform detection only here; Vercel's own
  build keeps its preset.
- **A build guard.** It greps `.output/public` and `.output/server` for an absolute
  API origin (`localhost:3000`, `sslip.io`) and refuses to deploy one, because a
  baked-in absolute origin re-creates the iOS third-party-cookie bug silently.

The health gate is not just a port check: it requires the SSR response to contain
`<html`, so a server that boots and holds the port open while erroring every request
still fails the gate and rolls back. On the first live run that is exactly what saved
the box: the lane had picked 127.0.0.1:3100, which Loki in the monitoring stack already
publishes, so the gate found a listening socket answering for somebody else's service
and refused to mark the release deployed — instead of nginx quietly routing a student's
page request into a log database. `vps-frontend-same-origin.sh` now takes
`FRONTEND_PORT` (3200), refuses to install a lane whose unit, release script and vhost
disagree about it, and refuses to start if something that is not `node` already holds it.

```bash
ssh -p 2222 deploy@YOUR_VPS_IP /usr/local/bin/natlas-frontend-deploy   # as deploy — it refuses root
```

The `vite build` is the heaviest thing this server does — nothing holds a model here any more (§5),
so the build is the peak. If it dies with exit 137, that is the OOM killer and swap (§1) is what
makes the retry succeed.

### 3. Backend `.env` for the new origin

Add the app origin wherever an origin is checked (the `api.` entries stay while
Vercel is live). The installer does this for you — it appends to whatever is already
listed rather than overwriting, backs `.env` up first, restarts only when something
actually changed, asks before that restart, and restores the old file if the API then
fails its health gate. `--skip-api-env` leaves it entirely in your hands. Manual
equivalent:

```bash
ALLOWED_ORIGINS=https://app.YOUR_VPS_IP.sslip.io,https://<project>.vercel.app
BETTER_AUTH_TRUSTED_ORIGINS=https://app.YOUR_VPS_IP.sslip.io,https://<project>.vercel.app
WEB_APP_URL=https://app.YOUR_VPS_IP.sslip.io   # emailed verify links land in the app
```

then `sudo systemctl restart natlas`. `BETTER_AUTH_URL` stays
`https://api.YOUR_VPS_IP.sslip.io` — it is the API's own canonical URL, and
better-auth accepts the app origin through the trusted-origins list above. The restart
is not optional: all three are read once at boot
(`src/auth/auth.config.ts` falls back to the first concrete trusted origin when
`WEB_APP_URL` is unset, which is how a wildcard entry can otherwise become a redirect
target it is not allowed to be). `ALLOWED_ORIGINS` gates two things, not one — the
HTTP CORS layer (`src/main.ts:22`) and the socket.io handshake
(`src/realtime/realtime.gateway.ts:19`) — so an origin missing from it fails chat
silently rather than loudly.

### 4. First deploy + verification

The installer covers all of this too (it reissues the certificate only when the
lineage genuinely lacks `app.`, renders and appends the vhost behind `nginx -t`, then
runs the first release and prints both acceptance curls). Manual equivalent:

```bash
sudo certbot certonly --webroot -w /var/www/html --cert-name api.YOUR_VPS_IP.sslip.io \
  -d api.YOUR_VPS_IP.sslip.io -d app.YOUR_VPS_IP.sslip.io \
  -d s3.YOUR_VPS_IP.sslip.io -d monitor.YOUR_VPS_IP.sslip.io \
  --agree-tos -m you@example.com --non-interactive   # same lineage → one renewal
sudo nginx -t && sudo systemctl reload nginx          # after adding the app vhost (§7)
ssh -p 2222 deploy@YOUR_VPS_IP /usr/local/bin/natlas-frontend-deploy   # as deploy — the script refuses root
```

Then, in this order — each step rules out a different failure:

```bash
curl -sI https://app.YOUR_VPS_IP.sslip.io/ | head -3          # SSR over TLS
curl -s  https://app.YOUR_VPS_IP.sslip.io/api/health/auth     # /api joined to the same origin
# the cookie a browser would receive: first-party, so SameSite=Lax is enough
curl -si -X POST https://app.YOUR_VPS_IP.sslip.io/api/auth/sign-in/email \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"x"}' \
  | grep -i '^set-cookie' | cut -c1-120
```

The `set-cookie` line is the acceptance test for the iPhone report, and it has to be
read **from the app origin**: a cookie whose `Domain` is the API host, or a response
that only works on `api.`, means the lane is not actually same-origin. Sign in on an
iPhone (Safari → Settings → Advanced → ADB or a Mac's Web Inspector over USB) and
confirm `/api/auth/get-session` returns the user on the second request instead of
401 — that single check is what was impossible while the page and the API were two
hosts.

### 5. Retiring Vercel (optional, later)

Nothing about the VPS lane requires this, and doing it early costs the fallback. When
you choose to: in `/opt/natlas/.env` drop the `vercel.app` entries from both origin
lists and set `BETTER_AUTH_CROSS_SITE_COOKIES=false` (with the page and API on one
origin, `Lax` is enough and is the safer default), then `sudo systemctl restart
natlas`. Existing sessions survive — only the cookie attributes change. Keep the
`api.` vhost: `test/*.mjs` probes and any direct API use still point at it.

---

## 7. Nginx + TLS (the only public door)

```bash
sudo apt install -y nginx certbot
```

`/etc/nginx/sites-available/natlas`:

```nginx
# Socket.IO upgrade mapping (http context — this file is included there):
# forwards `Connection: upgrade` only when the client actually requested an
# upgrade, so plain HTTP on the same path (engine.io polling fallback) still
# gets `Connection: close`.
#
# NOT INSTALLED ON THE PROD BOX (verified 2026-10-25): no `map` exists anywhere
# under /etc/nginx, and the live api. vhost has been setting
# `proxy_set_header Connection "upgrade";` literally since October — with the
# socket websocket-only by design, that works and polling was never the path.
# `deploy/nginx-app-vhost.conf` therefore copies the INSTALLED form, not this
# document: referencing $connection_upgrade without the map is an [emerg] that
# fails `nginx -t`. Either install the map here or keep every vhost literal; what
# must not happen is a doc and a box describing different configs.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

# --- API ---
server {
  listen 80;
  server_name api.YOUR_VPS_IP.sslip.io;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl http2;
  server_name api.YOUR_VPS_IP.sslip.io;

  ssl_certificate     /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/privkey.pem;

  client_max_body_size 12m;                 # matches backend multipart cap (voice notes)
  add_header X-Frame-Options DENY always;
  add_header X-Content-Type-Options nosniff always;
  add_header Strict-Transport-Security "max-age=31536000" always;

  # --- Socket.IO (chat pool / notifications / unread badges) — the upgrade
  #     dance needs explicit headers (plain proxying strips the upgrade), and
  #     the socket is long-lived: the 60s default read timeout would keep
  #     killing idle connections. Backend path constant: /api/socket.io.
  location /api/socket.io {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
  }
}

# --- Web app, same-origin (§6A) — the two server blocks for
#     app.YOUR_VPS_IP.sslip.io are NOT duplicated here: they live in
#     deploy/nginx-app-vhost.conf, which deploy/vps-frontend-same-origin.sh renders
#     (@@APP_HOST@@/@@API_HOST@@/@@SSR_PORT@@) and appends to this file with a timestamped
#     backup and `nginx -t` restore-on-failure. Edit that file, not the installed copy; a
#     re-run re-stamps the block if the installed one drifted from the checkout.
#     Shape: /api/socket.io (upgrade headers + 3600s timeouts) → /api → / to the SSR
#     server on 127.0.0.1:3200, with no caching headers on purpose — the page renders
#     per request and the session is in the cookie, so an intermediary cache with a
#     shared key would serve one student's signed-in shell to another. It reuses the
#     api. cert lineage, and needs nothing from CORS because the browser only ever
#     sees one origin.

# --- RustFS (S3 API + console) — client_max_body_size raised for direct PUTs
# (one SAN cert covers all four hostnames → every block loads the api. lineage)
server {
  listen 80;
  server_name s3.YOUR_VPS_IP.sslip.io;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl http2;
  server_name s3.YOUR_VPS_IP.sslip.io;
  ssl_certificate     /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/privkey.pem;
  client_max_body_size 512m;

  # blocklist: deny public bucket listings, allow presigned ops
  location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

# --- Grafana (monitor.YOUR_VPS_IP.sslip.io) — Grafana's own login is the gate
server {
  listen 80;
  server_name monitor.YOUR_VPS_IP.sslip.io;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl http2;
  server_name monitor.YOUR_VPS_IP.sslip.io;
  ssl_certificate     /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.YOUR_VPS_IP.sslip.io/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
# 1) Issue certificates FIRST, while the stock nginx default site is still the
#    only vhost — it already serves /var/www/html, so the webroot challenge
#    works before any natlas vhost exists (cert --nginx would fail here: the
#    vhost config references cert files that don't exist yet).
sudo certbot certonly --webroot -w /var/www/html \
  -d api.YOUR_VPS_IP.sslip.io -d app.YOUR_VPS_IP.sslip.io -d s3.YOUR_VPS_IP.sslip.io -d monitor.YOUR_VPS_IP.sslip.io \
  --agree-tos -m you@example.com --non-interactive \
  --deploy-hook "systemctl reload nginx"

# 2) Now enable the vhosts (certs exist → nginx -t passes) and drop the stock site.
#    sites-enabled is a GLOB (`include /etc/nginx/sites-enabled/*`), so anything you
#    drop in there is live config. Backups go in sites-available, where nginx never
#    reads them — `sites-enabled/` must hold symlinks only.
#    PROD TRIPWIRE FOUND 2026-10-25: `sites-enabled/natlas.bak-20261011` is a plain
#    file, so every api./s3./monitor. server block is defined twice and `nginx -t`
#    warns "conflicting server name … ignored" on every single reload. Harmless only
#    by ordering luck — `natlas` sorts first, so the current file wins and the stale
#    copy is the one dropped — but a renamed site file or a reordered glob would put
#    the October-11 config back in production. It belongs in /root, not there.
sudo ln -s /etc/nginx/sites-available/natlas /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# auto-renewal: certbot.timer renews twice daily via the recorded webroot
# plugin (the acme-challenge location blocks above keep that working after
# the redirect vhosts go live). Verify + prove renewal:
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 8. Observability — Prometheus, Grafana, Loki

### Prometheus scrape config

`/opt/infra/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: node
    static_configs: [{ targets: ["node-exporter:9100"] }]
  - job_name: cadvisor
    static_configs: [{ targets: ["cadvisor:8080"] }]
  - job_name: postgres
    static_configs: [{ targets: ["postgres-exporter:9187"] }]
  - job_name: blackbox-api
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets:
          - "https://api.YOUR_VPS_IP.sslip.io/api/health/auth"   # public door, through nginx
          - "http://127.0.0.1:3000/api/health/auth"              # native API directly
          - "https://app.YOUR_VPS_IP.sslip.io/"                  # the page itself (§6A): a dead SSR
                                                                  # box leaves the API green
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: "host.docker.internal:9115" }
  - job_name: blackbox-s3
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets: ["https://s3.YOUR_VPS_IP.sslip.io/health"]
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { target_label: __address__, replacement: "host.docker.internal:9115" }
  # Optional, and currently the only thing that answers on :11434 is the retired Ollama
  # install (§5 fallback A). Keep this job while you may still bring that lane back; delete
  # it together with the unit when you do not. It proves nothing about the vernacular lane
  # that actually serves: the hosted endpoint needs a Bearer token, which does not belong in
  # a monitoring container. Alert on the queue instead (see the rules below) — a silently
  # falling-back lane shows up as failed AI jobs, not as a dead port on this box.
  - job_name: blackbox-ollama
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets: ["http://127.0.0.1:11434/api/tags"]
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { target_label: __address__, replacement: "host.docker.internal:9115" }
```

> How the probe path works: **blackbox-exporter runs with `network_mode: host`** (compose §3), so it dials the native services bound to `127.0.0.1` directly. Prometheus reaches it via `host.docker.internal:9115` (the `extra_hosts` alias on the prometheus service in §3). One caveat: traffic from the Docker bridge to a host port hits the ufw INPUT chain, so allow it explicitly — `sudo ufw allow from 172.16.0.0/12 to any port 9115 proto tcp`.

`/opt/infra/postgres-exporter/queries.yaml` — **Natlas-specific metrics** (the flag/queue depth a counsellor lead cares about):

```yaml
natlas_custom:
  query: |
    SELECT
      (SELECT count(*) FROM ai_generation_job WHERE status = 'PENDING') AS ai_jobs_pending,
      (SELECT count(*) FROM ai_generation_job WHERE status = 'FAILED')  AS ai_jobs_failed,
      (SELECT count(*) FROM support_flag WHERE status IN ('OPEN','IN_REVIEW','ESCALATED')) AS support_flags_open,
      (SELECT count(*) FROM support_request WHERE status = 'ESCALATED') AS support_requests_escalated
  metrics:
    - ai_jobs_pending:        {usage: "GAUGE"}
    - ai_jobs_failed:         {usage: "GAUGE"}
    - support_flags_open:     {usage: "GAUGE"}
    - support_requests_escalated: {usage: "GAUGE"}
```

Loaded by the `command:` flags on the compose service (§3) — v0.15.x **ignores** the old `EXTEND_QUERY_PATH` env var. Exported names carry the collector prefix: `natlas_custom_ai_jobs_pending`, `natlas_custom_ai_jobs_failed`, `natlas_custom_support_flags_open`, `natlas_custom_support_requests_escalated` — use the prefixed names in dashboards and alerts.

### Grafana provisioning

`/opt/infra/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - { name: Prometheus, type: prometheus, url: http://prometheus:9090, isDefault: true }
  - { name: Loki, type: loki, url: http://loki:3100 }
```

Import dashboards: **Node Exporter Full (ID 1860)**, **PostgreSQL Database (9628)**, **cAdvisor (14282)** — plus a small custom panel row fed by the `natlas_custom` metrics above (e.g. `natlas_custom_ai_jobs_pending`, `natlas_custom_support_flags_open`). The full operator's guide — dashboards, the alert rules with exact setup steps, log queries, incident triage — is **`docs/MONITORING.md`**.

### Logs (Loki + Promtail)

`/opt/infra/promtail/promtail.yaml` — ships all of journald (NestJS, the frontend SSR server, nginx, ollama) into Loki:

```yaml
server: { http_listen_port: 9080 }
positions: { filename: /tmp/positions.yaml }
clients: [{ url: http://loki:3100/loki/api/v1/push }]
scrape_configs:
  - job_name: journal
    journal: { max_age: 24h, labels: { job: journal } }
    relabel_configs:
      - { source_labels: ["__journal__systemd_unit"], target_label: unit }
      - { source_labels: ["__journal_syslog_identifier"], target_label: syslog_id }
```

Grafana → Explore → Loki → `{unit="natlas.service"}` gives you the API logs, `{unit="natlas-frontend.service"}` the SSR server, and `{syslog_id="ollama"}` the retired local model lane (§5) — still collected, still harmless, only interesting if you bring that fallback back.

### Alerting (Grafana → Alerting → Alert rules)

**Heads-up:** with the runbook default, `GF_SMTP_HOST` is `smtp.ethereal.email` — a throwaway test inbox; email alerts **never reach a real address** until real `GF_SMTP_*` values go into `/opt/infra/.env` and grafana is recreated (`cd /opt/infra && sudo docker compose up -d grafana`). Contact-point setup and the full warning live in `docs/MONITORING.md`.

Minimum viable rules (evaluate every 1m, notify via the SMTP contact point):

| Alert | Condition |
|---|---|
| API down | `probe_success{job="blackbox-api"} == 0 for 2m` |
| Web app page down (the SSR lane, §6A) | `probe_success{instance=~"app\\..*"} == 0 for 2m` — the API stays green when `natlas-frontend` dies, so this needs its own rule **and** the app target above in the live `prometheus.yml` (as of 2026-10-28 the box probes `api.` public + native only, so this row is a to-do, not a description) |
| RustFS (S3) down | `probe_success{job="blackbox-s3"} == 0 for 2m` |
| Disk filling | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes < 0.15` |
| Memory pressure | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` |
| AI queue stuck | `natlas_custom_ai_jobs_pending > 10 for 15m` |
| AI jobs failing | `delta(natlas_custom_ai_jobs_failed[15m]) > 0` — a GAUGE of FAILED rows, so ask whether it moved (`increase()` is meaningless here; `> 0` on the gauge would page forever) |
| Safeguarding backlog | `natlas_custom_support_flags_open > 5 for 30m` |

The two AI rows are what tells you the **hosted vernacular lane** is degraded: the models are off-box (§5), so no port on this server goes red when an endpoint sleeps, pauses for billing, or starts answering 503 — the jobs land in `FAILED` instead. `Ollama down` (`probe_success{job="blackbox-ollama"} == 0 for 5m`) is deliberately **not** in the minimum set: that port belongs to the retired local lane, and paging for it would page for a service nothing calls.

---

## 9. Backups (persistence guarantee)

`/etc/cron.d/natlas-backups` (as root):

```cron
30 2 * * * deploy cd /opt/infra && docker compose exec -T postgres pg_dump -U natlas natlas | gzip > /opt/backups/natlas-$(date +\%F).sql.gz
40 2 * * * deploy . /opt/infra/.env && export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY" && aws --endpoint-url http://127.0.0.1:9000 s3 sync s3://natlas-uploads /opt/backups/rustfs
0  3 * * * root find /opt/backups -name 'natlas-*.sql.gz' -mtime +14 -delete
```

```bash
sudo mkdir -p /opt/backups && sudo chown deploy:deploy /opt/backups
sudo systemctl restart cron
```

Recommended upgrade later: `rclone` the `/opt/backups` directory to off-site storage (Backblaze B2 / Wasabi / even another VPS) — same-machine backups die with the machine.

Also keep copies of `/opt/infra/.env` and `/opt/natlas/.env` in a password manager: a backup you can't get the credentials for is no backup.

---

## 10. Go-live checklist

```bash
# system
systemctl status natlas natlas-frontend nginx docker --no-pager
docker compose -f /opt/infra/docker-compose.yml ps

# endpoints (from the internet)
curl -s https://api.YOUR_VPS_IP.sslip.io/api/health/auth
curl -s https://s3.YOUR_VPS_IP.sslip.io/health
# grafana login: https://monitor.YOUR_VPS_IP.sslip.io

# model lane — there is nothing to run locally: N-ATLaS and the three vernacular
# ASR models are hosted off-box (§5). The honest go-live checks are therefore
# (a) that the app is configured to reach them, and (b) that a real turn records it.
ssh -p 2222 deploy@YOUR_VPS_IP 'for k in NATLAS_LLM_BASE_URL NATLAS_LLM_API_KEY AI_VERNACULAR_REPLY_MODE NATLAS_ASR_URL_YO NATLAS_ASR_URL_HA NATLAS_ASR_URL_IG NATLAS_ASR_API_KEY; do printf "%s=%s\n" "$k" "$(grep -cE "^$k=." /opt/natlas/.env)"; done'   # every line 1
# (a) is counts, never values. Then (b): warm the endpoint FIRST — a sleeping one
# takes 10–16 min to wake and every app timeout is in seconds, so an un-warmed run
# "proves" the fallback works and nothing else.
test/yoruba-live-probe.mjs          # writes prod data: owner's call, not an agent's
test/conversation-inspector.mjs     # read-back of aiPayload.understanding.via / render
# Old check, retired with the Ollama lane — it cannot pass any more because the box
# deliberately holds no model: `ollama list && ollama run natlas "Say hello in Hausa"`.
# If you see it in a runbook or a CI step, delete it; it measured topology, not quality.

# full-system E2E (run against a STAGING database first — the journeys
# clean only their own synthetic users, but keep them out of the prod DB)
E2E_BASE_URL=https://api.YOUR_VPS_IP.sslip.io npm run test:e2e:journey
E2E_BASE_URL=https://api.YOUR_VPS_IP.sslip.io npm run test:e2e:school-chat

# Web app, same-origin lane (§6A) — the page AND the API through the page's host
curl -s -o /dev/null -w '%{http_code}\n' https://app.YOUR_VPS_IP.sslip.io/
curl -s https://app.YOUR_VPS_IP.sslip.io/api/health/auth
# WebSocket upgrade through nginx (expect "HTTP/1.1 101 Switching Protocols").
# --http1.1 is not decoration: over HTTP/2 curl drops the Upgrade headers and the
# socket.io path answers this backend's Nest 404 envelope, which reads as a dead lane.
# A plain GET on /api/socket.io ALWAYS 404s (the gateway is websocket-only,
# src/realtime/realtime.gateway.ts:39) — the upgrade is the only honest socket check.
curl -si --http1.1 -m 6 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://api.YOUR_VPS_IP.sslip.io/api/socket.io/?EIO=4&transport=websocket" | head -1
# …and the same through the app host, which is what a browser actually uses. Send its
# Origin too: the gateway filters on ALLOWED_ORIGINS and answers 400 for an origin it
# does not know, so 101-with-Origin is the proof that §6A step 3 actually took effect.
curl -si --http1.1 -m 6 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://app.YOUR_VPS_IP.sslip.io" \
  "https://app.YOUR_VPS_IP.sslip.io/api/socket.io/?EIO=4&transport=websocket" | head -1
```

Final checks: Grafana shows all scrape targets UP · alert test notification arrives · `journalctl -u natlas` shows the AI worker start line ("AI async worker started") · attribution string present in the product footer · `STAFF_BOOTSTRAP_KEY` differs from dev · **a real iPhone signs in on `https://app.YOUR_VPS_IP.sslip.io` and stays signed in through a page reload** (desktop browsers cannot detect this class of failure — see §6A — so an iPhone is the only honest test).

---

## 11. Day-2 operations quick reference

| Task | Command |
|---|---|
| API logs | `sudo journalctl -u natlas -f` |
| Vernacular lane health | **Not on this box** (§5): endpoint state via the Hugging Face Endpoints MCP (`get_endpoint`, `get_endpoint_replicas`). `ollama ps` · `curl -s localhost:127.0.0.1:11434/api/tags` only if you revived fallback A |
| Restart API | `sudo systemctl restart natlas` |
| Restart infra | `cd /opt/infra && docker compose restart` |
| Upgrade all containers | `docker compose pull && docker compose up -d` |
| Disk usage triage | `docker system df` · `df -h /` · journal size: `journalctl --disk-usage` |
| Change the N-ATLaS model | hosted: update the endpoint through the MCP (`update_endpoint`) and keep `--max-model-len 16384` plus the pinned revision — the box holds no weights. Fallback A only: re-run `hf download` → `ollama create natlas -f Modelfile` (zero-downtime: the worker retries while Ollama reloads) |
| DB backup restore | see §3 restore drill |
| New release | merge to `main` — CI/CD deploys automatically (§12); manual: §6 |
| Frontend release (same-origin lane) | manual + verified: `ssh -p 2222 deploy@YOUR_VPS_IP /usr/local/bin/natlas-frontend-deploy`, then confirm `cat /home/deploy/.natlas-frontend-last-deploy` moved (§12 explains why the marker, not the workflow, is the proof). The `.github/workflows/deploy-vps.yml` automation is on the frontend's `main` but has not yet completed a run |
| Frontend lane install/repair | `bash /opt/natlas/deploy/vps-frontend-same-origin.sh` (§6A) — idempotent; re-run it after any box rebuild. The Deploy Key path only matters if `Brobot64/soulnurture-frontend` goes private; it is public, so the installer clones over anonymous HTTPS and mints no credential |
| Frontend logs / status | `sudo journalctl -u natlas-frontend -f`, `systemctl status natlas-frontend` |

---

## 12. CI/CD — deploy on merge to `main`

`.github/workflows/deploy.yml` (in the repo) drives the lane:

```
push/PR   → CI job: npm ci → oxlint → vitest → build
main push → deploy job: SSH :2222 (forced command) → /usr/local/bin/natlas-deploy
```

The deploy job checks out nothing and holds no server password — the GitHub secret can do exactly one thing: trigger the deploy script.

**The frontend lane (§6A) is automated by its own key, not this repo's.** `restrict,command=` pins
one key to one script, so the frontend CI uses a *second* keypair — private half in the frontend
repo's Actions secrets as `FRONTEND_VPS_SSH_KEY`, public half installed for `deploy` as
`restrict,command="/usr/local/bin/natlas-frontend-deploy" … github-actions-frontend-vps-deploy`.
The API's key must never gain the ability to restart the app host, and it has not: `~deploy/.ssh/authorized_keys`
holds three entries (laptop, API deploy, frontend deploy) and each of the two deploy keys forces a
different script. Verified by asking that key for `echo ATTEMPTED_SHELL` and for `cat /etc/shadow`
and receiving the deploy script's output both times — a forced command replaces whatever the client
asks for, so the key's whole reach is "rebuild `main` and restart `natlas-frontend`". The workflow is
`.github/workflows/deploy-vps.yml` in `Brobot64/soulnurture-frontend` (merged to its `main` as
`73f3391`); it runs no build on the runner because the release is only real once the artifact the box
serves passes `natlas-frontend-deploy`'s health gate, and it needs no repo credential because that
repo is public and the box pulls over anonymous HTTPS. A failed build or a failed gate exits
non-zero, which fails the Actions run, which is what GitHub's own "Failures" notification emails —
the workflow sends nothing, so nothing here can silently stop sending it.

**Merged is not the same as proven.** Checked on the box 2026-10-28: `~deploy/.natlas-frontend-last-deploy`
still reads `3e641ce` and `natlas-frontend` has not restarted since the 2026-10-25 install, while the
frontend's `main` is at `73f3391`. So the automation has never completed a *successful* run (any run
that got as far as the health gate would have moved that marker) — the marker is the
evidence, and "the workflow file is on `main`" is not. The likeliest cause is the repo secret
`FRONTEND_VPS_SSH_KEY` (the workflow refuses to run and says so when it is absent), then Notifications
→ Actions → Failures never being enabled, which means nobody was mailed about the failure. Read the run
at `github.com/Brobot64/soulnurture-frontend/actions` before believing the lane is live; until it has
written a marker, a frontend release is still `ssh -p 2222 deploy@YOUR_VPS_IP /usr/local/bin/natlas-frontend-deploy`,
and the script is idempotent, so re-running it is never a hazard.

### One-time server setup

**1. `/usr/local/bin/natlas-deploy`** (root-owned, 755) — single-flight, health-gated, auto-rollback:

```bash
#!/usr/bin/env bash
# natlas-deploy — production deploy lane. Invoked by GitHub Actions over SSH as a
# forced command (§12) or manually: /usr/local/bin/natlas-deploy
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

if [ "$(id -un)" = "root" ]; then
  echo "run as deploy, not root (npm output must stay deploy-owned)" >&2
  exit 1
fi

cd /opt/natlas
exec 9>/tmp/natlas-deploy.lock
flock -n 9 || { echo "another deploy is already running; aborting"; exit 1; }

# The marker is written ONLY after the health gate passes, so a run that dies
# mid-deploy (npm ci, build, migrate, seed) is still "not deployed" and reruns.
# Comparing git HEAD instead would silently skip redeploys after partial failures.
MARKER="$HOME/.natlas-last-deploy"
LAST=$(cat "$MARKER" 2>/dev/null || git rev-parse HEAD)

git fetch origin
git checkout -f main
# deterministic: server tree is exactly origin/main (local junk is discarded;
# .env and node_modules are untracked and survive)
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
if [ "$LAST" = "$NEW" ]; then
  echo "already deployed at $(git rev-parse --short "$NEW"); nothing to do"
  exit 0
fi

npm ci
npx prisma generate --config prisma7.config.ts
npm run build
npx prisma migrate deploy --config prisma7.config.ts
npm run seed
sudo systemctl restart natlas

# health gate: the deploy only counts if the API comes back up
for _ in $(seq 1 20); do
  sleep 2
  if curl -sf -m 5 http://127.0.0.1:3000/api/health/auth >/dev/null; then
    echo "$NEW" > "$MARKER"
    echo "DEPLOY OK: $(git rev-parse --short "$LAST") -> $(git rev-parse --short "$NEW")"
    exit 0
  fi
done

echo "HEALTH GATE FAILED after deploying $(git rev-parse --short "$NEW"); rolling code back to $(git rev-parse --short "$LAST")" >&2
# Migrations are additive-only and stay applied; old code tolerates the newer schema.
git reset --hard "$LAST"
npm ci
npx prisma generate --config prisma7.config.ts
npm run build
sudo systemctl restart natlas
exit 1
```

Properties worth knowing: `flock` prevents overlapping deploys (CI additionally queues with a `concurrency` group — belt and suspenders); the health gate gives the API ~40s to answer `/api/health/auth` before rolling back; rollback keeps newer migrations applied (additive-only, old code tolerates the newer schema); `npm run seed` is idempotent upserts, safe on every deploy.

**2. Forced-command key for GitHub Actions** — last line of `~deploy/.ssh/authorized_keys`:

```
restrict,command="/usr/local/bin/natlas-deploy" ssh-ed25519 AAAA… natlas-github-actions
```

`restrict` + forced `command` means the key can *only* ever run the deploy — no shell, no forwarding, no sftp — even if `VPS_SSH_KEY` leaks out of GitHub.

**3. Read-only pull key** — `~deploy/.ssh/natlas_github` plus `~deploy/.ssh/config`:

```
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/natlas_github
  IdentitiesOnly yes
```

`/opt/natlas` remote: `git@github.com:Brobot64/soulnurture.git`.

Also pin GitHub's host key into `~deploy/.ssh/known_hosts` — without it every fetch dies with `Host key verification failed` (verify the fingerprint against https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints before trusting the scan):

```bash
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts   # then chmod 600 and check: ssh-keygen -lf ~/.ssh/known_hosts
# expect: 256 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com (ED25519)
```

### One-time GitHub setup

1. **Deploy key (pull access)**: repo Settings → Deploy keys → add the server's `~/.ssh/natlas_github.pub` (`ssh -p 2222 deploy@169.58.86.169 'cat ~/.ssh/natlas_github.pub'`). Read-only — do **not** tick "Allow write access".
2. **Secret (deploy trigger)**: Settings → Secrets and variables → Actions → new secret **`VPS_SSH_KEY`** = the private half of the `natlas-actions` keypair (laptop: `~/.ssh/natlas-actions`).
3. The workflow pins the VPS host key in `known_hosts`, so CI refuses to connect if the server key ever changes.
4. Optional hardening: give the `production` environment (Settings → Environments) a required reviewer to get a manual approval gate before deploys.

### Operating it

- Merge to `main` → CI gates run on the pushed commit → deploy job fires → look for `DEPLOY OK: <old> -> <new>` in the Actions log (https://github.com/Brobot64/soulnurture/actions).
- Manual deploy: `ssh -p 2222 deploy@169.58.86.169` then `/usr/local/bin/natlas-deploy` — same script, same guarantees.
- Roll back a bad-but-healthy release by reverting the commit on `main` and pushing; CI deploys the revert.
- `/opt/natlas` tracks `origin/main`; pushes that don't change the commit are no-ops ("already deployed at <sha>; nothing to do").
- **First deploy after enabling the lane**: `/opt/natlas` sits at the pre-Phase-C baseline, so the first merge of the feature branches jumps it forward — expect a long deploy (fresh `npm ci` + all pending migrations + seed). The pgvector `SessionSummary` migration is fine: `natlas` is the superuser inside the Postgres container.
