import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";
import { rulesStructuredCompletion } from "./providers/rules.js";
import { ollamaStructuredCompletion } from "./providers/ollama.js";
import { groqStructuredCompletion } from "./providers/groq.js";

/**
 * AI router for coaching + recap, with PER-TASK backends.
 *
 * Providers:
 *   - rules:     deterministic local coaching/recap, no API, no GPU
 *   - ollama:    tiny local/server LLM with automatic rules fallback
 *   - anthropic: direct Claude API
 *   - bedrock:   Claude through Amazon Bedrock
 *
 * Live coaching is LOCAL-first by design: it runs the rules engine (or the tiny
 * Ollama model with rules fallback) and never depends on Claude unless an
 * operator explicitly sets LLM_COACHING_BACKEND. Recap follows LLM_BACKEND, so
 * Claude/Bedrock can power higher-quality recaps. Claude is entirely optional.
 *
 * The live-call path never throws because AI is optional — every provider
 * returns a safe fallback rather than disrupting the phone.
 */

export const coachingBackend = normalizeBackend(config.llm.coachingBackend);
export const recapBackend = normalizeBackend(config.llm.recapBackend);
export const automationBackend = normalizeBackend(config.llm.automationBackend);

const claudeBackends = [coachingBackend, recapBackend];
const usesClaude = claudeBackends.some((b) => b === "anthropic" || b === "bedrock");
const needsBedrock = claudeBackends.includes("bedrock");

// Rules are always available, so AI is effectively always "on".
export const aiEnabled = true;
export let anthropic = null;
let claudeIsBedrock = false;

try {
  if (usesClaude) {
    if (needsBedrock && config.anthropic.awsRegion) {
      anthropic = new AnthropicBedrockMantle({ awsRegion: config.anthropic.awsRegion });
      claudeIsBedrock = true;
    } else if (config.anthropic.apiKey) {
      anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
    }
  }
} catch (err) {
  console.error("Claude client init failed; recap will fall back to local:", err.message);
  anthropic = null;
}

logStartup();

export function modelId(bare) {
  if (!claudeIsBedrock) return bare;
  return bare.startsWith("anthropic.") ? bare : `anthropic.${bare}`;
}

/**
 * Route a structured completion to the backend for its task, inferred from
 * schemaName:
 *   - "call_recap" / "lead_extraction" → recap backend (e.g. Groq 70B)
 *   - "automation*"                    → automation backend (e.g. GPT-OSS 120B)
 *   - anything else (coaching_cues)    → coaching backend (local-first)
 */
export function backendForSchema(schemaName) {
  if (schemaName === "call_recap" || schemaName === "lead_extraction") return recapBackend;
  if (String(schemaName || "").startsWith("automation")) return automationBackend;
  return coachingBackend;
}

export async function structuredCompletion(args) {
  const backend = backendForSchema(args.schemaName);

  if (backend === "groq") return groqStructuredCompletion(args);
  if (backend === "ollama") return ollamaStructuredCompletion(args);

  if ((backend === "anthropic" || backend === "bedrock") && anthropic) {
    const res = await claudeStructuredCompletion(args);
    return res ?? rulesFallback(args); // never leave the caller empty
  }

  // rules, or an unconfigured cloud backend → deterministic local (or null for
  // tasks that have no rules equivalent, so the caller can fall back itself).
  return rulesFallback(args);
}

// rules provider only knows recap + coaching. Extraction/automation return null.
function rulesFallback(args) {
  if (args.schemaName === "call_recap" || args.schemaName === "coaching_cues") {
    return rulesStructuredCompletion(args);
  }
  return null;
}

async function claudeStructuredCompletion({
  model,
  system,
  user,
  schema,
  schemaName,
  effort = "medium",
  maxTokens = 1024,
}) {
  try {
    const res = await anthropic.messages.create({
      model: modelId(model),
      max_tokens: maxTokens,
      system,
      output_config: {
        effort,
        format: { type: "json_schema", name: schemaName, schema },
      },
      messages: [{ role: "user", content: user }],
    });

    if (res.stop_reason === "refusal") {
      console.error("Claude refused request:", res.stop_details?.category);
      return null;
    }

    const text = res.content.find((b) => b.type === "text")?.text;
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.error("Claude request failed:", err.message);
    return null;
  }
}

function normalizeBackend(value) {
  const b = String(value || "rules").toLowerCase();
  if (["rules", "ollama", "anthropic", "bedrock", "groq"].includes(b)) return b;
  console.warn(`Unknown AI backend "${value}"; using rules.`);
  return "rules";
}

function logStartup() {
  const claudeNote = usesClaude
    ? anthropic
      ? ` (Claude via ${claudeIsBedrock ? "Bedrock" : "API"} ready)`
      : " (Claude requested but not configured — falling back to local)"
    : "";
  const groqNote =
    [coachingBackend, recapBackend, automationBackend].includes("groq") && !config.llm.groq.apiKey
      ? " (Groq requested but GROQ_API_KEY missing — falling back to local)"
      : "";
  console.log(
    `AI: coaching=${coachingBackend}, recap=${recapBackend}, automation=${automationBackend}` +
      `${claudeNote}${groqNote}. Live coaching is local-first; rules fallback always on.`
  );
}
