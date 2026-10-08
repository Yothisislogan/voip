# WiT Connect: AssemblyAI live-call pilot

**Telnyx is the selected voice provider for new pilots.** See [Telnyx setup](telnyx-pilot.md) for native calling, AssemblyAI, and call ownership/tags. The Twilio configuration below is retained for legacy installations.

## What this release does

Twilio handles telephone service and the browser softphone. A unidirectional
`<Start><Stream track="both_tracks">` forks the live audio to this app over WSS.
The app sends each track to its own AssemblyAI v3 streaming session, then saves
final turns and publishes them to the existing authenticated agent workspace.
Coaching, recordings and recaps use the existing application pipeline. This is
human-to-human calling with live text, not a bot answering customers.

- Native 8 kHz mu-law audio; no GPU or resampling service required.
- Agent/customer labels derive from call direction and track, not guessed voices.
- Two AssemblyAI sessions per call. Set `ASSEMBLYAI_MAX_CALLS` to no more than half
  the account's available session concurrency. Pilot default: two calls.
- Server-side API key, signed Twilio upgrades, a short-lived per-call stream
  ticket, account/format checks, bounded buffers, and duplicate-final protection.
- Final words drain before the stream closes; transcript persistence precedes
  coaching. Errors remain visible in the phone workspace and call record.
- A broken stream does not issue a Twilio hangup. It marks the transcript as
  incomplete. It does **not** reconnect/recover missing audio automatically.
- One app instance: agent events and stream sessions are process-local. Do not
  enable replicas until shared routing/event delivery is implemented.

The default deployment continues using Twilio transcription. Explicitly set
`TRANSCRIPTION_PROVIDER=assemblyai` to switch. `COACHING_ENABLED` or
`RECAP_ENABLED` must remain true to start transcription.

## Hosting decision

Recommended pilot: a separate US DigitalOcean Basic Droplet, Ubuntu 24.04,
2 vCPU / 4 GiB RAM / 80 GiB disk, using existing credits. Listed regular price
was $24/month on 2026-10-06; backups and usage services are additional. This is a
starting size, not a measured production capacity guarantee.

The same Docker setup can run on Hetzner after verifying location, spare memory,
disk, backups, and existing services/ports. Do not replace another application's
reverse proxy or database. Render can host the same Node service and WSS endpoint;
use always-on paid compute and durable Postgres. See `render-deployment.md` for
the existing service identity and its last verified configuration. Do not infer
that this old inventory establishes the current service state.

Universal-Streaming is listed at $0.15 per streaming session hour. This design
therefore costs approximately $0.30 per connected call hour for AssemblyAI alone
($0.005/min), including silence while connected. Twilio Media Streams is listed
at $0.0044/min, and telephone/browser legs, number rental, recordings, storage,
Verify, tax and hosting are additional. Check actual billed usage during pilot.
DigitalOcean credits do not cover Twilio or AssemblyAI bills.

## Deploy a dedicated test host

1. Create/select the dedicated host and install Docker Engine with Compose v2.
   Permit inbound TCP 80/443 and restrict SSH to the operator. Postgres and port
   3000 stay inside Docker. Point a dedicated DNS hostname to this host; don't
   put an interactive login wall in front of Twilio webhooks or `/voice/media`.
2. Clone this repository and check out the reviewed pilot release. Install Node
   22 if using the host-side initialization command below (the app uses Node 22
   inside Docker). Do not copy credentials from unrelated projects.
3. Run `npm run pilot:init` once. It creates `.env.pilot` with mode 0600 and random
   DB/session secrets. It refuses to overwrite an existing file. Edit that file
   **on the server**, without sending credentials through chat or GitHub.
4. Fill `WIT_DOMAIN` with the DNS hostname and `PUBLIC_BASE_URL` with the matching
   `https://` origin, without a trailing slash/path. Fill Twilio, AssemblyAI and
   Google OAuth credentials. Use a dedicated Twilio test number and TwiML app.
   Set `TWILIO_PILOT_NUMBER_SID` to that test number's PN identifier.
5. In Google OAuth, allow `https://<hostname>/auth/google/callback`. Populate
   `AGENT_DIRECTORY` with the operator's verified email, identity, admin role,
   and MFA destination. Example shape (replace all placeholders):

   ```json
   [{"email":"operator@example.com","identity":"pilot.operator","name":"Pilot operator","role":"admin","mfaChannel":"sms","phone":"+12025550100"}]
   ```

   Set `DEFAULT_AGENT_IDENTITY` to that identity. Configure the Twilio Verify
   service for the chosen MFA channel. Do not disable authentication to get a
   green deployment. Allow microphone access after signing in.
6. From the repository directory, run:

   ```bash
   docker compose --env-file .env.pilot -f docker-compose.pilot.yml build
   docker compose --env-file .env.pilot -f docker-compose.pilot.yml run --rm --no-deps app npm run pilot:check
   docker compose --env-file .env.pilot -f docker-compose.pilot.yml up -d
   docker compose --env-file .env.pilot -f docker-compose.pilot.yml ps
   ```

   Use this standalone Compose file, not a merge with `docker-compose.yml`.
   Startup validates production config, applies migrations through 0010, then
   exposes readiness. Caddy obtains TLS certificates and proxies both WebSockets
   on port 443. An existing host already using 80/443 needs its proxy integrated
   instead of launching this Caddy container. Never run `down -v` on retained data.

## Configure only the pilot number

| Twilio setting | URL / value |
| --- | --- |
| Test number: a call comes in | `https://<hostname>/voice/inbound`, POST |
| Test number: call status changes | `https://<hostname>/voice/status`, POST |
| Test TwiML app: voice request | `https://<hostname>/voice/outbound`, POST |
| Test TwiML app: call status callback | `https://<hostname>/voice/status`, POST |
| App `TWILIO_TWIML_APP_SID` | Test app AP identifier |
| App `TWILIO_CALLER_ID` | Owned test number, E.164 format |

Use direct Voice URL routing on this pilot number, not a SIP trunk or a separate
Voice Application override. The app creates Media Streams itself; no separate
AssemblyAI webhook or browser key is needed. Twilio trial accounts may require
verified test destinations. Check account balance and US calling permissions.

After `/ready` returns 200, optionally run:

```bash
docker compose --env-file .env.pilot -f docker-compose.pilot.yml exec app npm run pilot:check -- --providers
```

This reads the specified Twilio number/app and opens two brief AssemblyAI
sessions with silence. It can incur a small AssemblyAI charge. It places no call,
changes no Twilio configuration, and prints no key values. Configuration success
does not prove two-way audio or transcription quality.

## Real test calls and evidence

Use the operator's own phone and another explicitly identified test participant.
Do not dial customers or port the main business number for this test.

1. Sign in at `/phone.html`, select **Enable phone**, grant the microphone, set
   presence to Available, and keep the browser open with a headset.
2. Inbound: call the test number from a mobile. Accept in the browser. Both
   people speak an agreed phrase, for example "blue pickup truck" and "Tuesday
   at ten". Check two-way audio and that words appear before hangup with the
   correct agent/customer labels. Verify the recording/transcription disclosure.
3. Outbound: dial the verified test mobile from the browser and repeat. This
   checks that speaker labels reverse correctly with call direction. Test mute,
   DTMF, ringing, hangup from each end, and a final sentence just before hangup.
4. After processing finishes, open the call and play the recording. Compare both
   phrases and the last words with the transcript and recap. Check after a page
   reload. Save a machine-readable check using the **root** CA call SID:

   ```bash
   docker compose --env-file .env.pilot -f docker-compose.pilot.yml exec -T app node scripts/pilot-verify-call.js CA... > pilot-evidence-inbound.json
   ```

   Repeat for outbound. The output contains status checks, not transcripts or
   phone numbers. Audio quality, latency and label accuracy still need human
   verification; a passing JSON report alone is not a completed test.
5. Test an unanswered inbound call and voicemail. Verify recording and call
   status. Test a second simultaneous call if the account permits four AssemblyAI
   sessions. Test a controlled transcription outage: the phone call should
   continue, the transcript should show interruption, and final paid sessions
   should close. A restart/deploy interrupts transcription on active calls.
6. Before customer use: run the broader `voice-service-runbook.md` pilot,
   configure retention and scheduled off-server backups, and verify a restore.
   A local Docker volume is persistence, not a backup. Add the signed WiTNext
   integration only after the independent phone tests pass.

The bridge enforces a four-hour maximum streaming lifetime and a one-minute
media-idle timeout. It stops with a visible error on an excessive audio gap,
backpressure, or provider failure. There is no post-call audio backfill in this
release. Deployment should occur with no active pilot calls. Roll back by setting
`TRANSCRIPTION_PROVIDER=twilio` and restarting after active calls finish; retain
the database and additive migration. Do not assume transcripts are complete if
the call record shows an interruption.

## Sources checked 2026-10-06

- [AssemblyAI streaming API](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket)
- [AssemblyAI pricing](https://www.assemblyai.com/pricing)
- [Twilio Stream](https://www.twilio.com/docs/voice/twiml/stream)
- [Twilio Media Streams security and limits](https://www.twilio.com/docs/voice/media-streams)
- [Twilio US pricing](https://www.twilio.com/en-us/voice/pricing/us)
- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- [Render WebSockets and shutdown behavior](https://render.com/docs/websocket)
