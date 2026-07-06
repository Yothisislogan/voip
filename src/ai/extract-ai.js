import { structuredCompletion, backendForSchema } from "./client.js";
import { config } from "../config.js";

/**
 * LLM-assisted CRM extraction. Routed to the recap backend (Groq 70B by
 * default); returns null when that backend is local rules (so the deterministic
 * regex extractor in extract.js remains the sole source). Produces the richer,
 * confidence-scored shape the agent reviews before applying.
 *
 * Deterministic extraction stays the guaranteed baseline — this only *adds*
 * high-confidence fields on top and proposes the rest for agent confirmation.
 */

const EXTRACT_SYSTEM = `You are a CRM data extractor for "We Insure Things", a US insurance brokerage. Read a completed call transcript and extract structured lead fields for the customer's record.

Rules:
- Extract only what was actually said. Never invent a carrier, premium, VIN, or address.
- "premium" is a number (annual or quoted dollars), or null if none was stated.
- "policy_type" is the line of business (Auto, Home, Life, Commercial, Umbrella, etc.), or "" if unclear.
- "drivers" are full names; "vehicles" are {year, make, model, vin?} objects.
- "confidence" is your 0.0-1.0 certainty PER FIELD for policy_type, carrier, and premium. Be honest — low confidence when the transcript is ambiguous.
- Leave strings "" and arrays [] when nothing applies.`;

/** Whether the recap/extraction backend is an actual LLM (vs local rules). */
export function aiExtractionEnabled() {
  return backendForSchema("lead_extraction") !== "rules";
}

/**
 * @param {string} fullTranscript labelled "Agent:/Customer:" lines
 * @returns {Promise<object|null>} the rich extraction shape, or null when the
 *   backend is local rules / the transcript is empty / the model failed.
 */
export async function extractLeadFieldsAI(fullTranscript) {
  if (!fullTranscript?.trim() || !aiExtractionEnabled()) return null;
  return structuredCompletion({
    system: EXTRACT_SYSTEM,
    user: `Completed call transcript:\n\n${fullTranscript}\n\nExtract the lead fields.`,
    schema: null,
    schemaName: "lead_extraction",
    maxTokens: 1200,
  });
}

// AI field name → contacts column.
const COLUMN_MAP = {
  policy_type: "policy_type",
  carrier: "carrier",
  premium: "premium",
  address: "address",
  drivers: "drivers",
  vehicles: "vehicles",
};

// Fields without an explicit confidence score default to this (→ proposal, not
// auto-applied, unless it clears the threshold).
const DEFAULT_CONFIDENCE = 0.6;

/**
 * Split an AI extraction into fields to auto-apply (high confidence) and
 * suggestions to surface as "AI found these updates. Apply?".
 *
 * @returns {{applied: object, proposed: Array<{field,value,confidence}>, nextAction: string|null, customerNeed: string|null}}
 */
export function mergeAiExtraction(ai, { threshold = config.llm.extractAutoApplyConfidence } = {}) {
  const applied = {};
  const proposed = [];
  if (!ai || typeof ai !== "object") return { applied, proposed, nextAction: null, customerNeed: null };

  const conf = ai.confidence && typeof ai.confidence === "object" ? ai.confidence : {};

  for (const [aiKey, col] of Object.entries(COLUMN_MAP)) {
    let val = ai[aiKey];
    if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) continue;

    if (col === "premium") {
      const n = Number(String(val).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(n) || n <= 0) continue;
      val = n;
    }

    const c = typeof conf[aiKey] === "number" ? conf[aiKey] : DEFAULT_CONFIDENCE;
    if (c >= threshold) applied[col] = val;
    else proposed.push({ field: col, value: val, confidence: round2(c) });
  }

  return {
    applied,
    proposed,
    nextAction: typeof ai.next_action === "string" && ai.next_action.trim() ? ai.next_action.trim() : null,
    customerNeed: typeof ai.customer_need === "string" && ai.customer_need.trim() ? ai.customer_need.trim() : null,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
