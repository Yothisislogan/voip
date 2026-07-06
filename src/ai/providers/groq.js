import { config } from "../../config.js";
import { rulesStructuredCompletion } from "./rules.js";

/**
 * Groq provider (OpenAI-compatible chat completions). Per-task model selection:
 *   - call_recap / lead_extraction → recap model (llama-3.3-70b-versatile)
 *   - coaching_cues                → coaching model (llama-3.1-8b-instant)
 *   - automation_*                 → automation model (openai/gpt-oss-120b)
 *
 * Every failure mode (no key, HTTP error, timeout, non-JSON, wrong shape) falls
 * back safely: recap/coaching fall back to the deterministic rules engine;
 * extraction/automation return null so the caller can use its own fallback
 * (deterministic extraction / skip). The live phone path never throws.
 *
 * Uses Node 18+ global fetch + AbortController — no SDK dependency.
 */
export async function groqStructuredCompletion(args) {
  const g = config.llm.groq;
  const fallback = rulesFallbackFor(args);

  if (!g.apiKey) return fallback;

  const model = modelFor(args.schemaName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFor(args.schemaName));

  try {
    const res = await fetch(`${g.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${g.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: args.schemaName === "coaching_cues" ? 0.1 : 0.2,
        max_tokens: args.maxTokens || 1500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `${args.system || ""}\n\n` +
              "Return ONLY a single valid JSON object. No markdown, no code fences, no prose.",
          },
          {
            role: "user",
            content:
              `${args.user || ""}\n\n` +
              `Respond with JSON matching this shape:\n${schemaHint(args.schemaName)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`Groq request failed: HTTP ${res.status}`);
      return fallback;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = parseJson(raw);
    if (!parsed) {
      console.error(`Groq ${args.schemaName || "completion"} returned unparseable JSON; using fallback.`);
      return fallback;
    }
    return validateShape(parsed, args.schemaName) ? parsed : fallback;
  } catch (err) {
    const msg = err.name === "AbortError" ? "timed out" : err.message;
    console.error(`Groq ${args.schemaName || "completion"} ${msg}; using fallback.`);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

// Recap + extraction share the 70B model; coaching uses 8B; automation uses 120B.
function modelFor(schemaName) {
  const g = config.llm.groq;
  if (schemaName === "coaching_cues") return g.coachingModel;
  if (String(schemaName || "").startsWith("automation")) return g.automationModel;
  return g.recapModel; // call_recap, lead_extraction, default
}

function timeoutFor(schemaName) {
  const g = config.llm.groq;
  return schemaName === "coaching_cues" ? g.coachingTimeoutMs : g.timeoutMs;
}

// Only recap/coaching have a deterministic rules equivalent. Extraction and
// automation have no rules provider, so they fall back to null and the caller
// (orchestrator / automation route) supplies its own fallback.
function rulesFallbackFor(args) {
  if (args.schemaName === "call_recap" || args.schemaName === "coaching_cues") {
    return rulesStructuredCompletion(args);
  }
  return null;
}

function parseJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function validateShape(value, schemaName) {
  if (!value || typeof value !== "object") return false;
  if (schemaName === "call_recap") {
    return (
      typeof value.summary === "string" &&
      typeof value.outcome === "string" &&
      Array.isArray(value.productsDiscussed) &&
      Array.isArray(value.objections) &&
      Array.isArray(value.nextSteps) &&
      typeof value.followUpDate === "string" &&
      ["positive", "neutral", "negative"].includes(value.customerSentiment)
    );
  }
  if (schemaName === "lead_extraction") {
    // Lenient: any recognized field present is enough; the merge step validates.
    return "summary" in value || "policy_type" in value || "fields" in value || "confidence" in value;
  }
  if (String(schemaName || "").startsWith("automation")) {
    return true; // automation outputs are free-form-ish; the route validates.
  }
  return (
    Array.isArray(value.cues) &&
    ["positive", "neutral", "negative"].includes(value.customerSentiment)
  );
}

function schemaHint(schemaName) {
  if (schemaName === "call_recap") {
    return JSON.stringify(
      {
        summary: "2-4 factual sentences",
        outcome: "sale | follow_up | callback | quote_requested | not_interested | no_answer | other",
        productsDiscussed: ["Auto"],
        objections: ["Price concern"],
        nextSteps: ["Follow up with customer"],
        followUpDate: "YYYY-MM-DD or empty string",
        customerSentiment: "positive | neutral | negative",
      },
      null,
      2
    );
  }
  if (schemaName === "lead_extraction") {
    return JSON.stringify(
      {
        summary: "1-2 sentence customer need",
        customer_need: "what the customer wants",
        policy_type: "Auto | Home | Life | Commercial | ... or empty",
        carrier: "current/quoted carrier or empty",
        premium: "number (annual or quoted) or null",
        address: "street address if stated or empty",
        drivers: ["Full Name"],
        vehicles: [{ year: 2021, make: "Toyota", model: "Camry", vin: "optional" }],
        objections: ["Price concern"],
        next_action: "one concrete next step",
        confidence: { policy_type: 0.0, carrier: 0.0, premium: 0.0 },
      },
      null,
      2
    );
  }
  if (String(schemaName || "").startsWith("automation")) {
    return JSON.stringify(
      {
        title: "short task/plan title",
        steps: ["ordered action steps"],
        draft: "email or SMS draft text if requested, else empty",
        notes: "analysis / coverage gaps / manager summary as requested",
      },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      cues: [
        { lens: "objection | compliance | next_question | sentiment", priority: "high | normal", text: "short cue" },
      ],
      customerSentiment: "positive | neutral | negative",
    },
    null,
    2
  );
}
