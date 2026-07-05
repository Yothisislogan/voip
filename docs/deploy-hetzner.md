# Deploy WIT Connect on Hetzner (Docker)

Runs the Node app + Postgres via `docker compose`. The schema is applied
automatically on startup (`npm run migrate`, idempotent).

> ⚠️ **Compliance note.** Hetzner does not sign a HIPAA BAA. If PHI is in scope,
> keep regulated workloads on BAA-covered infrastructure — see
> `docs/secure-ai-architecture.md`. This guide is for the operational deploy.

## 1. Provision the server

- A Hetzner Cloud VM (Ubuntu 22.04/24.04). Open ports 80/443 (and 22).
- Install Docker + Compose plugin:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # re-login after this
```

## 2. Get the code + configure

```bash
git clone https://github.com/Yothisislogan/voip.git wit-connect
cd wit-connect
cp .env.example .env
# Edit .env: set a strong POSTGRES_PASSWORD, SESSION_SECRET, Twilio keys,
# PUBLIC_BASE_URL=https://connect.yourdomain.com, AGENT_DIRECTORY, LLM_BACKEND, etc.
# DATABASE_URL is injected by compose — leave it or it will be overridden.
nano .env
```

Minimum to boot: `SESSION_SECRET`, `POSTGRES_PASSWORD`, and either real auth
(Google + `AGENT_DIRECTORY`) or `AUTH_REQUIRED=false` for a first smoke test.

## 3. Run

```bash
docker compose up -d --build
docker compose logs -f app        # watch startup + "Schema applied"
curl -s http://localhost:3000/health
```

The `app` service waits for Postgres to be healthy, runs the migration, then
starts. Data persists in the `pgdata` volume across restarts.

## 4. TLS + public URL (reverse proxy)

Twilio webhooks and secure cookies need HTTPS. Put a reverse proxy in front —
Caddy is the simplest (auto-HTTPS). Example `Caddyfile`:

```
connect.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Then set `PUBLIC_BASE_URL=https://connect.yourdomain.com` in `.env`, and point
your Twilio number/webhooks at:

| Purpose | URL |
| --- | --- |
| Inbound voice | `{PUBLIC_BASE_URL}/voice/inbound` |
| Outbound (TwiML App) | `{PUBLIC_BASE_URL}/voice/outbound` |
| Recording status | `{PUBLIC_BASE_URL}/recording/status` |
| Real-time transcription | (auto — started in TwiML) |
| Messaging inbound (Conversations) | `{PUBLIC_BASE_URL}/messaging/inbound` |
| Email intake (SendGrid/Mailgun) | `{PUBLIC_BASE_URL}/email/inbound` |

## 5. Operations

```bash
docker compose ps                       # status
docker compose logs -f app              # app logs
docker compose exec app npm run migrate # re-apply schema (safe, idempotent)
docker compose exec db psql -U wit -d wit -c '\dt'   # inspect tables
docker compose pull && docker compose up -d --build  # update
docker compose exec db pg_dump -U wit wit > backup.sql   # backup
```

## Data model

The Postgres CRM (`db/schema.sql`) is the app's operational store:

| Table | Purpose |
| --- | --- |
| `contacts` | leads/contacts (+ AI-extracted insurance fields) |
| `calls` | one row per call, linked to a contact |
| `transcript_segments` | persistent per-utterance transcript |
| `call_scores` | 0–100 lead/quality score + factors per call |
| `surveys` | post-call CSAT/NPS SMS + response |
| `email_intake` | parsed inbound emails → leads |
