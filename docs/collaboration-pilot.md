# WiT Connect collaboration and customer experience pilot

Implemented on the existing Telnyx/AssemblyAI pilot branch. These additions are
opt-in and have not been deployed or verified with real customer calls. Keep the
working provider configuration. This release does not require paid CI runs.

## Enable later

1. Back up PostgreSQL, pull this branch and run `npm ci` then `npm run migrate`.
   Migration `0012_collaboration_routing_experience.sql` is additive. Run migrations
   before starting this code, even when feature flags remain off.
2. Use one long-running Node process/replica, HTTPS, a correct `PUBLIC_BASE_URL`,
   the existing login configuration and PostgreSQL. Proxy WebSocket upgrades for
   `/ws/collaboration` and `/ws/share` as well as the existing voice sockets.
   Rooms are in memory: restarts terminate them, and multiple replicas are not
   supported until a shared signaling/reservation service is introduced.
3. For browser communication, configure a TURN relay supporting coturn REST/HMAC
   credentials: `RTC_TURN_URLS`, `RTC_TURN_SECRET` (at least 32 random characters),
   optionally `RTC_STUN_URLS`. Set coturn `use-auth-secret` and matching
   `static-auth-secret`. Open the relay's configured listening and media ports,
   with valid TLS for `turns:`. A Node HTTP proxy alone is not a TURN relay.
   Never put the shared secret in client JavaScript. Credentials expire after
   65 minutes; internal calls have a 60-minute cap.
4. Enable independently: `COLLABORATION_ENABLED=true`, `TAG_ROUTING_ENABLED=true`,
   `CALL_EXPERIENCE_ENABLED=true`. Flags default to false. Restart after changes.
   To roll back behavior, turn the flags off and restart; keep the additive schema.
5. Experience scoring uses `LLM_RECAP_BACKEND` and its existing model credentials.
   Ollama, Groq, Anthropic and Bedrock use the same bounded output schema. The
   rules backend cannot infer customer experience and returns an unavailable
   assessment. This feature makes an additional LLM request per scored transcript;
   it never blocks call completion. No paid service was exercised during development.

TURN bandwidth and any hosted LLM usage are separate operating costs. Internal
calls use browser WebRTC and do not dial Telnyx PSTN numbers. Screen sharing
sends video only; the existing phone call carries the conversation audio.
Without TURN, some same-network tests may work but cross-network calls can fail.
Set `RTC_RELAY_ONLY=true` to require relay transport and avoid exposing peer IP
addresses to other participants; this increases relay bandwidth usage.

## Screen / tab sharing

In Phone, choose **Choose screen or tab**. The browser's own chooser lets the
agent select a tab, window or screen. The private viewing link lasts at most
30 minutes and admits one viewer. The customer opens it in a current browser,
enters a name, and waits. Confirm the name with the customer on your phone call,
then approve them. The name is self-reported, not verified identity. Until approval
no screen media is sent to the visitor. Declining lets another visitor request
access; admission consumes the link. Copy a new link after stopping to reconnect.

The viewer page needs no account, installation, microphone or camera permission.
It offers no remote control. Stop sharing in WiT Connect or the browser's own
sharing indicator. Disconnects, expiry, restart or closing the host tab invalidate
access. The token is in the URL fragment, is removed from the viewer address bar,
and is stored server-side only as a hash. Do not publish this bearer link.
Screen content is not recorded or stored by WiT Connect. Browser capture support
varies; use a current desktop browser to host and test each viewer browser needed.

## Team communication

Select a teammate in **Team communication** to send durable one-to-one messages,
see unread counts, load older messages or place a browser audio call. Both users
must have the workspace open to receive internal calls. Messages can be sent to
an offline teammate. Only participants can read a conversation through these APIs;
admin role does not provide a team-chat inbox. This is not end-to-end encrypted
messaging: messages are stored in the application's PostgreSQL database.

Internal calls ring for 30 seconds, support answer/decline, mute and hangup, and
expire after 60 minutes. Both participants count as busy while ringing/connected.
Fresh DND/away/wrap-up/busy status and provider call/reservation checks prevent
internal ringing over a customer call. The caller may initiate an internal call
while its phone UI is disabled; a Telnyx registration is not needed for WebRTC.
Only one active collaboration tab per user is supported: opening another ends
previous screen shares/internal calls. Reload to reconnect a displaced tab.
There are no group chats, conferencing, voice recording or internal call history
in this first version. Loss of signaling ends the media session rather than
silently continuing a screen share.

## Preferred-agent tags

Admins open **Tag routing** from Phone. Create a tag rule, choose a preferred
agent, set priority (smaller number wins) and first ring duration (5–45 seconds).
Rules may be edited or disabled; concurrent edits return a conflict rather than
overwriting another admin's changes. Changing a tag name means creating a new
rule and disabling the old one.

Load the caller's actual phone number and add/remove multiple routing tags.
Tags are case-insensitive and normalized, with up to 20 per caller. A shared
lead-transfer number is rejected. These are **caller routing tags**: existing
call-history tags and follow-up ownership do not silently change future ringing.
When the upstream caller number is shared or unknown, normal routing applies.
Late identity matching cannot change the route of an already-ringing call.

At arrival, business hours apply first. Of the matching enabled rules whose
preferred users are available, the lowest priority wins (ties use tag name).
That user rings first. On no answer, the normal configured team rings, excluding
that first user, then voicemail. Busy/offline users are skipped. This is one
preferred attempt plus one normal team attempt, not an arbitrary multi-stage
queue. `VOICE_ROUTING_JSON` defines the normal team/strategy/hours; without it,
`DEFAULT_AGENT_IDENTITY` is the fallback. Fresh registered-phone presence is
required while tag routing or collaboration is enabled. Confirm every recipient
has a Telnyx SIP/credential mapping before enabling.

## Customer experience estimates

The call detail shows **predicted satisfaction (1–5)**, **predicted likelihood
to recommend (0–10)**, confidence, reasons and exact customer transcript evidence.
There must be customer conversation and verifiable customer quotations to score.
Either score can independently be unknown. Voicemails and insufficient/invalid
model results remain unscored. Partial/abridged transcripts cap confidence at low.
The current rubric is `wit-customer-experience-v1` in
`src/services/call-experience.js`; we can refine it with reviewed sample calls.

After a completed call, a durable job assesses it using stored transcripts.
Late transcripts trigger recomputation; unchanged transcripts are deduplicated.
**Assess / retry** requests a fresh assessment. Existing call access rules apply.
Admins see a 30-day call-based overview: average estimated CSAT and projected NPS
= 100 × (predicted promoters − predicted detractors) / scored recommendation calls.
Promoters are 9–10, passives 7–8 and detractors 0–6. Missing scores are excluded
from the denominator and counts are shown. Repeat customers count once per call.

These are model predictions, not customer survey answers or observed NPS. Existing
SMS survey responses remain separate. Review estimates before using them in agent
performance decisions; a transcript cannot reliably reveal every customer's intent.

## Storage and verification

`RETENTION_MESSAGE_DAYS` also expires office messages. Transcript retention also
expires assessment reasons/evidence, which may contain customer information.
Caller routing tags persist until edited/cleared. The existing retention script
must be scheduled by the operator; setting an environment value alone does not
run it. Sessions/screens have no durable media storage.

Local checks: `npm run lint`, `npm test`. Database regression suite, against an
isolated PostgreSQL database only:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
VOIP_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/voice-service.integration.test.js test/telnyx.integration.test.js test/collaboration.integration.test.js
```

Before enabling for staff, test later with two agents and a guest browser:

- Same-network then separate-network share; approve/decline; tab chooser; stop
  from browser and app; expired/used link; unauthorized third viewer.
- Internal answer/decline/mute; blocked microphone; busy/DND; simultaneous PSTN
  arrival; network loss; logout/revoked session; one user in two tabs.
- Multiple routing tags and priority; preferred user offline/busy/no-answer;
  fallback answer/no-answer; duplicate webhooks; holidays/closed hours.
- Positive, negative, ambiguous, partial, empty and voicemail transcripts; model
  failure; late text; score access; confirm predictions never become survey data.

No real Telnyx calls, AssemblyAI streams or paid LLM completions were used for this
feature work. Provider events and model output in automated tests are synthetic.
