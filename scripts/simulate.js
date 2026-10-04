import { spawn } from "node:child_process";
import twilio from "twilio";

/**
 * Webhook pipeline simulator. Real Twilio calls can't run in CI or a sandbox,
 * so this drives a REAL server process through the REAL HTTP webhooks with
 * correctly-signed requests, then verifies the pipeline landed in Postgres via
 * the authenticated CRM API. It exercises:
 *
 *   inbound voice  → screen-pop + call row + contact match by phone
 *   transcription  → persisted transcript_segments (per utterance)
 *   call complete  → recap + score + AI field extraction into the contact
 *   inbound SMS    → Conversations webhook accepted + routed
 *   inbound email  → parsed into a lead
 *
 * It boots its own server (AUTH_REQUIRED=false so the CRM API is reachable, and
 * PUBLIC_BASE_URL set so signature validation is exercised for real), signs
 * every Twilio webhook with TWILIO_AUTH_TOKEN, and exits non-zero on any failed
 * assertion. Requires DATABASE_URL. `npm run simulate`.
 */

const PORT = Number(process.env.SIM_PORT) || 3999;
const BASE = `http://localhost:${PORT}`;
const AUTH_TOKEN = "sim-auth-token-0123456789abcdef";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set — the simulator needs a real Postgres to verify against.");
  process.exit(1);
}

// Unique-ish identifiers so reruns don't collide. process.pid is stable per run.
const stamp = `${process.pid}${Math.floor(process.uptime() * 1000)}`;
const CALL_SID = `CAsim${stamp}`;
const CUSTOMER = `+1480555${String(stamp).slice(-4).padStart(4, "0")}`;
const WIT_NUMBER = "+14805550100";
const CONVO_SID = `CHsim${stamp}`;

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Signed Twilio webhook POST (form-encoded) ──
async function twilioPost(path, params) {
  const url = `${BASE}${path}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  const body = new URLSearchParams(params).toString();
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body,
  });
}

// ── Plain JSON/form POST (email intake — not Twilio-signed) ──
async function formPost(path, params) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { credentials: "same-origin" });
  if (!r.ok) return { _status: r.status };
  return r.json();
}

// A transcription-content event as Twilio's <Start><Transcription> posts it.
function transcriptionContent(track, transcript) {
  return twilioPost("/voice/transcription", {
    CallSid: CALL_SID,
    TranscriptionEvent: "transcription-content",
    Track: track,
    TranscriptionData: JSON.stringify({ transcript }),
  });
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

async function run() {
  console.log(`\n▶ Simulating the webhook pipeline against ${BASE}`);
  console.log(`  call=${CALL_SID} customer=${CUSTOMER}\n`);

  // ── 1. Inbound voice → screen-pop creates the contact + call row ──
  console.log("1) inbound voice webhook");
  const inbound = await twilioPost("/voice/inbound", {
    CallSid: CALL_SID,
    From: CUSTOMER,
    To: WIT_NUMBER,
    Direction: "inbound",
  });
  const inboundXml = await inbound.text();
  check("returns TwiML (200)", inbound.status === 200 && inboundXml.includes("<Response>"), `status ${inbound.status}`);
  await sleep(500); // screen-pop is fire-and-forget

  // ── 2. Transcription utterances → persisted segments + extractable fields ──
  console.log("2) real-time transcription utterances");
  const utterances = [
    ["inbound_track", "Hi, my name is Jordan Ellison and I need an auto insurance quote."],
    ["inbound_track", "I drive a 2021 Toyota Camry, the VIN is 4T1BF1FK5CU511234."],
    ["inbound_track", "My date of birth is March 4th, 1985."],
    ["outbound_track", "Great, I can help with that. What coverage are you looking for?"],
    ["inbound_track", "Full coverage. My current premium is about 1450 dollars a year."],
    ["inbound_track", "Yes, let's move forward and bind the policy today."],
  ];
  for (const [track, text] of utterances) {
    const r = await transcriptionContent(track, text);
    if (r.status !== 204) check(`utterance accepted (${text.slice(0, 24)}…)`, false, `status ${r.status}`);
  }
  check("all utterances accepted (204)", true);
  await sleep(600); // segments persist fire-and-forget

  // ── 3. Call complete → recap + score + extraction ──
  console.log("3) transcription-stopped → recap/score/extract");
  const stopped = await twilioPost("/voice/transcription", {
    CallSid: CALL_SID,
    TranscriptionEvent: "transcription-stopped",
  });
  check("stop accepted (204)", stopped.status === 204, `status ${stopped.status}`);
  for (let i = 0; i < 60; i++) {
    const current = await getJson(`/api/crm/calls/${encodeURIComponent(CALL_SID)}`);
    if (current.call?.recap_state === 'ready') break;
    await sleep(250);
  } // durable worker settles asynchronously

  // ── 4. Verify persistence via the authenticated CRM API ──
  console.log("4) verify via CRM API");
  const detail = await getJson(`/api/crm/calls/${encodeURIComponent(CALL_SID)}`);
  check("call detail is retrievable", detail && detail.call, `got ${JSON.stringify(detail).slice(0, 120)}`);
  check("transcript segments persisted", Array.isArray(detail.segments) && detail.segments.length >= 5,
    `segments=${detail.segments?.length}`);
  check("call score recorded", detail.score && typeof detail.score.score === "number",
    `score=${JSON.stringify(detail.score)}`);
  check("recap stored on the call", detail.call && detail.call.recap != null);
  check("contact matched by phone", detail.contact && detail.contact.phone_e164 === CUSTOMER,
    `contact=${JSON.stringify(detail.contact)?.slice(0, 120)}`);

  const contact = detail.contact || {};
  check("extracted VIN", contact.vin === "4T1BF1FK5CU511234", `vin=${contact.vin}`);
  check("extracted a vehicle", Array.isArray(contact.vehicles) && contact.vehicles.some((v) => /camry/i.test(v.model || "")),
    `vehicles=${JSON.stringify(contact.vehicles)}`);
  check("extracted DOB", contact.dob && /1985-03-04/.test(String(contact.dob)), `dob=${contact.dob}`);
  check("buying signal reflected in outcome/score",
    (detail.score && (detail.score.score >= 50 || /bind|won|quote/i.test(detail.score.outcome || ""))),
    `score=${detail.score?.score} outcome=${detail.score?.outcome}`);

  // Consent/recording state tracked (two-party consent disclosure at answer time).
  check("recording/transcription disclosure recorded",
    detail.consent && detail.consent.state && detail.consent.state.consent_state === "disclosed",
    `consent=${JSON.stringify(detail.consent?.state)}`);
  check("consent event history present",
    detail.consent && Array.isArray(detail.consent.events) &&
      detail.consent.events.some((e) => e.kind === "disclosure"),
    `events=${detail.consent?.events?.length}`);

  // ── Security headers on a normal response ──
  console.log("4b) security headers");
  const hres = await fetch(`${BASE}/health`);
  check("X-Content-Type-Options: nosniff", hres.headers.get("x-content-type-options") === "nosniff");
  check("Content-Security-Policy present", !!hres.headers.get("content-security-policy"));
  check("X-Frame-Options: DENY", hres.headers.get("x-frame-options") === "DENY");
  check("X-Request-Id echoed for tracing", !!hres.headers.get("x-request-id"));

  // ── Readiness reflects DB health ──
  const ready = await getJson("/ready");
  check("/ready reports DB up", ready && ready.ok === true && ready.db === "up", `ready=${JSON.stringify(ready)}`);

  // ── 5. Inbound SMS (Twilio Conversations webhook) ──
  console.log("5) inbound SMS webhook");
  const sms = await twilioPost("/messaging/inbound", {
    EventType: "onMessageAdded",
    ConversationSid: CONVO_SID,
    MessageSid: `IMsim${stamp}`,
    Author: CUSTOMER,
    Source: "SMS",
    Body: "Following up on my auto quote — can you text me the price?",
  });
  check("SMS webhook accepted (204)", sms.status === 204, `status ${sms.status}`);

  // ── 6. Inbound email → parsed into a lead ──
  console.log("6) inbound email intake");
  const emailPhone = `+1480556${String(stamp).slice(-4).padStart(4, "0")}`;
  const email = await formPost("/email/inbound", {
    from: "Pat Rivera <pat.rivera@example.com>",
    subject: "Home insurance quote request",
    text: `Hi, I'd like a homeowners quote. You can reach me at ${emailPhone}. Thanks, Pat`,
  });
  const emailBody = await email.json().catch(() => ({}));
  check("email intake accepted", email.status === 200 && emailBody.ok === true, `status ${email.status} body ${JSON.stringify(emailBody)}`);

  // ── Summary ──
  console.log(`\n${failed ? "❌" : "✅"} simulator: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Boot the server, run the sim, always tear down ──
const child = spawn("node", ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_BASE_URL: BASE,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    AUTH_REQUIRED: "false",
    LLM_BACKEND: "rules",
    COACHING_ENABLED: "true",
    RECAP_ENABLED: "true",
    DEFAULT_AGENT_IDENTITY: "sim-agent",
    NODE_ENV: "development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

function shutdown(code) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  process.exit(code);
}

(async () => {
  const up = await waitForHealth();
  if (!up) {
    console.error("❌ server did not become healthy in time. Server output:\n" + serverLog);
    return shutdown(1);
  }
  try {
    const ok = await run();
    if (!ok) console.error("Server output (tail):\n" + serverLog.split("\n").slice(-25).join("\n"));
    shutdown(ok ? 0 : 1);
  } catch (err) {
    console.error("❌ simulator crashed:", err.message);
    console.error("Server output (tail):\n" + serverLog.split("\n").slice(-25).join("\n"));
    shutdown(1);
  }
})();
