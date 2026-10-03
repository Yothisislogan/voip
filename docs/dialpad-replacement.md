# Dialpad replacement scope and release gates

Reviewed 2026-10-03. This is the capability ledger for the voice-service branch.
“Implemented” means there is executable code in this repository; it does not
mean a production provider account has passed acceptance testing. No phone
numbers have been moved, production services deployed, or subscriptions canceled
as part of this change.

## What this release is solving

The WiTnext review exposed a broken chain between telephone activity and usable
customer records. Missing caller identity, transfer numbers mistaken for
customers, unfinished or missing recaps, delayed events, and weak source links
make an apparently successful call integration operationally unreliable.

The service now treats the call as a durable record with independent lifecycle,
identity, transcript, recap, recording, and delivery state. One missing component
cannot prevent the rest from being recorded. It also gives agents a usable
workspace instead of presenting disconnected demonstration controls.

| Failure mode | Implementation | Boundary that remains |
| --- | --- | --- |
| A shared vendor line becomes the customer | Store `source_number` separately; omit it from WiTnext customer phone fields; exclude it from contact creation | Configure every vendor source number; historical contaminated contacts need an explicit reconciliation project |
| A vendor email arrives before or after the call | Persist lead signals; reconcile in either order; exact identifiers match, time-only candidates require confirmation | WiTnext/email infrastructure must deliver the normalized signal or supported email payload |
| Two nearby leads are silently merged | Ambiguous identity state and agent confirmation; atomic claim prevents reuse of one signal across calls | Agents must resolve ambiguous cases; this is not an identity-verification service |
| Completion disappears when AI fails | Root status and Dial callbacks save lifecycle and enqueue delivery independently | Number/TwiML App parent status callbacks must be configured |
| Process restart loses recap work | Final utterances and call context live in PostgreSQL; leased jobs reconstruct context | Live coaching history is still process-local; stored transcript remains recoverable |
| Late transcript leaves an incomplete recap | Transcript fingerprint changes, refreshing recap work | Provider must deliver final events; absent transcripts are visible and cannot be fabricated |
| Recap “next steps” arrive under the wrong field | Normalize local `nextSteps` to receiver `action_items` | Receiver still owns readable task rendering and intake acceptance |
| Integration returns replay rejection but sender considers it delivered | Only 2xx means delivered; 409 retries with fresh nonce/signature | Stable event-ID deduplication must be retained on the receiver |
| Customer/source links are broken | Operational customer and call links use actual stored IDs | WiTnext account mapping and reciprocal source-call links require receiver work |

## Capability ledger

The baseline spans Dialpad's calling and broader product families; entitlements
vary by product and plan. “Planned” rows are intentionally not exposed as working
controls. “Partial” rows describe their exact supported scope.

### Calling and agent experience

| Capability | Status here | Acceptance or remaining work |
| --- | --- | --- |
| Browser inbound/outbound PSTN calling | Implemented; live verification pending | Bidirectional audio, identity, caller ID, answer/reject/hangup, busy and no-answer on provisioned test number |
| Phone registration and expiring tokens | Implemented | Keep a signed-in phone registered past token expiry; verify reauthentication behavior |
| Mute and touch tones | Implemented | Verify microphone isolation and digits against an actual IVR |
| Audio device selection | Implemented where browser permits | Headset unplug/replug, default device changes, output-selector support |
| Call-quality feedback | Partial: SDK warnings and reconnect state | Persist network/MOS diagnostics and correlate degraded calls before making quality SLO claims |
| Call history/search/details | Implemented | Pagination and role scoping with realistic data volumes |
| Notes and dispositions | Implemented | Save/reload, editing during background refresh, failed-save recovery |
| Customer screen pop | Implemented | Known, unknown, shared-source, and ambiguous identity fixtures |
| Read-only versus agent/admin roles | Implemented for calls and operations | Contacts remain an agency-wide directory; no departments/tenant hierarchy |
| Browser notifications | Implemented with user opt-in | Background-tab notification and microphone permissions in supported browsers |
| Blind transfer | Partial: active inbound call to internal agent | Verify both recording legs, answered/unanswered destination and voicemail fallback; no external/outbound transfer |
| Hold/resume and music on hold | Planned | Server-owned conference participants, hold state, safe resume, failure recovery |
| Warm/consult transfer | Planned | Consult leg, cancel/return, complete transfer atomically without dropping customer |
| Three-way/add-participant calls | Planned | Conference roles, participant controls, all recording/consent boundaries |
| Call park and pickup | Planned | Stable park slots, expiry, permissions, competing pickup attempts |
| Shared line/assistant delegation | Planned | Ownership and notifications across principals; separation from ordinary ring groups |
| Call flip between devices | Planned | Preserve caller leg while moving authenticated agent connection |
| Caller-ID selection/multiple numbers | Partial: one configured outbound caller ID | Authorized number inventory, inbound routing by DID and identity-specific permissions |
| Contact click-to-call | Partial: workspace dialer plus local CRM | Broader CRM click-to-call and extension/browser integration |
| Native desktop/mobile apps | Planned | Push/CallKit/Android Telecom, background ringing, device state, handoff |
| Desk phones and SIP endpoints | Planned | Provisioning, credentials, device lifecycle, supported hardware certification |
| International/toll-free coverage | Partial: configurable destination prefixes | Actual purchased numbers, provider permissions, fraud controls, country-by-country testing |
| Emergency calling | Not implemented; short codes blocked | Approved E911 addressing/routing and notification workflow before primary-phone replacement |

### Routing, voicemail, and contact center

| Capability | Status here | Acceptance or remaining work |
| --- | --- | --- |
| Simultaneous ring group | Implemented, up to 10 configured identities | One winner; losing-leg failure must never end the customer call |
| Round robin / longest idle / fixed priority | Implemented | Atomic reservations under competing calls; fixed chooses first available, not sequential overflow |
| Presence / DND / away / wrap-up | Implemented | Heartbeat expiry removes disconnected agents from configured routes |
| Business hours / holidays / time zone | Implemented | DST transitions; overnight intervals must split across days |
| Unavailable and after-hours voicemail | Implemented | Recording, history, protected playback, missed versus answered classification |
| Voicemail-to-email and transcription workflows | Partial | Voice transcription depends on provider; no email delivery or mailbox management |
| Multi-level IVR / visual call-flow editor | Planned | Versioned route graph, DTMF timeout/retry, safe publish and rollback |
| Per-number/per-department routing | Planned | Current route config is global |
| ACD waiting queue / hold announcements | Planned | Durable ordered queue, agent acceptance, max wait, overflow and abandonment |
| Skills-based / priority routing | Planned | Skill inventory, eligibility, priorities, starvation protection |
| Queue callback and virtual hold | Planned | Consent, callback scheduling, cancellation, reserved capacity, retries |
| Supervisory listen / whisper / barge | Planned | Conference architecture, explicit privilege model and audit events |
| Supervisor wallboards and live service levels | Partial: basic 24-hour operations summary | Queue-based SLA, occupancy, abandoned-wait metrics and interval reporting |
| Workforce forecasting/scheduling | Planned | Workload model, adherence, shift planning and reporting |
| Quality management/calibration | Partial: local rule score and AI recap | Human review forms, calibrated scoring, disputes, sampling and access controls |
| Outbound campaigns/power dialer | Planned | Campaign state, list governance, suppression and appropriate dialing policy |

### Intelligence, messaging, meetings, and integrations

| Capability | Status here | Acceptance or remaining work |
| --- | --- | --- |
| Finalized live transcript storage | Implemented | Deduplicate provider event keys; both speaker tracks; late events and restart recovery |
| AI recap, extraction, coaching | Implemented with configured providers/local fallbacks | Test accuracy on permitted recordings, latency, cost, model/region approvals and human review |
| Recap retry/failure visibility | Implemented | No transcript, disabled provider, failed provider and successful regeneration remain distinguishable |
| Action items | Partial: extracted/presented/forwarded | WiTnext task acceptance, ownership, due dates and completed-state synchronization |
| Global transcript search / AI conversation search | Planned | Indexed search, permissions, citations and retention-aware results |
| AI playbooks, scorecards, objection guidance | Partial: existing rule cues | Configurable playbooks and quality evaluation, no Dialpad-equivalent coaching certification |
| AI virtual receptionist/voice agent | Planned | Bounded actions, human escalation, telephony integration and evaluation |
| SMS threads and replies | Implemented through Twilio Conversations | Carrier registration, outbound identity, actual end-to-end send/receive; UI reports accepted, not delivered |
| Message opt-out and duplicate-send prevention | Implemented locally | Verify provider suppression; unconfirmed sends need provider inspection |
| Message delivery receipts/read states | Planned | Correlate provider message IDs/status webhooks; reconcile unknown outcomes |
| New outbound SMS/MMS and attachments | Planned | Current workspace replies to existing assigned threads; no compose-new, media upload or group messaging |
| Shared inbox / reassignment / omnichannel queue | Planned | Messaging currently routes to default agent; no assignment controls |
| WhatsApp | Adapter-compatible, unverified | Approved sender/templates and provider setup; no readiness claim |
| Apple Messages for Business | Adapter scaffold only | Approved MSP, verified integration and identity journey |
| CSAT survey | Partial: optional post-call SMS and reply matching | One automatic attempt per call; verify opt-in policy/provider routing; timeout outcomes block resend |
| ERPNext | Partial: optional call recap/log mirror and message timeline | Separate ERP contact lookup; one automatic call-mirror attempt; no cross-CRM field authority model |
| WiTnext event delivery | Implemented | Provision identity/secret, verify actual intake merge behavior and account ownership |
| Dialpad coexistence/imported events | Implemented normalization and transcript fetch | Signed subscription setup, API permissions, multiple legs and staged recap payloads on real events |
| CRM marketplaces (Salesforce, HubSpot, Zendesk, etc.) | Planned | Dedicated adapters, field ownership, object mapping and permission scopes |
| Video meetings / screen share | Planned | No video transport or meeting service in this repository |
| Team chat / channels | Planned | No internal collaboration messaging implementation |
| Fax | Planned | Provider, number assignment, file delivery and retention |
| Analytics exports / scheduled reports | Planned | Current operations totals are diagnostic, not billing-grade analytics |

### Service and administration

| Capability | Status here | Acceptance or remaining work |
| --- | --- | --- |
| Durable background work/outbox | Implemented | PostgreSQL lease fencing, retry/backoff, dead work and late refresh regression tests |
| Provider webhook authentication | Implemented | Exact HTTPS callback origin; forged signatures rejected |
| Google SSO/MFA | Existing implementation retained | Live OAuth and Verify onboarding/offboarding test |
| Session expiry/revocation | Implemented, including WebSocket rechecks | Verify across deployed instances; revocation cache distribution needs review for scaling |
| Audit and protected recordings | Implemented foundation | Test authorization with actual recordings; retention and authorized admin exports |
| Backup/restore | Implemented tooling | Restore drill in deployment environment; agreed RPO/RTO and off-host backups |
| High availability / disaster recovery | Partial | Queue is shared; live event bus is local; shared pub/sub, replicated DB and region/provider failover required |
| Number purchase/porting/CNAM | Operational dependency | Inventory, carrier documents, staged port, fallback number and rollback plan |
| SAML/SCIM / advanced roles | Planned | Current Google allowlist and three roles do not provide enterprise provisioning |
| Multi-tenant service / billing | Planned | Tenant keys and enforced data isolation, entitlements, usage attribution, billing |
| Compliance certification / legal hold | Not established | Data contracts, recording policy, access review, audit evidence and counsel-approved retention |
| Capacity / uptime SLA | Not established | Load tests with provider quotas; monitor queues, DB latency, webhook failures, media quality and carrier incidents |

## Delivery order

1. **Controlled pilot of this release.** Deploy on a new test number; keep Dialpad
   as the operating service. Complete the voice runbook and verify every WiTnext
   field/link on actual synthetic records. Fix receiver account/source mapping
   before customer data becomes authoritative.
2. **Conference-based call control.** Introduce one server-owned customer
   conference per call and authenticated participants. Build hold, consult,
   warm transfer, add participant and supervisor controls on that common model.
   Test disconnects and provider timeouts at each transition before exposing it.
3. **Full routing and contact-center workflows.** Add DID-specific flow versions,
   IVR, durable waiting queues, skills, overflow, callback and supervisor reporting.
   State the expected maximum concurrency and prove it under load.
4. **Cross-channel service.** Add messaging delivery reconciliation, assignment,
   attachments, new conversations, mobile background calling and device handoff.
   Complete only the external integrations the agency actually uses first.
5. **Telecom cutover.** Approve emergency calling, consent, carrier messaging,
   retention and disaster recovery. Run a parallel pilot, port one low-risk
   number, validate rollback, and expand only after the service owner accepts
   call quality and end-to-end customer records.
6. **Broader suite parity.** Video, fax, workforce tools, AI receptionist and
   marketplace integrations are separate product workstreams. They are included
   in this ledger so “all Dialpad features” is not reduced to a dialer UI.

Each stage must be estimated against the agency's selected Dialpad products,
seat count, number inventory, call volume and supported devices. This repository
inspection cannot establish a credible completion date for the entire suite.

## Non-negotiable cutover acceptance

- No lost accepted webhook in a database outage/restart drill; duplicates do not
  duplicate customer records, messages or finalized transcript segments.
- Call lifecycle remains correct for no answer, busy, simultaneous losers,
  voicemail, abandon, transfer, late callbacks and missing AI.
- Every transferred lead is matched with evidence or explicitly left unresolved;
  vendor caller ID is never stored as the customer's identity.
- Actual WiTnext screens show caller/customer, agent, timestamps, completed
  recap, readable actions and navigable source links for a representative set.
- Real browser/PSTN calls pass audio, DTMF, disconnect, token renewal, recording,
  role/access and fallback tests in the intended networks and browsers.
- Emergency routing, ownership of phone numbers, consent policy, A2P messaging,
  support escalation, monitoring, backups and rollback are approved operationally.
- Every feature used in the existing Dialpad workflow is either accepted in the
  replacement or explicitly retained through a supported coexistence arrangement.

## Reference baseline

Product families and feature breadth were checked against [Dialpad's feature
catalog](https://www.dialpad.com/all-features/) and its [feature comparison](https://help.dialpad.com/hc/en-us/articles/54823174886939-Dialpad-Feature-Comparison).
The [call-events contract](https://developers.dialpad.com/docs/call-events) and
[transcript endpoint](https://developers.dialpad.com/reference/transcriptsget)
guide the coexistence adapter. Twilio's [Voice SDK Device API](https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice),
[Dial verb](https://www.twilio.com/docs/voice/twiml/dial), and
[Transcription verb](https://www.twilio.com/docs/voice/twiml/transcription)
guide browser and webhook behavior. This ledger describes our implementation
and acceptance requirements; it is not a reproduction of a vendor entitlement matrix.
