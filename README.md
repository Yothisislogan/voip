# WiT Connect voice service

A browser calling and customer-workspace service built on Twilio Voice, Express,
and PostgreSQL, with signed WiTnext integration and an optional Dialpad bridge
for coexistence during migration.

This version replaces the demo agent screen with a working, authenticated phone
workspace and makes call records, finalized transcripts, recaps, messages, and
outbound integration work durable. It is a **pilot implementation**, not a claim
of complete Dialpad parity or certification for production telephony.

- [Dialpad replacement scope and acceptance gates](docs/dialpad-replacement.md)
- [Render deployment and existing-service activation](docs/render-deployment.md)
- [Voice deployment, verification, and recovery runbook](docs/voice-service-runbook.md)
- [WiTnext event and customer-identity contract](docs/witnext-integration-contract.md)

## What works in this repository

- `/phone.html`: browser registration, inbound answer/reject, outbound dialing,
  hangup, mute, touch tones, microphone/output selection where supported, token
  renewal, connection/quality feedback, and inbound blind transfer to an agent.
  `/agent.html` and `/softphone.html` lead to this workspace.
- Searchable, paginated call history, voicemail filtering, protected recording
  playback, saved notes and dispositions, transcript/recap details, customer
  links, and explicit confirmation of uncertain transfer-lead matches.
- Configurable business hours, holidays, simultaneous ringing, fixed priority,
  round robin, and longest idle routing. Configured routes use fresh agent
  presence and atomic reservations; unavailable/closed routes go to voicemail.
- Separate parent/child call state, monotonic lifecycle updates, duplicate
  transcript protection, restart-safe recap work, late-transcript regeneration,
  and delivery of call completion independently of AI success.
- SmartFinancial source-number separation: a transfer line is never treated as
  the customer's phone. Exact identifiers can match automatically; proximity to
  an email alone produces a suggestion requiring agent confirmation.
- A transactional WiTnext outbox with stable event IDs, fresh replay-protection
  signatures, integration identity headers, retry backoff, leases, and visible
  failed work. Recap action items use the receiver's expected field name.
- Persistent Twilio Conversations threads, assigned-agent replies, opt-out
  tracking, send-intent deduplication, and explicit unconfirmed send outcomes.
- Existing local CRM, rules/AI coaching and extraction, Google OAuth + Twilio
  Verify MFA, role controls, CSRF, webhook signatures, audit logging, backups,
  retention tooling, and optional ERPNext/survey integrations.

Live PSTN calls, number provisioning, carrier delivery, OAuth/MFA credentials,
recording playback, and the production WiTnext receiver still require testing in
your accounts. Hold/resume, warm transfer, conferences, full contact-center ACD,
supervisor controls, native mobile/desktop clients, E911, and number porting are
not implemented here. **Keep Dialpad until the documented cutover gates pass.**

## Local setup

Use Node 22 or a compatible supported Node release and PostgreSQL 16. The current
CI runs Node 20; `Dockerfile` uses Node 22.

```bash
npm ci
cp .env.example .env
# Set DATABASE_URL and the settings described below.
npm run migrate
npm start
```

Open `http://localhost:3000/phone.html` (or your configured `PORT`). For an
isolated development environment, use `AUTH_REQUIRED=false`; never expose that
configuration publicly. The page works with persisted call data without Twilio
credentials and clearly reports that calling needs provider setup. It contains
no seeded demo customers.

For real calls configure `PUBLIC_BASE_URL` to the exact public HTTPS origin,
Twilio account/API credentials, `TWILIO_AUTH_TOKEN`, a voice-enabled caller ID,
and a TwiML App. Complete the provider setup in the runbook. Production startup
requires PostgreSQL, HTTPS, secure authentication settings, an agent directory,
and authenticated email intake if that endpoint is enabled.

### Essential configuration

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Operational records, transcripts, messages, durable work |
| `PUBLIC_BASE_URL` | Exact public HTTPS origin used for signed webhook validation |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Account and webhook authentication |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Voice tokens and provider REST operations |
| `TWILIO_TWIML_APP_SID`, `TWILIO_CALLER_ID` | Browser outbound application and provisioned caller ID |
| `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Signed sessions and Google OAuth |
| `AGENT_DIRECTORY`, `TWILIO_VERIFY_SERVICE_SID` | Allowed identities, roles, and second factor |
| `VOICE_ROUTING_JSON` | Optional route strategy, hours, time zone, holidays, agents |
| `WITNEXT_URL`, `WITNEXT_INTEGRATION_ID`, `WITNEXT_INTEGRATION_SECRET` | Signed WiTnext integration; provision matching receiver identity |
| `LEAD_SIGNAL_TOKEN` | Dedicated bearer secret for normalized incoming lead signals |
| `SHARED_SOURCE_NUMBERS` | Vendor transfer lines excluded from customer matching |
| `DIALPAD_WEBHOOK_SECRET`, `DIALPAD_API_KEY` | Optional coexistence events and transcript retrieval |
| `EMAIL_INBOUND_TOKEN` | Authenticate JSON/urlencoded email intake |

See `.env.example` for model selection, recording, messaging, retention, and
routing settings. A configured provider adapter does not establish a BAA,
recording-consent policy, messaging registration, or a production readiness claim.

## Validation

```bash
npm run lint
npm test
npm run migrate
# Use a disposable database with migrations applied; these tests mutate it.
VOIP_TEST_DATABASE_URL=postgresql://.../voip_test node --test test/voice-service.integration.test.js
npm run restore-test
npm run simulate
npm run simulate:groq
npm run simulate:witnext
```

The simulations launch local HTTP mock providers; allow loopback networking.
Run them sequentially without another app worker attached to their database.
The opt-in DB tests cover actual concurrent transactions, call legs, duplicate
transcripts, restart recovery, late customer identity, agent reservations,
exclusive worker leases, and persistent opt-out state. They do not place calls
or send real SMS.

## Operations

- `/health` checks process liveness; `/ready` checks the database and job schema.
- The phone workspace shows admin-only operations metrics and failed-job retry.
- New `service_jobs` are drained automatically by the server. `npm run retry-jobs`
  handles the separate legacy `failed_jobs` queue.
- `npm run purge-retention` enforces configured windows. Default `0` preserves
  transcripts, recordings, messages, and audit data indefinitely. Completed job
  payloads clear after 30 days; idempotency keys remain. Contact/lead/email data,
  backups, failed/pending jobs, and downstream CRM copies require separate policy.
- Backup and restore procedures: [backups](docs/backups.md). Deployment references:
  [Hetzner](docs/deploy-hetzner.md), [checklist](docs/deploy-checklist.md).
  The voice-service runbook governs this release's additional requirements.

The PostgreSQL queue supports competing workers. Live browser events still use
an in-process event bus; do not assume multi-instance live delivery or a tested
high-availability service without adding a shared event transport.
# AssemblyAI live-call pilot

For real-time AssemblyAI transcription with the existing browser phone, see
[the deployment and real-call test guide](docs/assemblyai-pilot.md).
The opt-in provider uses Twilio Media Streams, separate speaker tracks, durable
final transcripts and visible interruption status. DigitalOcean/Hetzner pilot
Compose and authenticated Render deployment are supported paths. Live calling
still requires provider credentials, HTTPS, a pilot number and an agent login.
