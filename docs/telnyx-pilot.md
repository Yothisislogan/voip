# Telnyx + AssemblyAI pilot

This is the setup path for new WiT Connect voice installations. It replaces the
Twilio voice setup in `assemblyai-pilot.md`; the Docker/Caddy/Postgres hosting
instructions there still apply. Use one application instance for this pilot.

## What changed

- Browser: pinned `@telnyx/webrtc` SDK served locally; agent-specific JWTs issued
  only after WiT login. API keys never go to the browser.
- Native Voice API: server-originated outbound calls, inbound routing, spoken
  disclosure, recording, voicemail and inbound agent transfer.
- Outbound starts by ringing the signed-in agent's browser. The browser answers
  its matching dial request, then the server dials the customer. Browser audio
  can be connected while the customer is still ringing; the call record becomes
  `in_progress` only after the customer bridge event.
- Signed JSON webhooks are persisted before acknowledgment and processed by a
  separate voice worker. Ed25519 verification uses the exact raw body and a
  five-minute replay window. Event IDs deduplicate deliveries.
- Provider commands have durable receipts. A network timeout after sending a
  command may mean it succeeded: we show it as uncertain and do not blindly
  place a second paid call. Inspect Telnyx call logs before any manual recovery.
- Both tracks from the **customer leg** stream as PCMU/8 kHz into two AssemblyAI
  sessions. A bounded 120 ms reorder buffer precedes transcription. The customer
  leg stays the stream anchor across agent transfers.
- Recording playback uses an authenticated recording lookup and a configured
  HTTPS host allowlist. It never fetches URLs supplied by webhooks or users.

## Telnyx account configuration

1. Create a **Voice API / Call Control application** with API version 2 and
   webhook `https://YOUR_HOST/telnyx/voice`, method POST. Set an outbound voice
   profile with the intended countries, a spending limit and a pilot concurrency
   limit. The server additionally enforces `VOICE_ALLOWED_PREFIXES`.
2. Assign a **dedicated test number** to that application. Use its E.164 number as
   `TELNYX_CALLER_ID` and its resource ID as `TELNYX_PILOT_NUMBER_ID`. Only that
   number is accepted for inbound calls in this pilot.
3. Create a separate **credential connection for browser registrations**. Create
   one telephony credential per agent/device. Keep direct PSTN outbound dialing
   disabled on this browser connection: do not assign a PSTN outbound profile.
   The Voice API application originates customer calls using its own profile.
   Verify that the registered SIP username can receive API-originated SIP calls.
4. Add each credential ID and SIP username to that user's `AGENT_DIRECTORY` entry.
   Do not reuse one credential for several agents. Example (synthetic values):

   ```json
   [{"email":"agent@example.com","identity":"agent-one","role":"admin","name":"Pilot Agent","mfaPhone":"+12025550101","telnyxCredentialId":"credential-id","telnyxSipUsername":"gencredUsername"}]
   ```

   Keep the existing MFA fields for your directory format (see `.env.example`).
   Allow credential changes about five seconds to propagate before registration.
5. Set `DEFAULT_AGENT_IDENTITY` to the pilot agent. For a team configure
   `VOICE_ROUTING_JSON` with that directory's identities, availability, hours and
   routing strategy. Browser tabs must remain open and connected for incoming calls.
6. Copy the API key and account's base64 Ed25519 public key directly into the
   private server environment. Set `TELNYX_CONNECTION_ID` to the Voice API app ID.

## Server configuration

`npm run pilot:init` now generates a Telnyx-first `.env.pilot`, including separate
random database, session and media-ticket secrets. Existing files are preserved.
For an existing pilot add:

```dotenv
VOICE_PROVIDER=telnyx
TELNYX_API_KEY=
TELNYX_PUBLIC_KEY=
TELNYX_CONNECTION_ID=
TELNYX_CALLER_ID=
TELNYX_PILOT_NUMBER_ID=
TELNYX_MEDIA_SECRET=
TELNYX_RECORDING_HOSTS=recordings.telnyx.com
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=
```

Generate `TELNYX_MEDIA_SECRET` with at least 32 random characters. Retain Google
OAuth and session settings. **Twilio Verify remains the login second factor**;
retain its account/API credentials and Verify service. SMS/Conversations and
survey SMS remain Twilio-based and are disabled by default in the pilot. Moving
voice does not migrate message history, SMS numbers or verification services.

Apply migrations through **0011** before starting the updated app. The historical
`twilio_call_sid` field remains the stable application key so existing call links,
transcripts and CRM references survive. New Telnyx keys begin `tn_`. Real Telnyx
call/session/leg identifiers are stored separately. Do not rename old keys.

Run `npm run pilot:check`. With `--providers`, the script reads the Telnyx app,
number and credential mappings, and opens two short billable AssemblyAI sessions
using silence. It does not place calls. Confirm the browser connection's outbound
restrictions manually before real calls.

If recording playback reports an unconfigured host, retrieve the recording's
download host from the authenticated Telnyx dashboard/API and add that **exact
trusted hostname** to the comma-separated `TELNYX_RECORDING_HOSTS`. No wildcard
or arbitrary webhook URL is accepted. `RETENTION_DELETE_TELNYX_RECORDINGS=true`
enables provider-side deletion when the configured recording retention expires.

## Call assignment and tags

- Each call has one follow-up owner and up to 20 editable tags, each 1–40 characters.
- Automatic ownership starts with the handling agent. Once explicitly assigned
  (including Unassigned), later provider events do not overwrite that choice.
- Reassignment does not rewrite who handled the call or transfer live audio.
- Administrators can edit all calls. Handling agents, the assigned owner, and
  eligible route targets on unanswered calls can access their calls. Viewers are
  read-only. Assignment grants the new owner access; it does not revoke the
  original handling agent's historical access.
- Add/remove labels in Assignment & tags; replacing a label edits it on that call.
  Filter history by owner and exact tag (case-insensitive). Tags do not grant access.
- Concurrent edits return a conflict. Use Reload saved assignment & tags to
  discard the local organization draft, review the saved version, and try again.
- Changes are audited. Owner and tags accompany normalized call events sent to
  WiTNext; receiver support for displaying these new fields is a separate check.

## Real-call acceptance gate

Automated tests use mocked Telnyx/AssemblyAI services. They do **not** establish
real provider interoperability. Before porting/routing agency numbers:

1. Sign in, enable the browser phone, and verify microphone/speaker selection.
2. Place a short outbound call to an agreed test participant. Check the disclosure,
   two-way audio, keypad tones and hangup from either side.
3. Call the test number inbound, answer in the browser and repeat. Test unavailable
   agents, office closure, decline and voicemail through its 120-second limit.
4. Speak distinct phrases on both sides. Confirm correct speaker labels, visible
   live text, the final sentence after hangup, recap and authenticated recording
   playback. Use `npm run pilot:verify-call -- tn_CALL_ID` for stored evidence.
5. With two agents, test simultaneous ringing, one winner, and transfer to the
   other agent. Test an unanswered transfer and its voicemail fallback. Verify
   recording/transcription continuity on the customer leg and no stray agent leg.
6. Reassign the completed call, apply two tags, remove one, filter the history,
   and verify visibility using the receiving user's login. Test a simultaneous edit.
7. Interrupt only the transcription connection. Verify the call continues and the
   transcript is marked incomplete. Reconnect the browser between calls and test
   credentials/session expiry. Avoid deploying during live calls.
8. Inspect actual Telnyx/AssemblyAI usage and the operations queue before expanding.

A native transfer is limited to active inbound calls in this release. Hold,
conferences and user-controlled warm transfer remain unavailable. Audio device
and reconnect behavior still need real-browser/carrier acceptance testing.

## Recovery

Failed/uncertain commands appear as voice jobs in Service operations and in the
`telnyx_commands` table. Retrying a job will reuse accepted responses; it will
**not** resend an uncertain command. Reconcile against Telnyx call logs first.
The setup watchdog cancels known legs if a call fails to connect within 90 seconds;
unknown/uncertain provider-created legs must be checked in the provider dashboard.
Calls and media have four-hour limits. Process restarts cannot restore a lost
AssemblyAI audio stream; interrupted transcripts are marked accordingly.

## References

- https://developers.telnyx.com/docs/voice/webrtc/auth/jwt/index
- https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
- https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
- https://github.com/team-telnyx/telnyx-node (native command request schemas)
- https://github.com/team-telnyx/webrtc
