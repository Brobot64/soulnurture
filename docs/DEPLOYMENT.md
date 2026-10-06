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
| `api.YOUR_VPS_IP.sslip.io` | NestJS backend (this repo) |
| `s3.YOUR_VPS_IP.sslip.io` | MinIO object storage (S3 API + console) |
| `monitor.YOUR_VPS_IP.sslip.io` | Grafana dashboards |

Swapping in a real domain later: point its `A` records at the same IP, update `server_name` and the
env hostnames, re-run the certbot command (§7), reload nginx — nothing else changes.
SSH runs on **port 2222** throughout (§1): `ssh -p 2222 deploy@YOUR_VPS_IP`.

---

## 0. What runs where (and why)

| Component | Runtime | Port (bind) | Memory cap | Persistence |
|---|---|---|---|---|
| NestJS API | systemd (`natlas.service`), native Node 22 | 127.0.0.1:3000 | ~512 MB | — (stateless) |
| N-ATLaS LLM | Ollama (native, systemd) | 127.0.0.1:11434 | ~6 GB (model resident) | `/opt/ollama/models` |
| PostgreSQL 17 | Docker Compose | 127.0.0.1:5432 | 1.5 GB | named volume `pgdata` |
| MinIO (S3) | Docker Compose | 127.0.0.1:9000 / 9001 | 512 MB | named volume `minio-data` |
| Prometheus | Docker Compose | 127.0.0.1:9090 | 512 MB | volume `prom-data` |
| Grafana | Docker Compose | 127.0.0.1:3001 | 384 MB | volume `grafana-data` |
| Loki | Docker Compose | 127.0.0.1:3100 | 384 MB | volume `loki-data` |
| Promtail | Docker Compose | — | 128 MB | — (reads host journals) |
| node_exporter | Docker Compose | 127.0.0.1:9100 | 64 MB | — |
| cAdvisor | Docker Compose | 127.0.0.1:8080 | 128 MB | — |
| postgres_exporter | Docker Compose | 127.0.0.1:9187 | 64 MB | — |
| blackbox-exporter | Docker Compose | 9115 (host network) | 64 MB | — |
| Nginx | apt (native) | 0.0.0.0:80/443 | ~50 MB | /etc/nginx, certs |

Rationale: **infra with state runs in Docker Compose** (clean upgrades, isolated volumes), **Ollama and Node run natively under systemd** (the Ollama install script manages its own service, and native Node avoids bind-mounting source into containers). Nginx is the only public listener. **Nothing else touches the internet.**

Memory budget on 12 GB: model resident ≈ 5–6 GB (Q4_K_M) + Postgres 1.5 GB + app 0.5 GB + observability ~1.5 GB + OS ~1 GB ≈ 10 GB → we add 4 GB swap as a pressure valve.

**Deferred to phase 2 — the vernacular ASR sidecar.** `services/n-atlas-asr` (Yoruba/Hausa/Igbo whisper-small) is **not** part of this bring-up: with `NATLAS_ASR_BASE_URL` left empty in §6, yo/ha/ig voice notes get the friendly "type your message instead" 503, while English and Pidgin ride the Groq Whisper chain normally. RAM stays free for the LLM. Run + systemd unit live at the end of §5 when you want it.

**N-ATLaS license obligations** (bind with the deployment): display attribution — *"N-ATLaS is an initiative of the Federal Ministry of Communications, Innovation and Digital Economy, powered by Awarri Technologies"* — and stay within the **1000 active end-users / 30 days** cap (school pilots are far below; track enrolment before scaling). Attribution belongs in the product footer and `GET /api/v1/ai/config`.

---

## 1. Secure server baseline

```bash
# --- from your laptop: make sure you have a key (skip if you already have one)
ls ~/.ssh/*.pub    # none? ssh-keygen -t ed25519

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

# Ubuntu cloud images can drop override files in sshd_config.d/ that silently
# beat sshd_config — verify the EFFECTIVE config before restarting sshd:
sshd -T | grep -Ei '^(port|permitrootlogin|passwordauthentication)'
# want: port 2222 / permitrootlogin no / passwordauthentication no
# if a .d/ file overrides them: fix or remove that file, re-run sshd -T

# Ubuntu 24.04 runs sshd socket-activated: ssh.socket owns the listening port
# and the Port directive above is IGNORED — sshd stays on 22 and sshd -T
# cannot catch that. Pin the socket to 2222 (the empty ListenStream= resets
# the stock value before ours is added; "active" from: systemctl is-active ssh.socket):
mkdir -p /etc/systemd/system/ssh.socket.d
printf '[Socket]\nListenStream=\nListenStream=2222\n' > /etc/systemd/system/ssh.socket.d/override.conf
systemctl daemon-reload
systemctl restart ssh.socket
systemctl restart ssh     # let sshd attach to the new socket

# PROVE the port is really bound — "Connection refused" from your laptop means
# nothing listens on 2222 yet, no matter what sshd -T printed:
ss -tlnp | grep -w 2222   # must list sshd
# not socket-activated (is-active says inactive) but still on 22? then the
# daemon just wasn't restarted: systemctl restart ssh
# no ssh.socket unit and restart fails? socket activation is off entirely;
# plain `systemctl restart ssh` is all you need.

# --- firewall: ssh on 2222 (rate-limited), web only
ufw default deny incoming && ufw default allow outgoing
ufw limit 2222/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# --- brute-force protection + automatic security patches
systemctl enable --now fail2ban
dpkg-reconfigure -plow unattended-upgrades    # answer Yes when prompted
```

**Keep this root session open** and prove the new door from a second terminal on your laptop: `ssh -p 2222 deploy@YOUR_VPS_IP`. **"Connection refused" means nothing is bound to 2222 — re-run the ssh.socket block above; don't close this session until the new door opens.** Root login and password auth are dead now — catching a typo while this session is still open costs nothing; a lockout costs a VNC-console session. All further commands run as `deploy`: `ssh -p 2222 deploy@YOUR_VPS_IP` (with `sudo` where needed).

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

Every compose service below sets `restart: unless-stopped` and memory limits so containers can never starve Ollama.

---

## 3. PostgreSQL (database + persistence)

Layout: infra lives in `/opt/infra`, one compose file, one shared network.

`/opt/infra/.env`:

```ini
POSTGRES_USER=natlas
POSTGRES_PASSWORD=<generate: openssl rand -hex 24>
POSTGRES_DB=natlas
MINIO_ROOT_USER=natlas-storage
MINIO_ROOT_PASSWORD=<generate>
GRAFANA_ADMIN_PASSWORD=<generate>
GF_SMTP_HOST=smtp.ethereal.email:587        # or your SMTP
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

  minio:
    image: minio/minio:RELEASE.2025-02-28T09-55-06Z   # check latest release tag
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      - "127.0.0.1:9000:9000"        # S3 API (proxied via s3.YOUR_VPS_IP.sslip.io)
      - "127.0.0.1:9001:9001"        # web console (proxied via s3.YOUR_VPS_IP.sslip.io/console)
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 30s
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
    # 127.0.0.1 (API :3000, Ollama :11434, MinIO :9000) — unreachable
    # from a bridge network, and the backend is not containerized
    network_mode: host
    deploy:
      resources:
        limits: { memory: 64M }

volumes:
  pgdata:
  minio-data:
  prom-data:
  grafana-data:
  loki-data:
```

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

## 4. MinIO — object storage & file uploads

```bash
# one-time bucket setup from the host (credentials come from the infra .env)
docker run --rm --env-file /opt/infra/.env --network natlas-infra_default minio/mc \
  sh -c "mc alias set local http://minio:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD && mc mb local/natlas-uploads && mc anonymous set none local/natlas-uploads"
```

(The bucket stays private — access only via presigned URLs or the backend's service credentials.)

**Upload pattern for the NestJS app** (files like student voice notes ≥ the current 10 MB multipart cap should go direct-to-MinIO):

- **Preferred:** backend issues a **presigned PUT URL** (`@aws-sdk/client-s3` → `getSignedUrl`), the client uploads straight to `https://s3.YOUR_VPS_IP.sslip.io/natlas-uploads/...` — large files never transit Node. Nginx sets `client_max_body_size 512m` on the `s3.` vhost.
- **Small files / server-validated writes:** keep the existing Fastify multipart route (10 MB cap in `main.ts`) and stream into S3 with `@aws-sdk/client-s3` `PutObject`.

App env additions (`.env`):

```ini
S3_ENDPOINT=https://s3.YOUR_VPS_IP.sslip.io
S3_REGION=us-east-1
S3_BUCKET=natlas-uploads
S3_ACCESS_KEY=<MINIO_ROOT_USER or a dedicated service account>
S3_SECRET_KEY=<MINIO_ROOT_PASSWORD or service key>
```

Never expose `MINIO_ROOT_*` to clients; create scoped service accounts in the MinIO console for the app if you prefer.

**Daily data backup** (mirrors object storage next to the DB dumps):

```bash
docker run --rm --env-file /opt/infra/.env --network natlas-infra_default -v /opt/backups:/backups minio/mc \
  sh -c "mc alias set local http://minio:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD && mc mirror --overwrite local/natlas-uploads /backups/minio"
```

---

## 5. N-ATLaS on the VPS (Ollama, CPU-quantized)

```bash
# --- ollama (native service, binds 127.0.0.1:11434 by default)
curl -fsSL https://ollama.com/install.sh | sh

# --- gated-model access: accept the licence terms on the HF model page for
#     the account that owns the token, then authenticate
sudo apt install -y python3-pip python3-venv
python3 -m venv /opt/hfenv && /opt/hfenv/bin/pip install -U huggingface_hub
/opt/hfenv/bin/huggingface-cli login        # paste the hf_... token (account has accepted NCAIR1 terms)

# --- download the CPU quant (Q4_K_M ≈ 5 GB; Q8_0 ≈ 8.5 GB if RAM allows)
sudo mkdir -p /opt/models/natlas && sudo chown deploy:deploy /opt/models/natlas
/opt/hfenv/bin/huggingface-cli download tosinamuda/N-ATLaS-GGUF \
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

Tuning notes for the 12 GB box:

- `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` (default service env) keep a single resident copy — the model stays loaded (~5–6 GB) thanks to Ollama's default `keep_alive`, so the async worker's jobs don't pay a load penalty per request.
- Expected throughput on 6 shared vCPUs: **~4–10 tokens/sec**. Real-time student chat always rides the OpenAI→Groq provider chain (`AI_PROVIDER_CHAIN` in §6 — local N-ATLaS is deliberately *not* a chat-chain member); this Ollama instance serves the **vernacular understanding lane**, reached via `NATLAS_LLM_BASE_URL` (the app posts to `/api/chat` on `http://127.0.0.1:11434` — no `/v1` suffix).
- Ollama must remain on `127.0.0.1` — never open 11434 in ufw.

**License:** display *"N-ATLaS … powered by Awarri Technologies"* in the product and expose it via `GET /api/v1/ai/config`; stay ≤ 1000 active users/30 days.

### Deferred to phase 2 — vernacular ASR sidecar

Per the §0 note, yo/ha/ig voice returns a graceful 503 until the sidecar is running. When you want it:

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

whisper-small runs ~1 GB RAM **per warm language** (×3 ≈ 3 GB), loads lazily on first request (~10–30 s cold) and unloads languages idle for `NATLAS_ASR_IDLE_UNLOAD_SECONDS` (600). The VPS is sized for 2–4 concurrent streams; overflow degrades to the same friendly 503. The sidecar has never been executed yet (the dev machine has no Python) — first boot on the VPS is its real smoke test; watch `journalctl -u natlas-asr`.

---

## 6. NestJS deployment (this repo)

```bash
# --- node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
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
ALLOWED_ORIGINS=https://app.example.com

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

# Bounded AI context (privacy/cost control)
AI_CONTEXT_MESSAGE_LIMIT=12
AI_CONTEXT_CHARACTER_LIMIT=12000

# Async AI generation (in-app DB queue)
AI_ASYNC_POLL_MS=5000
AI_ASYNC_HOLDING_MESSAGE=Thank you for sharing that with me — I am still thinking on it and will be right here.

# Guardrails — input/output caps + per-student rate windows
AI_MAX_MESSAGE_CHARS=1200
AI_MAX_REPLY_CHARS=700
AI_RATE_LIMIT_DAILY=20
AI_RATE_LIMIT_PER_MINUTE=6

# Session-summary memory (requires the pgvector image from §3)
AI_SESSION_IDLE_MINUTES=120
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Language layer
AI_LANGUAGE_OFFER_ENABLED=true
AI_VERNACULAR_REPLY_MODE=openai-native
# Local N-ATLaS (Ollama) — async vernacular understanding lane only
NATLAS_LLM_BASE_URL=http://127.0.0.1:11434
NATLAS_LLM_MODEL=n-atlas

# Vernacular ASR sidecar — phase 2 (§5). Empty = yo/ha/ig voice gets a friendly 503
NATLAS_ASR_BASE_URL=
NATLAS_ASR_TIMEOUT_MS=60000

# Staff enrolment secret; leave empty once staff accounts exist
STAFF_BOOTSTRAP_KEY=<openssl rand -hex 24>

# Object storage (MinIO from §4; empty S3_* = upload endpoints answer a friendly 503)
S3_ENDPOINT=https://s3.YOUR_VPS_IP.sslip.io
S3_REGION=us-east-1
S3_BUCKET=natlas-uploads
S3_ACCESS_KEY=<MINIO_ROOT_USER, or a dedicated MinIO service account>
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
journalctl -u natlas -f                          # live logs
```

**Release procedure** (repeatable, rollback-safe):

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

## 7. Nginx + TLS (the only public door)

```bash
sudo apt install -y nginx certbot
```

`/etc/nginx/sites-available/natlas`:

```nginx
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

# --- MinIO (S3 API + console) — client_max_body_size raised for direct PUTs
server {
  listen 80;
  server_name s3.YOUR_VPS_IP.sslip.io;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl http2;
  server_name s3.YOUR_VPS_IP.sslip.io;
  ssl_certificate     /etc/letsencrypt/live/s3.YOUR_VPS_IP.sslip.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/s3.YOUR_VPS_IP.sslip.io/privkey.pem;
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
  ssl_certificate     /etc/letsencrypt/live/monitor.YOUR_VPS_IP.sslip.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/monitor.YOUR_VPS_IP.sslip.io/privkey.pem;
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
  -d api.YOUR_VPS_IP.sslip.io -d s3.YOUR_VPS_IP.sslip.io -d monitor.YOUR_VPS_IP.sslip.io \
  --agree-tos -m you@example.com --non-interactive \
  --deploy-hook "systemctl reload nginx"

# 2) Now enable the vhosts (certs exist → nginx -t passes) and drop the stock site.
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
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: "host.docker.internal:9115" }
  - job_name: blackbox-s3
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets: ["https://s3.YOUR_VPS_IP.sslip.io/minio/health/live"]
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { target_label: __address__, replacement: "host.docker.internal:9115" }
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

(Enable via `postgres-exporter`'s `EXTEND_QUERY_PATH: /queries.yaml` env if your image version requires it.)

### Grafana provisioning

`/opt/infra/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - { name: Prometheus, type: prometheus, url: http://prometheus:9090, isDefault: true }
  - { name: Loki, type: loki, url: http://loki:3100 }
```

Import dashboards: **Node Exporter Full (ID 1860)**, **PostgreSQL Database (9628)**, **cAdvisor (14282)** — plus a small custom panel row fed by the `natlas_custom` metrics above (`ai_jobs_pending`, `support_flags_open`).

### Logs (Loki + Promtail)

`/opt/infra/promtail/promtail.yaml` — ships journald (NestJS + nginx + ollama) into Loki:

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

Grafana → Explore → Loki → `{unit="natlas.service"}` gives you the API logs; `{syslog_id="ollama"}` for model traffic.

### Alerting (Grafana → Alerting → Alert rules)

Minimum viable rules (evaluate every 1m, notify via the SMTP contact point):

| Alert | Condition |
|---|---|
| API down | `probe_success{job="blackbox-api"} == 0 for 2m` |
| MinIO (S3) down | `probe_success{job="blackbox-s3"} == 0 for 2m` |
| Ollama down | `probe_success{job="blackbox-ollama"} == 0 for 5m` |
| Disk filling | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes < 0.15` |
| Memory pressure | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` |
| AI queue stuck | `ai_jobs_pending > 10 for 15m` |
| Safeguarding backlog | `support_flags_open > 5 for 30m` |

That last pair turns the model pipeline and the safeguarding flow into operational first-class citizens.

---

## 9. Backups (persistence guarantee)

`/etc/cron.d/natlas-backups` (as root):

```cron
30 2 * * * deploy cd /opt/infra && docker compose exec -T postgres pg_dump -U natlas natlas | gzip > /opt/backups/natlas-$(date +\%F).sql.gz
40 2 * * * deploy docker run --rm --env-file /opt/infra/.env --network natlas-infra_default -v /opt/backups:/backups minio/mc sh -c "mc alias set local http://minio:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD && mc mirror --overwrite local/natlas-uploads /backups/minio"
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
systemctl status ollama natlas docker --no-pager
docker compose -f /opt/infra/docker-compose.yml ps

# endpoints (from the internet)
curl -s https://api.YOUR_VPS_IP.sslip.io/api/health/auth
curl -s https://s3.YOUR_VPS_IP.sslip.io/minio/health/live
# grafana login: https://monitor.YOUR_VPS_IP.sslip.io

# model
ollama list && ollama run natlas "Say hello in Hausa" --verbose

# full-system E2E (run against a STAGING database first — the journey
# cleans only its own synthetic users, but keep it out of the prod DB)
E2E_BASE_URL=https://api.YOUR_VPS_IP.sslip.io npm run test:e2e:journey
```

Final checks: Grafana shows all scrape targets UP · alert test notification arrives · `journalctl -u natlas` shows the AI worker start line ("AI async worker started") · attribution string present in the product footer · `STAFF_BOOTSTRAP_KEY` differs from dev.

---

## 11. Day-2 operations quick reference

| Task | Command |
|---|---|
| API logs | `journalctl -u natlas -f` |
| Ollama status / loaded models | `ollama ps` · `curl -s localhost:11434/api/tags` |
| Restart API | `sudo systemctl restart natlas` |
| Restart infra | `cd /opt/infra && docker compose restart` |
| Upgrade all containers | `docker compose pull && docker compose up -d` |
| Disk usage triage | `docker system df` · `df -h /` · journal size: `journalctl --disk-usage` |
| Update N-ATLaS model | re-run `huggingface-cli download` → `ollama create natlas -f Modelfile` (zero-downtime: the worker retries while Ollama reloads) |
| DB backup restore | see §3 restore drill |
| New release | §6 release procedure |
