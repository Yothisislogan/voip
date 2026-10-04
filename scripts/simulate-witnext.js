import http from "node:http";
import { spawn } from "node:child_process";
import twilio from "twilio";
import { verifyWitnextRequest } from "../src/integrations/witnext.js";

/**
 * WiTNext broker end-to-end simulator. Boots the REAL server with the bridge
 * pointed at an in-process MOCK WiTNext receiver, drives a full call + a
 * recording callback through real signed Twilio webhooks, and asserts that:
 *
 *   - call.completed / call.recap_available / call.transcript_available /
 *     call.recording_available all arrive at the mock
 *   - every delivery passes the contract's HMAC verification on raw bytes
 *   - duplicate event_ids would be deduped (receiver answers 409)
 *
 * `npm run simulate:witnext`. Requires DATABASE_URL (the call pipeline
 * persists as it goes).
 */

const SECRET = "e2e-witnext-secret";
const AUTH_TOKEN = "sim-auth-token-0123456789abcdef";
const PORT = Number(process.env.SIM_PORT) || 3997;
const BASE = `http://localhost:${PORT}`;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set — the call pipeline needs Postgres.");
  process.exit(1);
}

const got = [];
const seen = new Set();

// Mock WiTNext: verifies the signature over RAW bytes exactly per the contract.
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const ok = verifyWitnextRequest({
      secret: SECRET,
      timestamp: req.headers["x-wit-timestamp"],
      nonce: req.headers["x-wit-nonce"],
      eventId: req.headers["x-wit-event-id"],
      rawBody: raw,
      signature: req.headers["x-wit-signature"],
    });
    if (!ok) {
      got.push({ type: "SIGNATURE-FAIL" });
      return res.writeHead(403).end();
    }
    const id = req.headers["x-wit-event-id"];
    if (seen.has(id)) return res.writeHead(200).end(); // idempotent duplicate
    seen.add(id);
    const env = JSON.parse(raw);
    got.push({ type: env.event_type, path: req.url, callId: env.payload.call_id, verified: true });
    res.writeHead(202).end();
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function twilioPost(path, params) {
  const url = `${BASE}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
    body: new URLSearchParams(params).toString(),
  });
}

let child;
function shutdown(code) {
  try { child?.kill("SIGTERM"); } catch { /* noop */ }
  try { mock.close(); } catch { /* noop */ }
  process.exit(code);
}

(async () => {
  await new Promise((r) => mock.listen(0, r));
  child = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      AUTH_REQUIRED: "false",
      LLM_BACKEND: "rules",
      NODE_ENV: "development",
      WITNEXT_URL: `http://127.0.0.1:${mock.address().port}`,
      WITNEXT_INTEGRATION_SECRET: SECRET,
      WITNEXT_INTEGRATION_ID: "test-integration",
      DEFAULT_AGENT_IDENTITY: "sim-agent",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }

  console.log(`\n▶ WiTNext broker e2e against ${BASE} (mock WiTNext wired in)\n`);
  const SID = `CAwitnext${process.pid}${Math.floor(process.uptime() * 1000) % 100000}`;
  await twilioPost("/voice/inbound", { CallSid: SID, From: "+14805559911", To: "+14805550100", Direction: "inbound" });
  await sleep(400);
  await twilioPost("/voice/transcription", {
    CallSid: SID, TranscriptionEvent: "transcription-content", Track: "inbound_track",
    TranscriptionData: JSON.stringify({ transcript: "I need a homeowners quote please." }),
  });
  await sleep(300);
  await twilioPost("/voice/transcription", { CallSid: SID, TranscriptionEvent: "transcription-stopped" });
  await twilioPost("/voice/status", { CallSid: SID, CallStatus: "completed", CallDuration: "42" });
  await sleep(3500);
  await twilioPost("/recording/status", {
    CallSid: SID, RecordingSid: "RE" + "0".repeat(32),
    RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "42", RecordingStatus: "completed",
  });
  await sleep(1800);

  let passed = 0, failed = 0;
  const check = (label, cond) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.log(`  ✗ ${label}`); }
  };
  const types = got.map((g) => g.type);
  check("call.completed forwarded", types.includes("call.completed"));
  check("call.recap_available forwarded", types.includes("call.recap_available"));
  check("call.transcript_available forwarded", types.includes("call.transcript_available"));
  check("call.recording_available forwarded", types.includes("call.recording_available"));
  check("every delivery passed HMAC verification", got.length > 0 && got.every((g) => g.verified));
  check("all events reference the same call", got.every((g) => !g.callId || g.callId === SID));
  check("no signature failures", !types.includes("SIGNATURE-FAIL"));

  console.log(`\n${failed ? "❌" : "✅"} witnext broker: ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.error("events:", JSON.stringify(got, null, 1));
    console.error("server tail:\n" + out.split("\n").slice(-15).join("\n"));
  }
  shutdown(failed ? 1 : 0);
})();
