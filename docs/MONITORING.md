# Natlas Monitoring & Operations Guide

Day-to-day operator's companion to `docs/DEPLOYMENT.md` (the bring-up runbook). Throughout, `YOUR_VPS_IP` = `169.58.86.169`.

- What is watched, where to look, what each alert means, and what to do when one fires
- URL: **https://monitor.169.58.86.169.sslip.io**

## 1. The stack at a glance

```
                     ┌──────────────── Grafana — dashboards + alerting
                     │      https://monitor.169.58.86.169.sslip.io
        ┌────────────┴─────────┐
        │  Prometheus (15s pull)│          Loki (log storage)
        └──┬─────┬─────┬─────┬─┘              ▲ push
           │     │     │     │                │
        node-  cad-  pg-   blackbox        promtail
        export visor export exporter       (journald → Loki:
         9100  8080  9187   9115            natlas, nginx, ollama)
         host metrics | PG stats | HTTP probes: api/s3/ollama
```

| Piece | Answers |
|---|---|
| node-exporter | CPU / memory / disk / load of the VPS itself |
| cadvisor | Per-container CPU / memory (which container is eating RAM) |
| postgres-exporter | DB health + **Natlas business gauges** (`natlas_custom_*`) |
| blackbox-exporter | Are the public doors actually answering: API, RustFS, Ollama |
| promtail → Loki | Every journald line (API, nginx, Ollama) searchable in Grafana |
| Grafana | Dashboards, alert rules, email contact point |

Everything runs as containers from `/opt/infra/docker-compose.yml`; the Natlas API itself is a native systemd service (`natlas`).

## 2. Access

- **Grafana**: https://monitor.169.58.86.169.sslip.io — user `admin`, password `GRAFANA_ADMIN_PASSWORD` from `/opt/infra/.env` on the VPS (`sudo grep GRAFANA_ADMIN_PASSWORD /opt/infra/.env`). Change it on first login (Grafana will prompt); the env var only sets the initial password.
- **Prometheus and Loki have no public URL** (by design). Query them through Grafana → Explore, or over SSH: `ssh -p 2222 deploy@169.58.86.169` then `curl -s localhost:9090/api/v1/query?query=up | head`.

## 3. The 60-second health check

Grafana → Explore → Prometheus, run `up`. Expect **7 series, all `1`**:

| job | What it is |
|---|---|
| node, cadvisor, postgres | the three exporters |
| blackbox-api | ×2 — `https://api…/api/health/auth` (through nginx) **and** `http://127.0.0.1:3000/…` (native) |
| blackbox-s3 | `https://s3…/health` (RustFS) |
| blackbox-ollama | `http://127.0.0.1:11434/api/tags` |

A `0` on the public target but `1` on the native one = nginx/TLS problem, not an app problem.

Then run `natlas_custom_ai_jobs_pending` — expect `0`. Non-zero and growing = the AI worker is stuck (see §10).

## 4. Dashboards

Import (Dashboards → New → Import, paste the ID, datasource = Prometheus):

| ID | Dashboard | Why |
|---|---|---|
| **1860** | Node Exporter Full | VPS disk / memory / CPU / network — your disk-filling early warning |
| **9628** | PostgreSQL Database | connections, cache hit ratio, transactions, locks |
| **14282** | cAdvisor | per-container resource usage |

**Custom "Natlas Operations" row** — add a dashboard with four Stat panels, one per business gauge (query editor, instant query):

- `natlas_custom_ai_jobs_pending` — AI jobs waiting in the DB queue
- `natlas_custom_ai_jobs_failed` — failed generations (should stay 0; non-zero = check provider keys/quotas)
- `natlas_custom_support_flags_open` — safeguarding flags not yet closed
- `natlas_custom_support_requests_escalated` — escalations awaiting staff action

> The metric names carry the `natlas_custom_` prefix (the collector name from `/opt/infra/postgres-exporter/queries.yaml`). Plain `ai_jobs_pending` does not exist — use the prefixed names in every panel and alert.

Optional extra panel — API error rate over the last hour: Loki query `count_over_time({unit="natlas.service"} |= "error" [1h])`.

## 5. Alerting (Grafana-managed rules + email)

SMTP is already wired into the Grafana container (`GF_SMTP_*` in `/opt/infra/.env`), so Grafana can send mail — you just need to create the contact point and the rules.

**One-time setup:**

1. **Contact point**: Alerting → Contact points → Add → type **Email**, your address(es), name it e.g. `natlas-ops`. Use **Test** to confirm mail arrives (if not: check `GF_SMTP_*` values in `/opt/infra/.env` and `docker compose restart grafana`).
2. **Notification policy**: Alerting → Notification policies → edit the default policy → contact point `natlas-ops`.

**Rules** — Alerting → Alert rules → New alert rule, datasource **Prometheus**, evaluation every **1m**. Condition column gives the exact Grafana setting:

| Alert | Query A (PromQL) | Condition | For |
|---|---|---|---|
| API down | `probe_success{job="blackbox-api"}` | is below 1 | 2m |
| RustFS (S3) down | `probe_success{job="blackbox-s3"}` | is below 1 | 2m |
| Ollama down | `probe_success{job="blackbox-ollama"}` | is below 1 | 5m |
| Disk filling | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}` | is below 0.15 | — |
| Memory pressure | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes` | is below 0.10 | — |
| AI queue stuck | `natlas_custom_ai_jobs_pending` | is above 10 | 15m |
| Safeguarding backlog | `natlas_custom_support_flags_open` | is above 5 | 30m |

Notes:

- "API down" fires per target (public and native are separate series, distinguished by the `instance` label) — if only the public one is down, suspect nginx/certs, not the app.
- The last two rules make the AI pipeline and the safeguarding flow operational first-class citizens: a stuck model queue or an unreviewed pile of flags pages you, not a student.
- Test the pipeline end-to-end once: stop a service (`sudo systemctl stop natlas`) until "API down" fires and the email lands, then start it again.

## 6. Logs (Loki)

Grafana → Explore → **Loki**:

| Query | Shows |
|---|---|
| `{unit="natlas.service"}` | Natlas API (NestJS) logs |
| `{unit="natlas.service"} \|= "error"` | API errors only |
| `{syslog_id="ollama"}` | Ollama model traffic |
| `{unit="nginx.service"}` \|= " 500 " | nginx 5xx responses |

Log-based metrics work too, e.g. error trend: `sum(count_over_time({unit="natlas.service"} |= "error" [5m]))`.

## 7. Backups & restore

What exists (`/etc/cron.d/natlas-backups`, nightly ~02:30):

- `pg_dump` of the Postgres DB → `/opt/backups/natlas-YYYY-MM-DD.sql.gz` (14-day retention)
- RustFS uploads bucket synced to `/opt/backups/rustfs/`

Verify weekly (or add a "no backup in 25h" alert later):

```bash
ssh -p 2222 deploy@169.58.86.169 'ls -lah /opt/backups/ | tail -5'
```

A restore drill (into a scratch DB, not over prod) is documented in DEPLOYMENT.md §3 — run it once before you trust the backups. Same-machine backups die with the machine: the planned upgrade is `rclone` of `/opt/backups` to off-site storage (B2/Wasabi/second VPS). Also keep `/opt/infra/.env` and `/opt/natlas/.env` copies in a password manager.

## 8. Deploys & rollback (CI/CD)

Flow on merge/push to `main` (full detail in DEPLOYMENT.md §12):

```
GitHub Actions CI (npm ci → oxlint → vitest → build)
        └─ deploy job: SSH (forced command) → /usr/local/bin/natlas-deploy
              git reset --hard origin/main → npm ci → build → migrate deploy
              → seed → systemctl restart natlas → 40s health gate
              → on failure: automatic rollback to previous release
```

- Watch a deploy: https://github.com/Brobot64/soulnurture/actions — the deploy log streams `natlas-deploy` output; the last line `DEPLOY OK: <old> -> <new>` is the success marker.
- **Manual deploy**: `ssh -p 2222 deploy@169.58.86.169` then `/usr/local/bin/natlas-deploy` (same script, same guarantees).
- **Manual rollback** (if auto-rollback itself failed): on the VPS, `cd /opt/natlas && git reset --hard <sha> && npm ci && npm run build && sudo systemctl restart natlas`. Migrations are additive-only and stay applied — old code tolerates the newer schema.
- Prefer rolling forward: revert the bad commit on `main`, push — CI redeploys it.

## 9. Where things live (day-2 quick reference)

| Thing | Path / command |
|---|---|
| Infra compose + .env | `/opt/infra/docker-compose.yml`, `/opt/infra/.env` |
| Prometheus config | `/opt/infra/prometheus/prometheus.yml` (restart: `cd /opt/infra && docker compose restart prometheus`) |
| Custom PG queries | `/opt/infra/postgres-exporter/queries.yaml` |
| Promtail config | `/opt/infra/promtail/promtail.yaml` |
| Backups | `/opt/backups/` + `/etc/cron.d/natlas-backups` |
| App + app .env | `/opt/natlas`, `/opt/natlas/.env` |
| Deploy script | `/usr/local/bin/natlas-deploy` |
| API logs | `sudo journalctl -u natlas -f` |
| Restart API / infra | `sudo systemctl restart natlas` / `cd /opt/infra && docker compose restart` |
| Disk triage | `docker system df` · `df -h /` · `journalctl --disk-usage` |
| TLS cert expiry | `sudo certbot renew --dry-run` (renewal timer: `systemctl list-timers certbot`) |
| Ollama | `ollama ps` · `curl -s localhost:11434/api/tags` |

## 10. Incident triage recipes

**"API down" alert**
1. Grafana → Explore → `up` — which target is 0? Public only → nginx/TLS; both → app.
2. App: `sudo systemctl status natlas` then `sudo journalctl -u natlas -n 100`.
3. Recent deploy? Check the Actions run / `DEPLOY OK` line; if the health gate failed, rollback already happened — find the error in the deploy log.
4. nginx: `sudo nginx -t`, `sudo journalctl -u nginx -n 50`.

**"AI queue stuck"** (`natlas_custom_ai_jobs_pending` > 10 for 15m)
1. The async worker runs inside the API — `sudo journalctl -u natlas | grep -i "ai async\|worker"` for the start line and errors.
2. Vernacular lane: is Ollama up (`ollama ps`, blackbox-ollama target)? Groq/OpenAI: check provider status + API keys in `/opt/natlas/.env` (`GROQ_API_KEY`, `OPENAI_API_KEY`).
3. Peek at the queue: `cd /opt/infra && docker compose exec -T postgres psql -U natlas -d natlas -c "select status, count(*) from ai_generation_job group by status;"`

**"Safeguarding backlog"** — not an infra failure: staff aren't closing flags. Chase the counsellor lead; check the staff dashboard for the flag list.

**Disk filling** — `docker system df` (images/logs are the usual suspects), `sudo journalctl --vacuum-size=200M` if journald grew; do **not** blind-run `docker system prune -a` (it can remove the pinned images other services need — check what it would delete first).

**Memory pressure** — `free -h` + cAdvisor dashboard to find the container; Ollama is the usual resident (multi-GB by design — that's fine, it's why the box has 12 GB).

**Cert expiry** (browsers warning): `sudo certbot renew --dry-run`; certbot's systemd timer auto-renews, nginx reloads on renewal.
