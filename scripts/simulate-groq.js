import { spawn } from "node:child_process";
import http from "node:http";
import twilio from "twilio";

/**
 * Groq end-to-end simulator. Boots the REAL server with the recap/extraction
 * backend set to Groq, pointed at an in-process MOCK of Groq's OpenAI-compatible
 * API. Drives real signed webhooks through a full call and verifies, per Groq
 * behavior, that the pipeline does the right thing:
 *
 *   success  → the persisted recap is Groq's, and high-confidence AI extraction
 *              lands on the contact
 *   bad JSON → recap falls back to the deterministic rules engine (still valid);
 *              extraction (no rules equivalent) is skipped
 *   timeout  → same safe fallback, no hang
 *
 * The mock's mode is a variable in THIS process; we flip it between calls, so a
 * single server boot exercises all three. `npm run simulate:groq`.
 */

const APP_PORT = Number(process.env.SIM_PORT) || 3998;
const BASE = `http://localhost:${APP_PORT}`;
const AUTH_TOKEN = "sim-groq-auth-token-0123456789ab";
const DATABASE_URL = process.env.DATABASE_URL;
const GROQ_SUMMARY = "Groq 70B recap: customer wants an auto quote and will decide tomorrow.";

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set — this simulator verifies persisted results.");
  process.exit(1);
}

let mockMode = "success"; // success | badjson | slow
let groqHits = 0;

// ── Mock Groq (OpenAI-compatible /chat/completions) ──
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    groqHits++;
    const isExtract = /policy_type|customer_need/.test(body);
    const reply = (content) =>
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));

    if (mockMode === "badjson") return reply("<<< not json >>>");
    if (mockMode === "slow") {
      setTimeout(() => reply(JSON.stringify(isExtract ? extractFixture() : recapFixture())), 1500);
      return;
    }
    reply(JSON.stringify(isExtract ? extractFixture() : recapFixture()));
  });
});

const stamp = `${process.pid}${Math.floor(process.uptime() * 1000)}`;
let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function twilioPost(path, params) {
  const url = `${BASE}${path}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params).toString(),
  });
}
async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { credentials: "same-origin" });
  return r.ok ? r.json() : { _status: r.status };
}

// Drive a whole call and return its persisted detail.
async function driveCall(idx) {
  const callSid = `CAgroq${stamp}${idx}`;
  const customer = `+1480570${String(1000 + idx).slice(-4)}`; // always 10 digits
  await twilioPost("/voice/inbound", { CallSid: callSid, From: customer, To: "+14805550100", Direction: "inbound" });
  await sleep(400);
  const lines = [
    ["inbound_track", "Hi, I'm looking for an auto insurance quote."],
    ["inbound_track", "I'm currently with Progressive paying about 214 dollars."],
    ["outbound_track", "Got it, I can help you compare that today."],
    ["inbound_track", "Let's follow up tomorrow after I check with my spouse."],
  ];
  for (const [track, text] of lines) {
    await twilioPost("/voice/transcription", {
      CallSid: callSid, TranscriptionEvent: "transcription-content", Track: track,
      TranscriptionData: JSON.stringify({ transcript: text }),
    });
  }
  await sleep(400);
  await twilioPost("/voice/transcription", { CallSid: callSid, TranscriptionEvent: "transcription-stopped" });
  await sleep(2500); // recap + extraction pipeline (groq mock)
  return getJson(`/api/crm/calls/${encodeURIComponent(callSid)}`);
}

async function run() {
  console.log(`\n▶ Groq end-to-end against ${BASE} (mock Groq wired in)\n`);

  console.log("1) Groq success → recap + AI extraction applied");
  mockMode = "success";
  let d = await driveCall(1);
  check("call persisted", d && d.call, `got ${JSON.stringify(d).slice(0, 100)}`);
  check("recap summary came from Groq", d.call?.recap?.summary === GROQ_SUMMARY, `summary=${d.call?.recap?.summary}`);
  check("high-confidence AI field applied (policy_type=Auto)", d.contact?.policy_type === "Auto", `policy_type=${d.contact?.policy_type}`);
  check("high-confidence AI field applied (carrier=Progressive)", d.contact?.carrier === "Progressive", `carrier=${d.contact?.carrier}`);
  check("Groq was actually called", groqHits > 0, `hits=${groqHits}`);

  console.log("2) Groq bad JSON → deterministic rules fallback (never null)");
  mockMode = "badjson";
  d = await driveCall(2);
  check("recap still produced (rules fallback)", Boolean(d.call?.recap?.summary), `recap=${JSON.stringify(d.call?.recap)?.slice(0,80)}`);
  check("fallback recap is NOT the Groq one", d.call?.recap?.summary !== GROQ_SUMMARY);
  // AI extraction returns null on bad JSON, but DETERMINISTIC extraction still
  // runs — so carrier/premium (spoken in the transcript) are present from rules,
  // proving the pipeline degraded gracefully rather than losing the data.
  check("deterministic extraction still populated the contact", d.contact?.carrier === "Progressive" && Number(d.contact?.premium) === 214,
    `carrier=${d.contact?.carrier} premium=${d.contact?.premium}`);
  check("call still scored despite bad recap JSON", d.score && typeof d.score.score === "number", `score=${JSON.stringify(d.score)}`);

  console.log("3) Groq timeout → safe fallback, no hang");
  mockMode = "slow";
  d = await driveCall(3);
  check("recap produced despite timeout", Boolean(d.call?.recap?.summary));
  check("timed-out recap is the fallback, not Groq", d.call?.recap?.summary !== GROQ_SUMMARY);

  console.log(`\n${failed ? "❌" : "✅"} groq simulator: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── boot app child pointed at the mock, run, tear down ──
let child;
function shutdown(code) {
  try { child?.kill("SIGTERM"); } catch { /* noop */ }
  try { mock.close(); } catch { /* noop */ }
  process.exit(code);
}

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const groqUrl = `http://127.0.0.1:${mock.address().port}`;
  child = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      PUBLIC_BASE_URL: BASE,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      AUTH_REQUIRED: "false",
      LLM_BACKEND: "rules",
      LLM_RECAP_BACKEND: "groq",
      LLM_COACHING_BACKEND: "rules",
      GROQ_API_KEY: "mock-key",
      GROQ_BASE_URL: groqUrl,
      GROQ_RECAP_MODEL: "e2e-70b",
      GROQ_TIMEOUT_MS: "600",
      RECAP_ENABLED: "true",
      COACHING_ENABLED: "true",
      DEFAULT_AGENT_IDENTITY: "sim-agent",
      NODE_ENV: "development",
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
  try {
    const ok = await run();
    if (!ok) console.error("Server output (tail):\n" + out.split("\n").slice(-20).join("\n"));
    shutdown(ok ? 0 : 1);
  } catch (err) {
    console.error("❌ groq simulator crashed:", err.message);
    console.error(out.split("\n").slice(-20).join("\n"));
    shutdown(1);
  }
})();

function recapFixture() {
  return {
    summary: GROQ_SUMMARY,
    outcome: "follow_up",
    productsDiscussed: ["Auto"],
    objections: [],
    nextSteps: ["Follow up tomorrow"],
    followUpDate: "",
    customerSentiment: "positive",
  };
}
function extractFixture() {
  return {
    summary: "Auto shopper currently with Progressive.",
    customer_need: "Cheaper auto policy",
    policy_type: "Auto",
    carrier: "Progressive",
    premium: 214.0,
    address: "",
    drivers: [],
    vehicles: [],
    objections: [],
    next_action: "Send quote and follow up tomorrow",
    confidence: { policy_type: 0.94, carrier: 0.9, premium: 0.6 },
  };
}
