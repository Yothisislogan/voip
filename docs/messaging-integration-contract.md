# Messaging & Apple Messages for Business — Integration Contract

How the unified messaging layer works, the interface a provider/MSP must satisfy,
and how to bring **Apple Messages for Business (AMB)** online (the prior AMB
channel via Dialpad was dropped, so a new Apple-approved MSP is needed).

> ⚠️ Not legal/contractual advice. Vendor programs and approvals change —
> confirm current terms and BAAs with each provider.

---

## 1. The hard part: AMB is a gated channel

AMB needs **two approvals before code matters**:

1. **An Apple-approved Messaging Service Provider (MSP)** carries the traffic.
   Either go through an approved MSP, or become your own MSP by integrating
   [Apple's MSP REST API](https://register.apple.com/resources/messages/msp-rest-api/)
   (JWT-signed `/message` webhook, build a full feature demo, pass a live review
   with Apple) — the latter is a platform project, not worth it for one brand.
2. **Apple Business Register** brand enrollment + approval for the business.

### MSP options to evaluate (replacing Dialpad)

| MSP | Notes |
|---|---|
| **Twilio** (Conversations) | AMB in **private beta** (as of 2026). Lowest friction here — you're already on Twilio, and AMB rides the same Conversations API as SMS. Apply via Twilio sales. |
| **Quiq** | Long-standing approved Apple MSP/CSP. |
| **LivePerson** | Approved MSP; enterprise contact-center focus. |
| **Sinch / Zendesk / Mavenir / CM.com** | Other approved MSPs/aggregators. |

Recommended: pursue **Twilio's AMB beta** first (least new code via this app's
existing adapter), with an approved MSP (Quiq/LivePerson) as the fallback. Either
way, the app talks to **one adapter** — see §3.

---

## 2. What this app already implements

A provider-agnostic messaging layer (`src/messaging/`), feature-flagged and
no-op when unconfigured:

- **Inbound:** `POST /messaging/inbound` (Twilio-signature validated) → normalized
  to a channel-agnostic message → buffered per conversation → ERPNext screen-pop
  (by phone, when available) → pushed to the agent over the WebSocket
  (`type: "message"`) → logged to ERPNext as a Chat Communication.
- **Outbound:** agent replies via `POST /messaging/send` (authenticated) → the
  active provider adapter sends it → logged + echoed to the agent's tabs.
- **Conversation list:** `GET /messaging/conversations` (authenticated).
- **UI:** a Messages panel in `/agent.html` (conversation chips + thread + reply).
- **Default impl:** Twilio Conversations adapter (`src/messaging/providers.js`).

### Config
`MESSAGING_ENABLED`, `MESSAGING_PROVIDER`, `TWILIO_CONVERSATIONS_SERVICE_SID`,
`MESSAGING_BUSINESS_AUTHOR` (see `.env.example`). Point the Conversations
`onMessageAdded` webhook at `{PUBLIC_BASE_URL}/messaging/inbound`.

---

## 3. The provider/MSP adapter contract

To add a new MSP (e.g. a different Apple MSP), implement an adapter in
`src/messaging/providers.js` with:

- `name: string`
- `async send({ conversationId, channel, customerRef, text }) → boolean`

…and a **normalizer** (like `normalizeTwilioConversations`) that maps the
provider's inbound webhook into the channel-agnostic shape:

```
{ provider, channel, conversationId, customerRef, customerPhone|null, text, messageSid }
```

Return `null` from the normalizer for non-message events and for our own
outbound echoes. Wire the new normalizer into `handleInbound` (or branch by
provider). Nothing else in the app changes.

---

## 4. AMB-specific nuances to design for

- **No phone number.** AMB identifies the customer with an **opaque Apple id**,
  not a phone — so phone-based ERPNext screen-pop won't work for AMB. Identify
  the customer via an AMB **interactive/authentication** message, or ask in-chat,
  then map the opaque id → ERPNext record and persist that mapping.
- **Rich/interactive message types.** AMB supports list pickers, time pickers,
  forms, Apple Pay, and rich links. The current adapter sends plain text; extend
  the adapter + UI for interactive types when needed.
- **Entry points.** AMB starts from Maps, Safari, Spotlight/Siri, QR/NFC, website
  buttons, and "tap to message" IVR deflection — configured in Apple Business
  Register, not in this app.
- **Compliance.** AMB threads carry customer PII; they flow into ERPNext and (if
  AI assist is added) the LLM. The HIPAA-aligned controls in
  `docs/secure-ai-architecture.md` apply — sign a BAA with the chosen MSP, and
  keep PII redaction/retention rules consistent across voice and messaging.

---

## 5. Suggested next steps

1. **Pick + apply to an MSP** (Twilio AMB beta first) and enroll in **Apple
   Business Register**. This is the long pole — start now.
2. **Stand up Twilio Conversations** for SMS to exercise the layer end-to-end
   today (set the env vars + webhook).
3. When the MSP is live, add/confirm the adapter + normalizer per §3, plus the
   opaque-id → ERPNext mapping per §4.
4. Optional follow-up: **AI assist for chat** (Claude suggested replies +
   end-of-thread recap), reusing `src/ai/` — parallels the voice coaching/recap.
