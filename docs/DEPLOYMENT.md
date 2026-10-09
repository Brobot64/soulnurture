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
| N-ATLaS LLM | Ollama (native, systemd) | 127.0.0.1:11434 | ~6 GB (model resident) | `/opt/ollama/models` |
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

Rationale: **infra with state runs in Docker Compose** (clean upgrades, isolated volumes), **Ollama and Node run natively under systemd** (the Ollama install script manages its own service, and native Node avoids bind-mounting source into containers). Nginx is the only public listener. **Nothing else touches the internet.**

Memory budget on 12 GB: model resident ≈ 5–6 GB (Q4_K_M) + Postgres 1.5 GB + app 0.5 GB + observability ~1.5 GB + OS ~1 GB ≈ 10 GB → we add 4 GB swap as a pressure valve.

**Deferred to phase 2 — the vernacular ASR sidecar.** `services/n-atlas-asr` (Yoruba/Hausa/Igbo whisper-small) is **not** part of this bring-up: with `NATLAS_ASR_BASE_URL` left empty in §6, yo/ha/ig voice notes get the friendly "type your message instead" 503, while English and Pidgin ride the Groq Whisper chain normally. RAM stays free for the LLM. Run + systemd unit live at the end of §5 when you want it.

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

Every compose service below sets `restart: unless-stopped` and memory limits so containers can never starve Ollama.

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

## 5. N-ATLaS on the VPS (Ollama, CPU-quantized)

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

# Guided check-in replies — free-text turn budget before wrap-up
# (3 base; a single "Tell more" tap extends to 5; quick-reply taps are free)
AI_GUIDED_MAX_BASE_TURNS=3
AI_GUIDED_MAX_EXTENDED_TURNS=5

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

# --- RustFS (S3 API + console) — client_max_body_size raised for direct PUTs
# (one SAN cert covers all three hostnames → every block loads the api. lineage)
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
      - targets: ["https://s3.YOUR_VPS_IP.sslip.io/health"]
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

Loaded by the `command:` flags on the compose service (§3) — v0.15.x **ignores** the old `EXTEND_QUERY_PATH` env var. Exported names carry the collector prefix: `natlas_custom_ai_jobs_pending`, `natlas_custom_ai_jobs_failed`, `natlas_custom_support_flags_open`, `natlas_custom_support_requests_escalated` — use the prefixed names in dashboards and alerts.

### Grafana provisioning

`/opt/infra/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - { name: Prometheus, type: prometheus, url: http://prometheus:9090, isDefault: true }
  - { name: Loki, type: loki, url: http://loki:3100 }
```

Import dashboards: **Node Exporter Full (ID 1860)**, **PostgreSQL Database (9628)**, **cAdvisor (14282)** — plus a small custom panel row fed by the `natlas_custom` metrics above (e.g. `natlas_custom_ai_jobs_pending`, `natlas_custom_support_flags_open`). The full operator's guide — dashboards, the seven alert rules with exact setup steps, log queries, incident triage — is **`docs/MONITORING.md`**.

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

**Heads-up:** with the runbook default, `GF_SMTP_HOST` is `smtp.ethereal.email` — a throwaway test inbox; email alerts **never reach a real address** until real `GF_SMTP_*` values go into `/opt/infra/.env` and grafana is recreated (`cd /opt/infra && sudo docker compose up -d grafana`). Contact-point setup and the full warning live in `docs/MONITORING.md`.

Minimum viable rules (evaluate every 1m, notify via the SMTP contact point):

| Alert | Condition |
|---|---|
| API down | `probe_success{job="blackbox-api"} == 0 for 2m` |
| RustFS (S3) down | `probe_success{job="blackbox-s3"} == 0 for 2m` |
| Ollama down | `probe_success{job="blackbox-ollama"} == 0 for 5m` |
| Disk filling | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes < 0.15` |
| Memory pressure | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` |
| AI queue stuck | `natlas_custom_ai_jobs_pending > 10 for 15m` |
| Safeguarding backlog | `natlas_custom_support_flags_open > 5 for 30m` |

That last pair turns the model pipeline and the safeguarding flow into operational first-class citizens.

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
systemctl status ollama natlas docker --no-pager
docker compose -f /opt/infra/docker-compose.yml ps

# endpoints (from the internet)
curl -s https://api.YOUR_VPS_IP.sslip.io/api/health/auth
curl -s https://s3.YOUR_VPS_IP.sslip.io/health
# grafana login: https://monitor.YOUR_VPS_IP.sslip.io

# model
ollama list && ollama run natlas "Say hello in Hausa" --verbose

# full-system E2E (run against a STAGING database first — the journeys
# clean only their own synthetic users, but keep them out of the prod DB)
E2E_BASE_URL=https://api.YOUR_VPS_IP.sslip.io npm run test:e2e:journey
E2E_BASE_URL=https://api.YOUR_VPS_IP.sslip.io npm run test:e2e:school-chat

# WebSocket upgrade through nginx (expect "HTTP/1.1 101 Switching Protocols")
curl -si -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://api.YOUR_VPS_IP.sslip.io/api/socket.io/?EIO=4&transport=websocket" | head -3
```

Final checks: Grafana shows all scrape targets UP · alert test notification arrives · `journalctl -u natlas` shows the AI worker start line ("AI async worker started") · attribution string present in the product footer · `STAFF_BOOTSTRAP_KEY` differs from dev.

---

## 11. Day-2 operations quick reference

| Task | Command |
|---|---|
| API logs | `sudo journalctl -u natlas -f` |
| Ollama status / loaded models | `ollama ps` · `curl -s localhost:11434/api/tags` |
| Restart API | `sudo systemctl restart natlas` |
| Restart infra | `cd /opt/infra && docker compose restart` |
| Upgrade all containers | `docker compose pull && docker compose up -d` |
| Disk usage triage | `docker system df` · `df -h /` · journal size: `journalctl --disk-usage` |
| Update N-ATLaS model | re-run `hf download` → `ollama create natlas -f Modelfile` (zero-downtime: the worker retries while Ollama reloads) |
| DB backup restore | see §3 restore drill |
| New release | merge to `main` — CI/CD deploys automatically (§12); manual: §6 |

---

## 12. CI/CD — deploy on merge to `main`

`.github/workflows/deploy.yml` (in the repo) drives the lane:

```
push/PR   → CI job: npm ci → oxlint → vitest → build
main push → deploy job: SSH :2222 (forced command) → /usr/local/bin/natlas-deploy
```

The deploy job checks out nothing and holds no server password — the GitHub secret can do exactly one thing: trigger the deploy script.

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
