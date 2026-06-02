# WIT Connect — Build Package

**We Insure Things · WIT-branded phone, SMS & AI contact-center platform**

This folder is the discovery/blueprint hand-off for WIT Connect — a working
foundation a developer or vendor can build on. It implements the "First Build
Package" (§16 of the project plan) as real, runnable artifacts rather than
slideware: a clickable prototype, the database it runs on, a Twilio voice proof
of concept, the AI prompt library, the front-to-back API contract, and a cost
model.

> Everything here is a starting point. Pricing, Twilio APIs, and compliance
> requirements change — validate all of it before vendor commitment, number
> porting, or messaging registration, exactly as the project plan advises.

---

## What's in the package

| # | Folder | Deliverable | Open with |
| --- | --- | --- | --- |
| 01 | `01-prototype/` | Clickable Agent / Manager / Admin dashboards with the live Add-a-Car AI workflow, on the WIT brand palette. | React component (`.jsx`) |
| 02 | `02-database/` | PostgreSQL schema — all 15 tables from §12 plus supporting tables, indexes, triggers, and seed data. | `psql -f wit_connect_schema.sql` |
| 03 | `03-telephony/` | Twilio voice proof of concept — browser softphone + TwiML webhooks that log calls/recordings into the schema. | See its own `README.md` |
| 04 | `04-ai/` | AI prompt library (call summaries, flags, QA) + the four insurance workflows, plus a JSON seed for the `ai_prompts` table. | Markdown + JSON |
| 05 | `05-api/` | REST + WebSocket route map wiring the dashboards to the backend. | Markdown |
| 06 | `06-cost-calculator/` | Interactive monthly operating + build cost model (§8/§9). | React component (`.jsx`) |

The `.jsx` files render directly as Claude Artifacts, or drop into any
React + Vite project. The schema and telephony app run locally as described in
their files.

---

## How the pieces connect

```
                         ┌──────────────────────────┐
   Browser softphone ───▶│  03-telephony (Express)   │
   (03 / public)         │  TwiML + status webhooks  │
                         └────────────┬──────────────┘
                                      │ writes
                                      ▼
   01-prototype  ◀── 05-api ──▶  02-database (Postgres)
   dashboards       REST/WS          calls, sms, ai_flags,
                    contract         summaries, tasks, audit…
                                      ▲
                                      │ writes
                         ┌────────────┴──────────────┐
                         │  04-ai prompt pipeline     │
                         │  transcript ▶ summary/flags│
                         └────────────────────────────┘
```

1. The **softphone (03)** places/receives calls; Twilio webhooks write `calls`
   and `call_recordings` rows into the **database (02)**.
2. The **AI pipeline (04)** runs the prompt library over each transcript and
   writes `call_summaries`, `ai_flags`, and follow-up `tasks`.
3. The **dashboards (01)** read and act on all of it through the **API (05)**,
   with live updates over WebSocket.
4. The **calculator (06)** sizes the monthly + build budget for whatever scope
   WIT commits to.

---

## Suggested first steps for a developer

1. **Stand up the database:** create a Postgres DB and run `02-database/wit_connect_schema.sql`. Confirm the seed dispositions, templates, and AI prompts loaded.
2. **Run the voice PoC:** follow `03-telephony/README.md` — fill `.env`, `npm install`, `npm run dev`, expose with ngrok, point a Twilio number + TwiML App at the webhooks, and place a test call from the softphone.
3. **Point telephony at the DB:** set `DATABASE_URL` and confirm a `calls` row and a `call_recordings` row appear after a test call.
4. **Build to the contract:** implement the `05-api` routes against the schema; the prototype (01) shows the intended UI and behavior for each.
5. **Wire the AI pipeline:** load `04-ai/wit_connect_ai_prompts.json` into `ai_prompts`, then run post-call analysis on completed transcripts.

---

## Out of scope here (human work still required — §10.1)

This package deliberately stops at the buildable blueprint. Before a real launch,
WIT (with a developer and counsel) still needs:

- Twilio account setup, Trust Hub, **A2P 10DLC** brand + campaign registration.
- Number porting and failover planning (pilot on new numbers first).
- Apple App Store / Google Play setup (mobile is a later phase).
- Webhook signature validation, SSO-backed auth (don't trust the `identity`
  param), security review, and penetration testing.
- Legal/compliance review of call recording (one- vs two-party consent),
  texting (TCPA), transcripts, and AI summaries.
- Production monitoring, support staffing, and agent training.

## Recommended path (from the plan)

Keep Dialpad live during development. Build the web phone MVP first, then SMS,
then AI, then mobile, then NowCerts/AgencyZoom integration — piloting with one
team and porting main numbers only after the system proves itself on call
quality, compliance, failover, and training.

---

*Prepared as a WIT Connect build foundation. Estimates and templates require
validation before commitment.*
