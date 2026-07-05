# Operations & hardening

Production-hardening surfaces added on top of the core app. All are
dependency-free (hand-rolled) and feature-flagged.

## Health & readiness

| Endpoint | Purpose | Behavior |
| --- | --- | --- |
| `GET /health` | liveness | always `200 {"ok":true}` (never touches the DB) |
| `GET /ready` | readiness | `SELECT 1` against Postgres; `503` when the DB is down |

Point your load balancer / orchestrator liveness probe at `/health` and the
readiness/drain probe at `/ready`. Both are excluded from access-log noise
unless they error.

## Structured logging

`src/logger.js` emits one JSON line per event in production (ship to
Loki/CloudWatch/Datadog) and a compact human line in dev. Levels via
`LOG_LEVEL` (`debug|info|warn|error`); `LOG_PRETTY=true` forces the readable
format. Every request gets an `X-Request-Id` (honoring an inbound one) that
threads through logs and audit rows via `req.log` / `reqId`.

## Security headers & rate limits

`securityHeaders` sets CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, COOP/CORP, `Permissions-Policy`, and HSTS (https only).
Override the CSP with `CONTENT_SECURITY_POLICY` if you extract inline scripts.

Rate limiting (`src/middleware/rateLimit.js`) is a per-IP fixed window, isolated
per surface:

| Bucket | Default / min | Applies to |
| --- | --- | --- |
| `auth` | `RATE_LIMIT_AUTH_MAX` (20) | `/auth/*`, `/2fa`, `/logout` |
| `api` | `RATE_LIMIT_API_MAX` (300) | token, AI, CRM, messaging |
| `webhook` | `RATE_LIMIT_WEBHOOK_MAX` (600) | Twilio + email inbound |

Counters are per-process — fine for the single-instance deploy. Behind
Cloudflare/Caddy set `RATE_LIMIT_TRUST_PROXY=true` (default) so the real client
IP is read from `X-Forwarded-For`. Move to a shared store (Redis) if you scale
horizontally.

## CSRF

Cookie-authenticated browser state changes (CRM `PATCH`, `/messaging/send`) use
the double-submit-cookie pattern: a non-httpOnly `wit_csrf` cookie must match an
`X-CSRF-Token` header. The agent UIs send it automatically. Twilio-signed
webhooks and the token-authed email intake are exempt (no session cookie to
forge). Enabled whenever auth is required; toggle with `CSRF_ENABLED`.

## Audit log

`audit_log` records security- and PII-relevant actions (`auth.login`,
`contact.view`, `contact.update`, `message.send`, `call.view`) with actor, role,
IP, request id, and redacted detail. Written best-effort via `src/audit.js`;
also emitted to the structured log. Read it (admin only):

```
GET /api/crm/audit?limit=100&actor=&action=&entityId=
```

## Consent & recording state

Inbound calls play a recording/transcription disclosure; that and the recording
lifecycle are tracked on each call (`recording_state`, `consent_state`,
`consent_at`) with a full history in `consent_events`. The call-detail API
(`GET /api/crm/calls/:sid`) returns a `consent` block for compliance review.
States: recording = `none|recording|stopped|deleted`; consent =
`unknown|disclosed|granted|declined`.

## Dead-letter queue

Fire-and-forget AI/webhook work (`onUtterance`, `onCallComplete`, `screenPop`,
`handleInbound`) is wrapped in `runTracked(...)`. On failure the job lands in
`failed_jobs` with its payload instead of being lost. Drain with backoff:

```bash
npm run retry-jobs          # cron this every few minutes
```

Stateless jobs (`handleInbound`) replay cleanly. Session-bound jobs
(`onUtterance`/`onCallComplete`/`screenPop`) depend on in-memory call state that
only exists in the live server process, so they can't be replayed from a
separate process — they remain in the queue for inspection rather than
disappearing silently.

## Data retention

`npm run purge-retention` deletes PII past the configured windows (0 = keep
forever):

| Env | Deletes |
| --- | --- |
| `RETENTION_TRANSCRIPT_DAYS` | `transcript_segments` past N days |
| `RETENTION_RECORDING_DAYS` | clears `recording_url` (+ marks `recording_state=deleted`) |
| `RETENTION_AUDIT_DAYS` | `audit_log` past N days (keep long for compliance) |

Set `RETENTION_DELETE_TWILIO_RECORDINGS=true` to also delete the audio at Twilio
(requires REST credentials). Schedule it daily:

```cron
30 3 * * * cd /opt/wit-connect && npm run purge-retention >> /var/log/wit-purge.log 2>&1
```

## CI

`.github/workflows/ci.yml` runs unit tests on every push/PR, plus an integration
job with a Postgres service that runs `migrate`, `restore-test`, and `simulate`
end-to-end.
