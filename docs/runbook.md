# Operator runbook

Day-to-day operations and incident response for WIT Connect. Pairs with
`docs/operations.md` (what each subsystem is) and `docs/deploy-checklist.md`
(first go-live). The **Admin Console** (`/admin.html`, admin role) shows live
system status, the failed-job queue, and the audit log — start there.

Commands below assume the Docker/compose deploy (`docs/deploy-hetzner.md`);
prefix with `docker compose exec app` when running inside the container.

## Quick reference

| Task | Command |
| --- | --- |
| Health / readiness | `curl -s localhost:3000/health` · `curl -s localhost:3000/ready` |
| App logs | `docker compose logs -f app` |
| Apply migrations | `npm run migrate` (idempotent) |
| Backup now | `./scripts/backup.sh /var/backups/wit` |
| Verify a restore | `npm run restore-test` |
| Drain failed jobs | `npm run retry-jobs` |
| Enforce retention | `npm run purge-retention` |
| Dry-run the pipeline | `DATABASE_URL=… npm run simulate` |

## Routine checks

- **Daily:** glance at the Admin Console. Green across status cards; job queue
  `pending`/`exhausted` at 0; backups "X ago" within the last day.
- **Weekly:** run `npm run restore-test` (an untested backup is not a backup).
- **On deploy:** watch `docker compose logs -f app` for `applied` migrations and
  **no `❌` fatal config** lines. Confirm `/ready` returns `db: "up"`.

## Incident: calls connect but no CRM/coaching data

1. `/ready` — is the DB up? If `503`, the pipeline can't persist. Check Postgres.
2. Admin Console → **Job queue**. A rising `pending`/`exhausted` count means the
   AI/webhook jobs are throwing. Read the error column in **Failed jobs**.
3. App logs: filter for `job.failed`, `onCallComplete`, `recap`.
4. After fixing the cause, `npm run retry-jobs` to replay stateless jobs
   (`handleInbound`). Session-bound jobs can't be replayed from a separate
   process (they need live call state) — resolve them once understood.

## Incident: Twilio webhooks return 403

Signature validation rejects requests whose URL doesn't match. Confirm
`PUBLIC_BASE_URL` exactly matches the URL configured on the Twilio number
(scheme + host, no trailing slash) and that `TWILIO_AUTH_TOKEN` is set. Behind a
proxy, ensure the proxy forwards the original host and `X-Forwarded-Proto`.

## Incident: users get 429 (rate limited)

Legitimate burst or an attack. Check the client IP in the access logs. Tune
`RATE_LIMIT_*` (see `docs/operations.md`) if a real workload trips the limit;
the auth bucket is intentionally strict (credential-stuffing / OTP defense).

## Incident: login broken

- `❌ fatal config` at boot → missing `SESSION_SECRET`, Google creds, or
  `AGENT_DIRECTORY`. Fix env, redeploy.
- OTP not arriving → check `TWILIO_VERIFY_SERVICE_SID` and the agent's
  `mfaChannel`/`phone` in `AGENT_DIRECTORY`.
- Never set `AUTH_REQUIRED=false` or `DEV_LOGIN_ENABLED=true` in production
  (both are fatal there by design).

## Restore from backup

```bash
gunzip -c backups/wit_YYYYmmdd_HHMMSS.sql.gz | psql "$DATABASE_URL"
npm run migrate        # apply anything newer than the dump (idempotent)
```

See `docs/backups.md` for the full procedure and off-box sync.

## Rotating an agent / roles

Edit `AGENT_DIRECTORY` (add/remove the email, set `role` to
`viewer`/`agent`/`admin`) and redeploy. Removing an email blocks future logins;
existing sessions expire within `SESSION_TTL_SEC`. Actions are attributable in
the audit log.

## Data subject / deletion request

1. Find the contact in **Leads & Contacts**; note the id.
2. Delete/clear as required directly in Postgres (contacts, calls,
   transcript_segments, call_scores cascade via FKs).
3. If recordings must go too, set `RETENTION_DELETE_TWILIO_RECORDINGS=true` and
   run `npm run purge-retention`, or delete the specific recording at Twilio.
4. The deletion itself is visible in `consent_events` / audit trail.
