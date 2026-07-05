# Go-Live Checklist — Cloudflare + Hetzner

End-to-end checklist to take WIT Connect live on a Hetzner VM behind Cloudflare.
Pairs with `docs/deploy-hetzner.md` (Docker) and `docs/backups.md`.

> ⚠️ Compliance: Hetzner does not sign a HIPAA BAA. If PHI is in scope, keep
> regulated workloads on BAA-covered infra — see `docs/secure-ai-architecture.md`.

## 1. DNS + Cloudflare

- [ ] Add the domain to Cloudflare; point the nameservers.
- [ ] `A` record `connect.yourdomain.com` → Hetzner VM public IP, **Proxied (orange cloud)**.
- [ ] SSL/TLS mode: **Full (strict)** (origin has a real cert via Caddy — below).
- [ ] Enable **Always Use HTTPS** and **HSTS**.
- [ ] WebSockets: **on** (Network tab) — required for `/ws/agent`.
- [ ] (Optional) WAF: rate-limit `/auth/*`; allow Twilio/SendGrid webhook IPs to `/voice/*`, `/messaging/inbound`, `/email/inbound`.
- [ ] Do **not** cache dynamic routes — leave default (Cloudflare doesn't cache non-GET; add a bypass rule for `/api/*`, `/ws/*` if you add caching).

## 2. Hetzner VM

- [ ] Ubuntu 22.04/24.04; create a non-root sudo user; SSH key auth only (disable password login).
- [ ] Firewall (hetzner cloud firewall **and** ufw): allow **22, 80, 443** only.
  - [ ] Do **not** expose Postgres (5432) or the app port (3000) publicly.
- [ ] Enable automatic security updates (`unattended-upgrades`).
- [ ] Install Docker + compose plugin.

## 3. App

- [ ] `git clone` the repo; `cp .env.example .env`.
- [ ] Set: `SESSION_SECRET` (`openssl rand -hex 32`), `POSTGRES_PASSWORD`, `PUBLIC_BASE_URL=https://connect.yourdomain.com`, `NODE_ENV=production`.
- [ ] Auth: `GOOGLE_CLIENT_ID/SECRET`, `AGENT_DIRECTORY` (real agents), `TWILIO_VERIFY_SERVICE_SID`. Leave `AUTH_REQUIRED=true`, `DEV_LOGIN_ENABLED=false`.
- [ ] Set each agent's `role` in `AGENT_DIRECTORY` (`viewer`/`agent`/`admin`; default `agent`). Viewers are read-only — they can browse the CRM but cannot edit contacts or send messages.
- [ ] Twilio: account SID, API key/secret, TwiML app SID, caller ID, `TWILIO_AUTH_TOKEN`.
- [ ] Pick `LLM_BACKEND` (default `rules`; coaching stays local).
- [ ] `docker compose up -d --build` → check `docker compose logs -f app` for **"Schema applied"** and **no ❌ fatal config** lines (production validation fails fast).
- [ ] `curl -s http://localhost:3000/health` → `{"ok":true}`.

## 4. TLS origin (Caddy)

- [ ] Install Caddy on the VM; `Caddyfile`:
      ```
      connect.yourdomain.com {
          reverse_proxy localhost:3000
      }
      ```
- [ ] Caddy auto-provisions a cert (works with Cloudflare **Full (strict)**).

## 5. Wire providers to the public URL

- [ ] Google OAuth redirect URI: `https://connect.yourdomain.com/auth/google/callback`.
- [ ] Twilio number → Voice `…/voice/inbound`, Messaging `…/messaging/inbound`.
- [ ] Twilio TwiML App → Voice `…/voice/outbound`.
- [ ] Recording status `…/recording/status`.
- [ ] SendGrid/Mailgun inbound parse → `…/email/inbound` (+ `EMAIL_INBOUND_TOKEN`).
- [ ] (When live) Apple Messages MSP → same messaging inbound.

## 6. Data + backups

- [ ] Confirm migrations applied: `docker compose exec db psql -U wit -d wit -c '\dt'`.
- [ ] Add the cron backup (see `docs/backups.md`) and **sync backups off-box**.
- [ ] Verify the backup round trip: `DATABASE_URL=… npm run restore-test` (dumps, restores into a scratch DB, checks row counts, drops it).

## 7. Smoke test (production)

Before touching the live number, dry-run the whole webhook→CRM pipeline against
a staging DB with the built-in simulator (no Twilio account needed — it signs
its own webhooks): `DATABASE_URL=… npm run simulate`. It drives inbound voice,
transcription, recap/score/extraction, inbound SMS, and email intake, then
verifies the rows landed via the CRM API.


- [ ] Sign in with a real agent via Google + 2FA.
- [ ] Place an outbound call; confirm screen-pop + a `contacts`/`calls` row.
- [ ] Speak both sides; confirm coaching cues; hang up → recap, score, extracted fields, and (if enabled) survey SMS.
- [ ] Open `/contacts.html`, edit a field, save; open a call in `/call.html`.
- [ ] Send a test inbound SMS and inbound email; confirm they create/append leads.

## 8. Ongoing

- [ ] Monitor `docker compose logs` / add log shipping.
- [ ] Rotate secrets on staff changes; keep `AGENT_DIRECTORY` current.
- [ ] Re-run `docker compose up -d --build` to deploy updates (migrations auto-apply).
