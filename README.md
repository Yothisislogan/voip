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

## AI sales assist + ERPNext CRM (new)

Three capabilities layer on top of the softphone. All are **optional and
feature-flagged** — if their keys are unset, the phone works exactly as before.

1. **ERPNext screen-pop** — when a call connects, the backend looks up the
   caller's number in ERPNext (Frappe REST API, token auth) as a Contact then a
   Lead, and pushes the matching record (with a deep link) to the agent screen.
2. **Real-time coaching** — Twilio real-time transcription forks the call audio
   to `/voice/transcription`; finalized utterances are buffered and fed to Claude,
   which returns short cues across four lenses (objection handling, compliance
   disclosures, next-best question, sentiment/pacing) pushed live to the agent.
3. **End-of-call recap** — when transcription stops, Claude summarizes the full
   transcript into structured fields and writes a Communication (on the record's
   timeline) plus a Call Log onto the customer's ERPNext record.

### Architecture

```
Twilio call ──<Start><Transcription>──▶ POST /voice/transcription ─┐
                                                                   ├─▶ transcript buffer (per CallSid)
inbound/outbound ─▶ ERPNext Contact/Lead lookup ─▶ screen-pop     │
                                                                   ▼
Agent browser ◀── WebSocket /ws/agent ◀── coaching cues (Claude) + screen-pop
                                                                   │
transcription-stopped ─▶ recap (Claude) ─▶ Communication + Call Log on ERPNext record
```

The unified **agent workspace** is at `/agent.html` — dialer, live CRM card, and
coaching cues in one screen. Access requires an authenticated session (see
**Authentication** below); the agent's identity comes from that session, not a
URL parameter.

| File | Role |
| --- | --- |
| `src/crm/erpnext.js` | ERPNext (Frappe) client (token auth, find-contact-by-phone, write Communication/Call Log) |
| `src/ai/coach.js` / `recap.js` | Claude coaching cues + structured recap |
| `src/ai/transcript.js` | per-call transcript buffer |
| `src/realtime/orchestrator.js` | ties transcription → coaching → recap together |
| `src/realtime/ws.js` / `bus.js` / `sessions.js` | WebSocket push, agent event bus, call registry |
| `public/agent.html` | unified agent workspace |

### Configuration

See `.env.example`. Everything is optional:

- **ERPNext** — `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`.
  Generate keys in ERPNext under **User → Settings → API Access → Generate Keys**,
  using a dedicated integration user with access to Contact, Lead, Communication,
  and Call Log. Set `ERPNEXT_UI_URL` if the desk URL differs from the API base.
- **Claude** — `LLM_BACKEND` selects the backend:
  - `anthropic` (default): direct API, set `ANTHROPIC_API_KEY`.
  - `bedrock`: Amazon Bedrock — set `AWS_REGION` + AWS credentials (standard AWS
    chain); no API key. Keeps prompts/outputs in your AWS account/region under
    your BAA (see `docs/secure-ai-architecture.md`). Model IDs are auto-prefixed
    with `anthropic.`.
  `ANTHROPIC_MODEL` defaults to `claude-opus-4-8` (recap). Real-time cues are
  latency-sensitive: set `ANTHROPIC_COACHING_MODEL` to a faster model (e.g.
  `claude-haiku-4-5`) if cue latency matters more than depth. The coaching/recap
  code is backend-agnostic — only the client construction changes.
- **Flags** — `COACHING_ENABLED`, `RECAP_ENABLED`, `COACHING_THROTTLE_MS`.

Real-time transcription POSTs to your public URL, so **`PUBLIC_BASE_URL` must be
set** (ngrok locally) for coaching/recap to run.

### Compliance ⚠️

This adds **AI transcription** on top of call recording. Many US states require
two-party consent. The inbound greeting now discloses recording **and**
transcription; ensure your outbound flow and any custom greetings do the same,
and confirm state-by-state requirements before going live. Transcripts are held
in process memory only for the duration of a call and dropped after the recap;
they are not persisted by this app.

### Tests

```bash
npm test   # node --test: phone normalization, transcript buffering,
           # recap formatting, speaker mapping, session registry, WS delivery
```

### What to verify on a live setup

- Place an outbound call from `/agent.html` → a known CRM number; confirm the
  screen-pop card shows the contact and the deep link opens ERPNext.
- Speak both sides; confirm coaching cues appear within a few seconds.
- Hang up; confirm a recap renders and a Communication appears on the record's
  timeline in ERPNext.
- With `ANTHROPIC_API_KEY` / ERPNext unset, confirm the phone still places and
  receives calls normally (features silently skip).

## Messaging (SMS now, Apple Messages for Business later)

A provider-agnostic messaging channel that surfaces customer text threads in the
agent workspace, screen-pops the customer from ERPNext, and logs the
conversation to their CRM timeline — reusing the same WebSocket + ERPNext
plumbing as voice. Today it runs on **Twilio Conversations** (SMS/WhatsApp);
**Apple Messages for Business (AMB)** plugs in as another channel once an
Apple-approved MSP is live (see `docs/messaging-integration-contract.md`).

```
customer text ─▶ provider (Twilio Conversations / Apple MSP)
        │  onMessageAdded webhook
        ▼
POST /messaging/inbound ─▶ normalize ─▶ conversation buffer ─▶ ERPNext screen-pop + log
        │                                                              │
        └─▶ WebSocket /ws/agent ("message")  ◀── agent reply via POST /messaging/send
```

- **Channel-pluggable:** `src/messaging/providers.js` holds the adapters; add an
  Apple-MSP adapter there without touching the core. Selected by `MESSAGING_PROVIDER`.
- **Screen-pop nuance:** SMS exposes the phone (so ERPNext lookup works); **AMB
  uses an opaque Apple id**, so AMB threads identify the customer via an in-chat
  step rather than phone.
- **Routing (MVP):** inbound threads route to `DEFAULT_AGENT_IDENTITY`. Replace
  with a queue/availability model later.
- **Same PII posture:** chat carries customer PII and flows into ERPNext, so the
  HIPAA-aligned controls in `docs/secure-ai-architecture.md` extend here.

Setup: create a **Twilio Conversations** service, set `TWILIO_CONVERSATIONS_SERVICE_SID`,
and point its `onMessageAdded` webhook at `{PUBLIC_BASE_URL}/messaging/inbound`.

## Postgres CRM & data pipeline

With `DATABASE_URL` set, the app owns a **Postgres CRM** as its operational store
(schema in `db/schema.sql`, applied via `npm run migrate`). The call/message
pipeline reads and writes it; ERPNext remains an optional external mirror.

| Table | Filled by |
| --- | --- |
| `contacts` (leads) | phone match on call/SMS; email intake; AI-extracted insurance fields |
| `calls` | each call, linked to a contact |
| `transcript_segments` | every finalized utterance (persistent) |
| `call_scores` | 0–100 lead/quality score + factors, per call |
| `surveys` | post-call CSAT/NPS SMS + captured reply |
| `email_intake` | parsed inbound emails → leads |

What happens on a call, when `DATABASE_URL` is set:

1. **Screen-pop** matches/creates the caller by phone (`contacts`) and opens a `calls` row.
2. Each utterance is **persisted** to `transcript_segments` (alongside the in-memory buffer used for live coaching).
3. On hang-up: the recap runs, the call is **scored** (`call_scores`), **lead fields are extracted** from the transcript onto the contact, and (opt-in) a **survey SMS** is sent — the reply is matched back and stored.

**Email intake:** point a SendGrid/Mailgun inbound-parse webhook at
`/email/inbound`; it parses the sender, phone, and insurance details into a
lead. Optional shared secret via `EMAIL_INBOUND_TOKEN`.

**Scoring & extraction are local/deterministic** — no LLM required — so they work
regardless of `LLM_BACKEND`.

**Deploy:** `docker compose up -d --build` runs the app + Postgres and applies
the schema automatically. See `docs/deploy-hetzner.md`.

## Authentication (Google OAuth + 2FA)

The app pages, the Twilio token endpoint, and the agent WebSocket all require an
authenticated session. Agents sign in with **Google**, then complete a **second
factor** via **Twilio Verify** (SMS or email). Identity is derived from a signed,
httpOnly session cookie — never from a URL parameter — so an agent can only ever
get a token for, and receive live events (which contain customer PII) for, their
own identity.

### Flow

```
/agent.html ──(no session)──▶ /login ──"Sign in with Google"──▶ Google OAuth
   ▲                                                                  │
   │                                            verified email checked against
   │                                                  AGENT_DIRECTORY allowlist
   │                                                                  │
   └──(full session cookie)── /2fa ◀──(pending session + Twilio Verify code)──┘
```

- **Allowlist:** only emails in `AGENT_DIRECTORY` can sign in; each maps to a
  Twilio identity and an MFA destination. (Optionally also restrict to a Google
  Workspace domain with `GOOGLE_HOSTED_DOMAIN`.)
- **Two trust levels:** `pending-2fa` after Google, `full` only after the code is
  verified. Only `full` may use the app.
- **Sessions** are stateless signed JWTs in an httpOnly + SameSite=Lax cookie
  (Secure when served over HTTPS) — no session store, multi-instance friendly.

### Setup

1. **Google:** Cloud Console → APIs & Services → Credentials → OAuth client ID
   (Web application). Add redirect URI `{PUBLIC_BASE_URL}/auth/google/callback`.
   Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. **Twilio Verify:** Console → Verify → Services → create one; set
   `TWILIO_VERIFY_SERVICE_SID`. (For the email channel, configure Verify's email
   integration.)
3. **Secrets:** `SESSION_SECRET` = `openssl rand -hex 32`.
4. **Allowlist:** fill `AGENT_DIRECTORY` (see `.env.example`).

### Local dev / testing without Google

Two options, both **dev-only** (remove before production):

- **`DEV_LOGIN_ENABLED=true`** — keeps auth on, but the login page shows a
  "Continue as developer" field that signs you in as any identity, skipping
  Google + 2FA. Good for testing the real session flow (e.g. on Render) before
  Google OAuth is configured. Needs `SESSION_SECRET` set.
- **`AUTH_REQUIRED=false`** — bypasses auth entirely and injects `DEV_IDENTITY`;
  no login step at all. The server prints a loud warning.

## Still required before production (planning doc §10.1)

This starter does not handle, and a real launch must: Twilio Trust Hub + **A2P 10DLC**
registration, number porting + failover, recording-consent disclosure by state,
authenticated SSO (don't trust the `identity` query param), webhook signature
validation (`twilio.validateRequest`), and the routing_rules / ring_groups logic
that this PoC stubs with a single agent identity.

> Twilio package versions, SDK release URLs, and pricing change. Validate against
> current Twilio docs before committing, exactly as the WIT Connect plan advises.
