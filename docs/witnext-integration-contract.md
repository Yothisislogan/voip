# WiT Connect → WiTnext integration contract

WiT Connect owns operational telephone state and delivers normalized evidence to
WiTnext. WiTnext owns intake acceptance, customer/account assignment and business
record decisions. A local phone contact ID is not a WiTnext customer ID.

## Signed transport

Call events POST to `{WITNEXT_URL}/api/v1/integrations/dialpad/events`; email events
POST to `{WITNEXT_URL}/api/v1/integrations/email/events`. Paths are configurable.

```json
{
  "event_id": "wit:call.completed:<stable-payload-hash>",
  "event_type": "call.completed",
  "provider": "wit_connect",
  "occurred_at": "2026-10-03T14:00:00.000Z",
  "sent_at": "2026-10-03T14:00:01.000Z",
  "nonce": "<fresh-random-value>",
  "payload": { "source": "twilio", "call_id": "CA..." }
}
```

| Header | Value |
| --- | --- |
| `X-WIT-Integration-Id` | Provisioned WiTnext integration record ID |
| `X-WIT-Event-Id` | Stable envelope event ID |
| `X-WIT-Timestamp` | Unix seconds, refreshed per attempt |
| `X-WIT-Nonce` | Random nonce, refreshed per attempt |
| `X-WIT-Signature` | Hex HMAC-SHA256 described below |

```text
HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + event_id + "\n" + raw_body)
```

Verify exact raw bytes, integration authorization, a five-minute timestamp window,
nonce uniqueness and payload limits. `verifyWitnextRequest` provides signature
and freshness checks only; it does not implement receiver identity lookup,
nonce storage, event dedupe or authorization.

**Only 2xx acknowledges delivery.** WiTnext's existing duplicate-event response is
200; 409 is a nonce replay rejection and must not silently discard the event.
Retries reuse `event_id` with a new timestamp, nonce and signature. Redirects are
rejected. Duplicate callbacks and worker retries can produce at-least-once
transport, so the receiver must deduplicate event IDs and upsert by `call_id`.

Events can arrive in any order and in more than one revision. A call-completed
update may correct late customer identity or disposition. Do not create another
intake row just because a corrected payload gets a different stable event hash.
Absence of a field must not erase an earlier valid value. Optional null fields
are omitted to match the receiver's validation contract.

## Call events

Supported types are `call.completed`, `call.recap_available`,
`call.transcript_available`, `call.recording_available`. There is no `call.updated`
event in the current receiver contract. No lifecycle event depends on AI success.

Common fields when known:

```json
{
  "source": "twilio",
  "call_id": "CA...",
  "direction": "inbound",
  "external_number": "+12025550101",
  "from": "+12025550101",
  "to": "+12025550100",
  "agent_identity": "agent.one",
  "started_at": "2026-10-03T14:00:00.000Z",
  "ended_at": "2026-10-03T14:04:00.000Z",
  "duration_seconds": 240,
  "disposition": "follow_up"
}
```

A SmartFinancial transfer additionally carries `source_number`, `identity_state`
and `identity_evidence`. Until the real customer is known, `external_number` and
inbound `from` are absent. **Never fill them with the shared transfer line.** The
current WiTnext receiver may ignore this additional metadata; supporting it and
linking the call to an account/customer requires a receiver change.

A recap adds:

```json
{
  "recap": {
    "summary": "Customer requested a quote and a follow-up call.",
    "outcome": "follow_up",
    "action_items": ["Call the customer about the quote."]
  },
  "score": { "score": 72, "sentiment": "positive", "outcome": "follow_up" },
  "proposed_updates": [{ "field": "carrier", "value": "Example carrier", "confidence": 0.81 }]
}
```

Local `nextSteps` are copied to `action_items`. Partial Dialpad recap events do
not fabricate empty action arrays, so a summary-only update cannot intentionally
clear existing actions. WiTnext must merge recap fields instead of replacing the
whole object with the latest partial event. Low-confidence proposed updates
require review; this bridge does not accept them into WiTnext automatically.

Transcript adds labeled plain text in `transcript`. Recordings add
`recording_reference` and, for Twilio, `recording_id`. Recording availability can
precede completion and multiple references may belong to one root call. Recording
duration is not substituted for total call duration. Audio remains at the provider;
references do not grant browser access to provider credentials. Receiver retention
and handling of oversized transcripts require separate configuration/testing.

## Email events and normalized lead signals

`email.lead_received` includes `source`, stable `message_id`, customer `from_name`
and `from_email` when known, subject and normalized `extracted` fields. For vendor
emails, the vendor sender is not presented as the customer. Raw email bodies are
not forwarded to WiTnext, although authenticated intake stores the body locally.

Configure the existing email delivery service to POST JSON or URL-encoded fields
(`from`, `subject`, `text`, `message_id`) to `/email/inbound`, authenticated with
`EMAIL_INBOUND_TOKEN` in the `X-Intake-Token` header. Multipart intake and mailbox
polling are not implemented. Repeated stable message IDs reuse the same local
intake. The parser supports labeled SmartFinancial customer fields; prefer a
normalized signal when upstream data is already structured.

A WiTnext/email adapter can instead call:

```http
POST /integrations/lead-signals
Authorization: Bearer <LEAD_SIGNAL_TOKEN>
Content-Type: application/json
```

```json
{
  "source": "smartfinancial",
  "source_id": "vendor-lead-123",
  "customer_name": "Alex Example",
  "customer_phone": "+12025550101",
  "customer_email": "alex@example.com",
  "business_name": "Example Company",
  "destination_number": "+12025550100",
  "agent_identity": "agent.one",
  "provider_call_id": "CA...",
  "received_at": "2026-10-03T13:59:00.000Z"
}
```

Only `source_id` is mandatory. Supply the actual provider call ID only when
verified. Do not substitute a vendor lead ID for a Call SID. The dedicated bearer
secret is unrelated to the WiTnext outbound signing secret. The endpoint returns
202 after storing the signal and scheduling reconciliation, not after accepting
a WiTnext customer record.

Matching rules:

1. Never treat `SHARED_SOURCE_NUMBERS` as a customer's phone.
2. A unique exact provider call ID or real customer phone is authoritative.
3. A single recent vendor lead within `LEAD_MATCH_WINDOW_MINUTES`, with compatible
   destination/agent if supplied, is a **suggestion**, not an automatic merge.
4. Multiple eligible leads remain ambiguous. No evidence remains awaiting lead.
5. Agent confirmation atomically claims a signal for one call. A later match
   corrects completed-call context and reruns extraction from durable transcript.

This branch exposes the receiving endpoint. It does not deploy a sender inside
WiTnext or change its email parser, account mapping, intake screen, task renderer
or source-link builder. Those receiver changes remain an explicit integration
work item in the replacement ledger.

## Dialpad coexistence

`POST /dialpad/events` requires the HS256 JWT signed with
`DIALPAD_WEBHOOK_SECRET`; unsigned payloads receive 403. Subscribe to the actual
call-event states needed for hangup, recap components, transcription and recording.

The adapter processes multiple event types in one callback, normalizes Unix
millisecond times and durations, uses the real external number, and distinguishes
a user target/operator from a department target. Call IDs remain `dialpad:<id>`;
this does not promise aggregation of every Dialpad transfer leg into one call.

`call_transcription` is a notification. A durable job fetches full text from the
fixed official `/api/v2/transcripts/{call_id}` endpoint using `DIALPAD_API_KEY`;
webhook-supplied URLs are never fetched as arbitrary destinations. Missing API
permissions or unavailable transcript remains visible retryable work. Recordings
may arrive as multiple references. Partial recap summary/outcome/action events
are forwarded separately for receiver merge.

## Configuration and recovery

```env
WITNEXT_URL=https://your-witnext-host.example
WITNEXT_INTEGRATION_ID=<provisioned-record-id>
WITNEXT_INTEGRATION_SECRET=<dedicated-secret>
LEAD_SIGNAL_TOKEN=<different-dedicated-secret>
DIALPAD_WEBHOOK_SECRET=<optional>
DIALPAD_API_KEY=<optional-transcript-access>
```

The bridge is off without URL and signing secret; startup flags a missing identity
when enabled. New events use PostgreSQL `service_jobs`, persisted before webhook
acknowledgement or in the same transaction as call state. The server drains these
jobs automatically. Pausing the bridge does not claim old queued deliveries
succeeded; they remain retryable/exhausted until configuration is restored.

The phone operations panel exposes failed service work. Fix the receiver or
credentials, then retry exhausted delivery with the original event ID. The older
`failed_jobs` table and `npm run retry-jobs` are separate legacy recovery paths.
Do not clear either queue to hide a receiver validation error.
