// Groq provider: success, bad JSON, timeout, and no-key fallback — all against
// a local mock of Groq's OpenAI-compatible endpoint (no network).
import http from "node:http";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// ── Stand up a mock Groq server and point config at it BEFORE importing. ──
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let model = "";
    try {
      model = JSON.parse(body).model;
    } catch {
      /* ignore */
    }
    const send = (obj, raw) =>
      res.end(JSON.stringify({ choices: [{ message: { content: raw ?? JSON.stringify(obj) } }] }));

    if (model === "bad-json") return send(null, "<<< not json at all >>>");
    if (model === "slow") {
      setTimeout(() => send(validRecap()), 300);
      return;
    }
    if (model === "ok-extract") return send(validExtract());
    return send(validRecap()); // ok-recap / default
  });
});

let baseUrl;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

process.env.GROQ_API_KEY = "test-key";
process.env.GROQ_BASE_URL = "http://127.0.0.1:1"; // overwritten below once we know the port
process.env.GROQ_TIMEOUT_MS = "5000";

const { config } = await import("../src/config.js");
const { groqStructuredCompletion } = await import("../src/ai/providers/groq.js");

// Point the (already-imported) config at the live mock port.
function useMock() {
  config.llm.groq.baseUrl = baseUrl;
  config.llm.groq.apiKey = "test-key";
  config.llm.groq.timeoutMs = 5000;
}

function recapArgs() {
  return { system: "sys", user: "transcript", schemaName: "call_recap" };
}

test("success: valid JSON is parsed and returned", async () => {
  useMock();
  config.llm.groq.recapModel = "ok-recap";
  const out = await groqStructuredCompletion(recapArgs());
  assert.equal(out.summary, "A real recap.");
  assert.equal(out.outcome, "follow_up");
  assert.deepEqual(out.productsDiscussed, ["Auto"]);
});

test("success: lead_extraction returns the confidence-scored shape", async () => {
  useMock();
  config.llm.groq.recapModel = "ok-extract"; // lead_extraction uses the recap model
  const out = await groqStructuredCompletion({ system: "s", user: "t", schemaName: "lead_extraction" });
  assert.equal(out.policy_type, "Auto");
  assert.equal(out.carrier, "Progressive");
  assert.equal(out.premium, 214);
  assert.equal(out.confidence.policy_type, 0.94);
});

test("bad JSON: recap falls back to the deterministic rules engine (never null)", async () => {
  useMock();
  config.llm.groq.recapModel = "bad-json";
  const out = await groqStructuredCompletion(recapArgs());
  assert.ok(out && typeof out.summary === "string"); // rules recap shape
  assert.ok(Array.isArray(out.nextSteps));
});

test("bad JSON: lead_extraction has no rules equivalent → null", async () => {
  useMock();
  config.llm.groq.recapModel = "bad-json";
  const out = await groqStructuredCompletion({ system: "s", user: "t", schemaName: "lead_extraction" });
  assert.equal(out, null);
});

test("timeout: aborts and falls back to rules", async () => {
  useMock();
  config.llm.groq.recapModel = "slow";
  config.llm.groq.timeoutMs = 80; // shorter than the mock's 300ms delay
  const out = await groqStructuredCompletion(recapArgs());
  assert.ok(out && typeof out.summary === "string"); // rules fallback, not a hang
});

test("no API key: falls back immediately without calling the network", async () => {
  useMock();
  config.llm.groq.apiKey = null;
  const out = await groqStructuredCompletion(recapArgs());
  assert.ok(out && typeof out.summary === "string"); // rules recap
  const ext = await groqStructuredCompletion({ system: "s", user: "t", schemaName: "lead_extraction" });
  assert.equal(ext, null); // extraction has no rules fallback
});

// ── fixtures ──
function validRecap() {
  return {
    summary: "A real recap.",
    outcome: "follow_up",
    productsDiscussed: ["Auto"],
    objections: [],
    nextSteps: ["Send a quote"],
    followUpDate: "",
    customerSentiment: "positive",
  };
}
function validExtract() {
  return {
    summary: "Customer wants auto coverage.",
    customer_need: "Cheaper auto policy",
    policy_type: "Auto",
    carrier: "Progressive",
    premium: 214.0,
    address: "123 Main St",
    drivers: ["Jordan Ellison"],
    vehicles: [{ year: 2021, make: "Toyota", model: "Camry" }],
    objections: ["Price"],
    next_action: "Send quote and follow up tomorrow",
    confidence: { policy_type: 0.94, carrier: 0.81, premium: 0.77 },
  };
}
