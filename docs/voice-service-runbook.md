# Voice service deployment and recovery

## Release boundary

Deploy this branch to a staging host and a newly provisioned test number first.
Do not switch existing customer numbers or cancel Dialpad based on local tests.
The changes add migrations 0007–0009 and do not rewrite historical customer
identity. Existing calls without ownership remain admin-visible until a reviewed
backfill assigns them; do not infer ownership from an arbitrary default agent.

## 1. Prepare the environment

1. Back up the target PostgreSQL database and prove a restore in a separate
   database. The existing `npm run restore-test` requires PostgreSQL client tools
   and permission to create/drop its generated scratch database.
2. Install locked dependencies using `npm ci`. Deploy the server and its pinned
   `@twilio/voice-sdk` asset together; `/vendor/twilio.min.js` is served locally.
3. Apply `npm run migrate` before starting the new process. Nine migration
   entries should be present on a fresh installation. `/ready` must return 200.
4. Set `NODE_ENV=production`, `AUTH_REQUIRED=true`, `DEV_LOGIN_ENABLED=false`, a
   long random `SESSION_SECRET`, exact HTTPS `PUBLIC_BASE_URL`, Google OAuth,
   Twilio credentials, Verify service, and the `AGENT_DIRECTORY` allowlist.
   If email is enabled, set a dedicated `EMAIL_INBOUND_TOKEN`. Never check real
   tokens into this public repository.
5. Match the Google redirect URI to `/auth/google/callback`. Verify every agent's
   email, voice identity, MFA channel/destination, and role. Test an unlisted
   account and a viewer account before agent onboarding.
6. Configure reverse proxy trusted hops and body limits for the actual network.
   Retain webhook signature validation; a proxy/URL mismatch should be fixed at
   configuration, not worked around by disabling verification.
7. Set monitoring and retention policies before real customer traffic. The
   defaults retain most content indefinitely. Schedule backups and retention
   jobs outside the application process.

## 2. Provision Twilio

| Provider setting | Value / behavior |
| --- | --- |
| Test number Voice URL | `POST https://HOST/voice/inbound` |
| Test number call-status callback | `POST https://HOST/voice/status`; required to capture customer hangup/abandon independently of Dial completion |
| TwiML App Voice URL | `POST https://HOST/voice/outbound` |
| TwiML App call-status callback | `POST https://HOST/voice/status` |
| TwiML App SID | `TWILIO_TWIML_APP_SID` used by browser tokens |
| Caller ID | Purchased/verified voice-enabled `TWILIO_CALLER_ID` authorized for the account |
| Twilio Conversations | Service with `onMessageAdded` → `POST https://HOST/messaging/inbound` |
| Provider fallback URL | Independently hosted, reviewed fallback TwiML (alternate staffed number or carrier voicemail); this app has no independent fallback endpoint |

Child status, Dial result, transcription, disclosure, recording and voicemail
callbacks are included in generated TwiML. Allow Twilio to reach them directly
through your edge. Signed URLs include query strings; preserve those strings.
Use the account's webhook auth token, not an API-key secret, for signature checks.

Configure `VOICE_ALLOWED_PREFIXES` conservatively. Input validation blocks short
codes including `911`; the app does **not** implement emergency calling. Do not
represent this pilot as the agency's sole emergency-capable telephone.

`VOICE_RECORDING_ENABLED=false` disables conversation recording, but voicemail
still records a message by design. Coaching/recap flags govern live transcription.
The greeting/disclosure is a fixed announcement with a recorded disclosure event;
it is not a jurisdiction-aware consent engine or proof of affirmative consent.
Approve wording, opt-out behavior and storage rules for the actual operation.

Recording playback fetches a validated Recording SID from Twilio through the
authenticated server, using the configured API key/secret. Verify those credentials
have access to the account's recordings. The page never embeds REST credentials.
Long-recording seeking/range requests and secure download/export are follow-up work.

## 3. Configure routing and agent availability

Example (replace identities with entries from `AGENT_DIRECTORY`):

```json
{
  "agents": ["agent.one", "agent.two"],
  "strategy": "round_robin",
  "timezone": "America/New_York",
  "hours": {
    "1": [["09:00", "17:00"]],
    "2": [["09:00", "17:00"]],
    "3": [["09:00", "17:00"]],
    "4": [["09:00", "17:00"]],
    "5": [["09:00", "17:00"]]
  },
  "holidays": ["2026-12-25"],
  "ringSeconds": 20
}
```

Store as `VOICE_ROUTING_JSON`. Weekdays use 0=Sunday; hours use local time in the
specified IANA zone. Split overnight shifts into intervals on consecutive days.
Missing hours means open all day; missing weekday in configured hours is closed.
Strategies are `simultaneous`, `fixed`, `round_robin`, `longest_idle`.

The browser publishes presence every 25 seconds. Configured routes require an
available heartbeat within 75 seconds and reserve agents atomically while ringing.
Round robin ranks the last offer; longest idle ranks the last transition into
available state. `fixed` chooses the first eligible identity, not a sequential
ring-down chain. No available agent goes to voicemail; there is no waiting queue.
A retried inbound webhook reuses its recorded target decision.

With no route JSON, legacy `DEFAULT_AGENT_IDENTITY` routing is retained and does
not use server presence filtering. Use explicit routing for the pilot. Sign in,
click **Enable phone**, grant microphone access, and select **Available** before
calling the test number. A closed laptop is not a reliable incoming-call device.

## 4. Connect WiTnext and lead identity

Follow [the integration contract](witnext-integration-contract.md). Provision a
matching integration record and secret in WiTnext, then set URL, integration ID,
and secret in this service. Test the actual receiver with synthetic customers.
Do not treat a successful HMAC check alone as proof that intake fields rendered.

SmartFinancial email signals may come through authenticated `/email/inbound`
(JSON or URL-encoded payloads) or `/integrations/lead-signals`. Raw multipart
SendGrid payloads require an adapter; attachments are not parsed. If WiTnext's
existing email importer is the source of truth, add a normalized delivery from
that importer to this service. This branch does not change the WiTnext repo.

An exact provider call ID can match immediately. Time-only proximity is a
suggestion; the agent must confirm the customer. Overlapping candidates remain
ambiguous. Confirmed source and customer numbers remain distinct in the record.
WiTnext still needs its own agent/account mapping, source links and handling of
identity metadata. Test those screens explicitly before trusting the import.

## 5. Acceptance script for a live pilot

Use only agency-controlled test numbers and synthetic customer records.

| Scenario | Pass condition |
| --- | --- |
| Unlisted login / viewer | Denied login or no calling token; no write/call-control access |
| Agent isolation | Agent A cannot fetch B's call, recording or transcript by guessing an ID; admin can review |
| Incoming call | Eligible device rings, correct root call opens, both parties hear audio |
| Outgoing call | Authorized caller ID, destination announcement, bidirectional audio, blocked unsupported destination |
| DTMF/mute | Remote IVR receives digits; muted microphone is inaudible |
| Busy/no answer/abandon | No false completed conversation; caller reaches voicemail or terminal state correctly |
| Simultaneous ring | Answered agent owns call; losing-leg callback does not terminate it |
| Hours/DND/offline | Closed schedule and unavailable agents follow intended voicemail fallback |
| Voicemail | Message recorded, listed and playable only by authorized reviewer |
| Blind transfer | Customer stays connected; target opens same root record; both recordings retained; failure goes to voicemail |
| Browser refresh/expiry | Stored history remains; token renews; revoked/expired session loses live updates |
| Unsaved notes | Background detail refresh preserves draft; save/reload returns same text |
| Email first / call first | Exact match reconciles in both orders; no shared-source contact created |
| Overlapping transfer leads | No automatic time-only merge; one signal cannot be claimed for two calls |
| AI outage / missing transcript | Call completion arrives; failure/no-transcript state visible; no invented recap |
| Late transcript | New finalized text persists and recap regenerates |
| Restart after callback | Accepted event survives; worker resumes from DB without original session memory |
| WiTnext outage/replay | Retry preserves event ID, changes nonce; duplicate is 2xx, nonce rejection remains undelivered |
| SMS duplicate/STOP | One received message, opt-out survives restart, reply blocked while opted out |
| SMS timeout | Unconfirmed visible; repeated same send ID cannot send a second copy |
| Provider/app outage | Independently hosted fallback works; recovery has no orphaned accepted work |

Record Call SIDs, provider logs, screen captures, timing and observed results in
the private deployment ticket. Do not commit real transcripts or phone numbers.
Test browsers/networks/headsets actually used by agents, including VPN and mobile
hotspots if those are supported operationally.

## 6. Monitor and recover

The admin operations panel reports 24-hour call counts, live/missed calls,
voicemail, unresolved identities, recap attention, average duration, presence and
up to 100 outstanding service jobs. These are operational indicators, not a full
contact-center SLA dashboard. Alert externally on oldest pending work, failed jobs,
webhook 5xx/403 rate, database errors, missing parent completion and recording errors.

- `service_jobs` runs in the app. Workers claim with `FOR UPDATE SKIP LOCKED`,
  a five-minute lease and periodic renewal; a lease token fences completion by
  an old worker. Failed jobs back off and exhaust after eight attempts by default.
  Admin **Retry** resets only exhausted jobs; fix credentials/configuration first.
- Late transcripts refresh recomputable recap jobs. Outbound WiTnext delivery
  uses stable business-event IDs. Do not delete deduplication records to “retry.”
- `failed_jobs` is the separate legacy live-coaching/messaging retry path. Inspect
  `/admin.html` and use `npm run retry-jobs` for those entries.
- ERPNext recap/log mirroring and optional survey SMS are queued after a completed
  recap. They get **one automatic external attempt per call** because those APIs
  do not supply a common idempotent transaction. `post_call_effects` preserves
  `attempting`/`unconfirmed` outcomes; later retries stop rather than resend.
  Inspect the remote record/message first. An authorized operator can mark a
  confirmed effect `done`; rearming an unconfirmed effect requires evidence that
  it did not occur and a reviewed repair. Never blindly clear the receipt.
- Surveys skip locally opted-out customer conversations and shared transfer
  numbers. Configure recipient consent and carrier suppression externally.
  A late recap revision does not send another survey or mirror another ERP note.
- A non-delivered or late customer match can be confirmed in the workspace;
  confirmed late identity reissues the completion context and refreshes recap
  extraction. WiTnext must upsert that correction by stable call ID.

The server's `/ready` endpoint checks storage, not Twilio, models, WebSocket fanout,
queue age, external delivery or carrier reachability. Synthetic end-to-end probes
are required. The worker is sequential per app process; long AI work can delay
other jobs. Capacity sizing and separate worker pools remain follow-up work.

## 7. Retention, scale, and rollback

Run `npm run purge-retention` only against the intended environment after policy
review. It removes aged transcript segments/messages, expires recording access,
optionally deletes provider audio, and clears old completed-job payloads while
retaining keys. Failed/pending jobs, recaps, contacts, lead signals, raw email,
legacy DLQ payloads, backups and WiTnext/ERP copies need separately approved
retention or export/removal procedures. Do not describe this as comprehensive
erasure or legal-hold support.

For rollback, drain new traffic to the known-working provider route, keep the
new database intact, stop the new worker, and redeploy the previous application
only after checking schema compatibility. The migrations are additive; there is
no automatic down migration. Preserve queued work and receipts. Reconcile the
pilot call interval before reenabling deliveries, then verify routing with a
test call. Never overwrite the database with an old snapshot merely to revert UI.

Keep a single app instance for the initial pilot. PostgreSQL leases coordinate
jobs across processes, but live browser events still use an in-memory bus and
presence is not per device. Horizontal scaling needs shared pub/sub, session
revocation propagation, per-device registration policy, connection draining,
monitoring, DB replication and an explicit failover design.

## Verification performed for this branch

All fixtures are synthetic; provider integrations below use local mock servers.

- Unit suite: 142 passing; ten database cases skipped in the ordinary command.
- Opt-in PostgreSQL suite: ten passing, covering concurrent deduplication,
  parent/child state, restart/late-transcript behavior, source identity, routing
  reservations, worker fencing and persistent SMS opt-out.
- Voice/email/SMS simulation: 21 checks passing.
- Mock Groq pipeline: 11 checks passing, including invalid JSON and timeout fallback.
- Signed WiTnext broker simulation: seven checks passing.
- Backup restore: all 22 tables restored with matching row counts; migrations
  report no pending changes on the restored database.
- Browser automation: desktop and mobile workspace render, saved notes survive
  reload, no page errors, and no horizontal overflow at 390px viewport width.
- ESLint and whitespace validation pass.

These results do not certify live WebRTC/PSTN audio, real carrier SMS, production
OAuth/MFA, actual recording playback, emergency service, load capacity or live
WiTnext account/field mappings. Complete the acceptance script before promotion.
