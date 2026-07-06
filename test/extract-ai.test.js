// AI extraction merge + backend routing (no network).
process.env.LLM_BACKEND = "groq";
process.env.LLM_RECAP_BACKEND = "groq";
process.env.LLM_COACHING_BACKEND = "rules";
process.env.LLM_AUTOMATION_BACKEND = "groq";
process.env.GROQ_API_KEY = "k";

import { test } from "node:test";
import assert from "node:assert/strict";

const { mergeAiExtraction } = await import("../src/ai/extract-ai.js");
const { backendForSchema } = await import("../src/ai/client.js");

test("backendForSchema routes each task to its configured backend", () => {
  assert.equal(backendForSchema("call_recap"), "groq");
  assert.equal(backendForSchema("lead_extraction"), "groq");
  assert.equal(backendForSchema("coaching_cues"), "rules"); // local-first
  assert.equal(backendForSchema("automation_email_draft"), "groq");
});

test("mergeAiExtraction auto-applies high confidence, proposes the rest", () => {
  const ai = {
    policy_type: "Auto",
    carrier: "Progressive",
    premium: 214.0,
    confidence: { policy_type: 0.94, carrier: 0.81, premium: 0.5 },
  };
  const { applied, proposed } = mergeAiExtraction(ai, { threshold: 0.85 });
  assert.equal(applied.policy_type, "Auto"); // 0.94 ≥ 0.85 → applied
  assert.equal(applied.carrier, undefined); // 0.81 < 0.85 → proposed
  assert.equal(applied.premium, undefined); // 0.5 → proposed
  const fields = proposed.map((p) => p.field).sort();
  assert.deepEqual(fields, ["carrier", "premium"]);
});

test("mergeAiExtraction coerces premium to a number and skips empties", () => {
  const { applied } = mergeAiExtraction(
    { premium: "$1,450/yr", confidence: { premium: 0.99 }, carrier: "", policy_type: "" },
    { threshold: 0.5 }
  );
  assert.equal(applied.premium, 1450);
  assert.equal("carrier" in applied, false); // empty string skipped
  assert.equal("policy_type" in applied, false);
});

test("mergeAiExtraction surfaces next_action and customer_need", () => {
  const { nextAction, customerNeed } = mergeAiExtraction({
    next_action: "Send quote and follow up tomorrow",
    customer_need: "Cheaper auto",
  });
  assert.equal(nextAction, "Send quote and follow up tomorrow");
  assert.equal(customerNeed, "Cheaper auto");
});

test("mergeAiExtraction tolerates null / empty input", () => {
  const r = mergeAiExtraction(null);
  assert.deepEqual(r.applied, {});
  assert.deepEqual(r.proposed, []);
});
