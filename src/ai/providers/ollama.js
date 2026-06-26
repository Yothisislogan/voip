import { config } from "../../config.js";
import { rulesStructuredCompletion } from "./rules.js";

/**
 * Local Ollama provider for CPU-friendly coaching and recap.
 * Uses Node 18+ global fetch and AbortController; no extra package required.
 */
export async function ollamaStructuredCompletion(args) {
  const fallback = rulesStructuredCompletion(args);
  const baseUrl = (config.llm.ollama.baseUrl || "").replace(/\/$/, "");
  const model = modelFor(args.schemaName);

  if (!baseUrl || !model) return fallback;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFor(args.schemaName));

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options: {
          temperature: args.schemaName === "coaching_cues" ? 0.1 : 0.2,
          num_ctx: config.llm.ollama.contextTokens,
        },
        messages: [
          {
            role: "system",
            content:
              `${args.system || ""}\n\n` +
              "Return ONLY valid JSON. Do not include markdown, explanations, or code fences.",
          },
          {
            role: "user",
            content:
              `${args.user || ""}\n\n` +
              `Required JSON shape:\n${schemaHint(args.schemaName)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`Ollama request failed: HTTP ${res.status}`);
      return fallback;
    }

    const data = await res.json();
    const raw = data?.message?.content || data?.response || "";
    const parsed = parseJson(raw);
    return validateShape(parsed, args.schemaName) ? parsed : fallback;
  } catch (err) {
    const msg = err.name === "AbortError" ? "timed out" : err.message;
    console.error(`Ollama ${args.schemaName || "completion"} ${msg}; using rules fallback.`);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function modelFor(schemaName) {
  if (schemaName === "call_recap") return config.llm.ollama.recapModel || config.llm.ollama.model;
  return config.llm.ollama.coachingModel || config.llm.ollama.model;
}

function timeoutFor(schemaName) {
  if (schemaName === "call_recap") return config.llm.ollama.recapTimeoutMs;
  return config.llm.timeoutMs;
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

  return JSON.stringify(
    {
      cues: [
        {
          lens: "objection | compliance | next_question | sentiment",
          priority: "high | normal",
          text: "One short cue for what the agent should say next",
        },
      ],
      customerSentiment: "positive | neutral | negative",
    },
    null,
    2
  );
}
