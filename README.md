# WIT Connect — Telephony Starter

A Twilio **proof of concept** for WIT Connect (Build Strategy step 2): a browser
softphone that places and receives real calls, with TwiML webhooks that log call
lifecycle and recordings into the `wit_connect_schema.sql` Postgres database.

This is intentionally minimal — it proves browser calling, inbound routing,
recording, and DB logging end to end. It is **not** a finished contact center
(no ring groups, TaskRouter queues, or SLA logic yet — those are later phases).

## What's inside

```
src/
  server.js            Express app
  config.js            env loading + validation
  db.js                Postgres pool (no-op if DATABASE_URL unset)
  twilio.js            REST client + Voice access-token minting
  routes/
    token.js           GET /token  -> browser SDK token
    voice.js           POST /voice/outbound, /voice/inbound, /voice/dial-status, /voice/status
    recording.js       POST /recording/status -> call_recordings
  services/calls.js    maps Twilio webhooks onto the schema tables
public/
  softphone.html       working browser softphone (WIT-branded)
```

## Prerequisites

- Node.js 18+
- A Twilio account with a voice-capable phone number
- (Optional) the WIT Connect Postgres database loaded from `wit_connect_schema.sql`
- [ngrok](https://ngrok.com) (or any tunnel) so Twilio can reach local webhooks

## Setup

```bash
npm install
cp .env.example .env       # then fill in the values
```

Fill `.env`:

1. **Account SID** — Twilio Console home.
2. **API Key SID + Secret** — Console → Account → *API keys & tokens* → create a Standard key. Signs the browser tokens.
3. **TwiML App SID** — Console → Voice → TwiML → *TwiML Apps* → create one.
4. **Caller ID** — a Twilio number you own, in E.164 (`+1480…`).

## Run

```bash
npm run dev          # starts on :3000
ngrok http 3000      # in a second terminal -> copy the https URL
```

Put the ngrok URL in `PUBLIC_BASE_URL`, then point Twilio at these webhooks:

| Twilio setting | URL |
| --- | --- |
| **TwiML App → Voice Request URL** | `{PUBLIC_BASE_URL}/voice/outbound` |
| **Phone Number → A Call Comes In** | `{PUBLIC_BASE_URL}/voice/inbound` |

Open **http://localhost:3000/softphone.html?identity=marisol.vega**.

- **Outbound:** type a number, press **Call**. The browser → `/voice/outbound` → bridges to the PSTN.
- **Inbound:** call your Twilio number. It rings the browser client whose `identity` matches `DEFAULT_AGENT_IDENTITY`; no answer drops to voicemail.
- Each call writes a `calls` row; recordings land in `call_recordings` with a 13-month retention date.

## How it maps to the schema

| Event | Table write |
| --- | --- |
| Outbound/inbound TwiML | `INSERT calls` (+ stub `customers`, link `phone_numbers`) |
| `/voice/status` callback | `UPDATE calls` status / answered_at / ended_at / talk_seconds |
| `/recording/status` callback | `INSERT call_recordings` (consent=disclosed, retention) |

## Still required before production (planning doc §10.1)

This starter does not handle, and a real launch must: Twilio Trust Hub + **A2P 10DLC**
registration, number porting + failover, recording-consent disclosure by state,
authenticated SSO (don't trust the `identity` query param), webhook signature
validation (`twilio.validateRequest`), and the routing_rules / ring_groups logic
that this PoC stubs with a single agent identity.

> Twilio package versions, SDK release URLs, and pricing change. Validate against
> current Twilio docs before committing, exactly as the WIT Connect plan advises.
