# WIT Connect → WiTNext integration contract

WIT Connect is the **integration broker** between the phone/email layer and the
WiTNext CRM (per the WiTNext development plan §8). It normalizes call, recap,
transcript, recording, and email-lead events and delivers them to WiTNext's
integration API as signed, replay-protected HTTP POSTs. WIT Connect is a
broker, not a second CRM: WiTNext owns intake review and all customer data
decisions.

## Transport

```
WIT Connect ──POST──▶ {WITNEXT_URL}/api/v1/integrations/dialpad/events   (call.*)
WIT Connect ──POST──▶ {WITNEXT_URL}/api/v1/integrations/email/events     (email.*)
```

Paths are overridable via `WITNEXT_CALL_EVENTS_PATH` / `WITNEXT_EMAIL_EVENTS_PATH`.

## Envelope (request body, JSON)

```json
{
  "event_id":   "b8b1…-uuid",          // stable across retries — dedupe on this
  "event_type": "call.completed",
  "provider":   "wit_connect",
  "occurred_at":"2026-07-08T01:00:00.000Z",
  "sent_at":    "2026-07-08T01:00:01.000Z",  // fresh per attempt
  "nonce":      "32-hex-chars",              // fresh per attempt
  "payload":    { …event-specific… }
}
```

## Headers + signature

| Header | Value |
| --- | --- |
| `X-WIT-Event-Id` | envelope `event_id` |
| `X-WIT-Timestamp` | unix **seconds** at send time (fresh per attempt) |
| `X-WIT-Nonce` | envelope `nonce` |
| `X-WIT-Signature` | hex HMAC (below) |

```
signature = HMAC-SHA256( secret,
    timestamp + "\n" + nonce + "\n" + event_id + "\n" + raw_request_body )
```

The receiver MUST verify against the **raw body bytes** before JSON-parsing,
using a timing-safe comparison, and MUST reject:

- invalid signatures
- `|now − timestamp| > 300s` (stale or future-dated)
- reused nonces (track recent nonces for ≥ 5 minutes)
- oversized payloads
- unknown `event_type`s
- unauthorized integration identities

**Repeated `event_id`s are idempotent, not errors**: respond `409` (or `2xx`)
for an already-processed id — WIT Connect treats `409` as delivered. Any other
non-2xx (or a timeout) sends the event to WIT Connect's dead-letter queue,
which retries with exponential backoff **reusing the same `event_id`** while
regenerating timestamp/nonce/signature per attempt. Events can arrive out of
order (e.g. transcript before call.completed) — upsert by `payload.call_id`.

A reference verifier lives in `src/integrations/witnext.js`
(`verifyWitnextRequest`) — copy it into WiTNext.

## Event types + payloads

### `call.completed`
```json
{ "source": "twilio", "call_id": "CA…", "direction": "inbound",
  "external_number": "+14805551234", "from": "+1…", "to": "+1…",
  "agent_identity": "marisol.vega", "duration_seconds": 245 }
```

### `call.recap_available`
`call.completed` fields plus:
```json
{ "recap": { "summary": "…", "outcome": "follow_up", "productsDiscussed": [],
             "objections": [], "nextSteps": [], "followUpDate": "",
             "customerSentiment": "positive" },
  "score": { "score": 72, "sentiment": "positive", "outcome": "follow_up",
             "factors": [], "summary": "…" },
  "proposed_updates": [ { "field": "carrier", "value": "Progressive", "confidence": 0.81 } ] }
```
`proposed_updates` are the AI-extracted fields below the auto-apply confidence
threshold — WiTNext should route these into intake review, never auto-apply.

### `call.transcript_available`
`call.completed` fields plus `"transcript": "Agent: …\nCustomer: …"` (labelled
plain text). Store it per your transcript-retention policy, not in a hot table.

### `call.recording_available`
```json
{ "source": "twilio", "call_id": "CA…",
  "recording_reference": "https://api.twilio.com/…/Recordings/RE…",
  "duration_seconds": 245 }
```
A reference only — audio stays at the provider under its retention policy.

### `email.lead_received`
```json
{ "source": "email", "message_id": "…", "from_name": "Pat Rivera",
  "from_email": "pat@example.com", "subject": "Home quote request",
  "extracted": { "policy_type": "Home", "phone": "+1…", … } }
```
Normalized fields only — WIT Connect never forwards raw email bodies.

### Dialpad passthrough
When Dialpad webhooks are enabled (`DIALPAD_WEBHOOK_SECRET`), WIT Connect
verifies Dialpad's HS256-JWT-signed events at `POST /dialpad/events`, rejects
anything unsigned, and forwards the same event types with
`"source": "dialpad"`, `"dialpad_call_id"`, and `call_id` of the form
`dialpad:<id>`. Unrecognized Dialpad event shapes are acknowledged (204) but
not forwarded.

## Configuration (WIT Connect side)

```env
WITNEXT_URL=https://witnext.weinsurethings.com
WITNEXT_INTEGRATION_SECRET=      # dedicated secret — never reuse other secrets
# WITNEXT_CALL_EVENTS_PATH=/api/v1/integrations/dialpad/events
# WITNEXT_EMAIL_EVENTS_PATH=/api/v1/integrations/email/events
# WITNEXT_TIMEOUT_MS=8000
DIALPAD_WEBHOOK_SECRET=          # enables POST /dialpad/events (JWT-verified)
```

The bridge is entirely inert until `WITNEXT_URL` **and**
`WITNEXT_INTEGRATION_SECRET` are set. Undelivered events are visible in the
Admin Console failed-jobs queue (`kind: witnextEvent`) and drained by
`npm run retry-jobs`.
