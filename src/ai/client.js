import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";
import { rulesStructuredCompletion } from "./providers/rules.js";
import { ollamaStructuredCompletion } from "./providers/ollama.js";

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
 * Route a structured completion to the backend for its task. Task is inferred
 * from schemaName: "call_recap" → recap backend, anything else → coaching.
 */
export async function structuredCompletion(args) {
  const isRecap = args.schemaName === "call_recap";
  const backend = isRecap ? recapBackend : coachingBackend;

  if (backend === "rules") return rulesStructuredCompletion(args);
  if (backend === "ollama") return ollamaStructuredCompletion(args);

  if ((backend === "anthropic" || backend === "bedrock") && anthropic) {
    const res = await claudeStructuredCompletion(args);
    return res || rulesStructuredCompletion(args); // never leave the caller empty
  }

  // Claude requested but no client available (missing key/region) → local.
  return rulesStructuredCompletion(args);
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
  if (["rules", "ollama", "anthropic", "bedrock"].includes(b)) return b;
  console.warn(`Unknown AI backend "${value}"; using rules.`);
  return "rules";
}

function logStartup() {
  const claudeNote = usesClaude
    ? anthropic
      ? ` (Claude via ${claudeIsBedrock ? "Bedrock" : "API"} ready)`
      : " (Claude requested but not configured — falling back to local)"
    : "";
  console.log(
    `AI: coaching=${coachingBackend}, recap=${recapBackend}${claudeNote}. ` +
      "Live coaching is local-first; rules fallback always on."
  );
}
