import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";
import { rulesStructuredCompletion } from "./providers/rules.js";
import { ollamaStructuredCompletion } from "./providers/ollama.js";

/**
 * Shared AI router for coaching + recap.
 *
 * Providers:
 *   - rules:     deterministic local coaching/recap, no API, no GPU
 *   - ollama:    local/server-hosted LLM with rules fallback
 *   - anthropic: direct Claude API
 *   - bedrock:   Claude through Amazon Bedrock
 *
 * Live call code should never throw because AI is optional. Every provider
 * returns null or a safe fallback rather than disrupting the phone path.
 */

const backend = normalizeBackend(config.llm.backend);

export let aiEnabled = backend === "rules" || backend === "ollama";
export let anthropic = null;

try {
  if (backend === "bedrock") {
    if (config.anthropic.awsRegion) {
      anthropic = new AnthropicBedrockMantle({ awsRegion: config.anthropic.awsRegion });
      aiEnabled = true;
      console.log(
        `AI enabled via Amazon Bedrock (recap: ${modelId(config.anthropic.model)}, coaching: ${modelId(config.anthropic.coachingModel)}).`
      );
    } else {
      console.log("LLM_BACKEND=bedrock but AWS_REGION is not set. Falling back to rules coach.");
      aiEnabled = true;
    }
  } else if (backend === "anthropic") {
    if (config.anthropic.apiKey) {
      anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
      aiEnabled = true;
      console.log(
        `AI enabled via Anthropic API (recap: ${config.anthropic.model}, coaching: ${config.anthropic.coachingModel}).`
      );
    } else {
      console.log("LLM_BACKEND=anthropic but ANTHROPIC_API_KEY is not set. Falling back to rules coach.");
      aiEnabled = true;
    }
  } else if (backend === "ollama") {
    console.log(
      `AI enabled via Ollama (${config.llm.ollama.baseUrl}; coaching: ${config.llm.ollama.coachingModel}; recap: ${config.llm.ollama.recapModel}). Rules fallback is active.`
    );
  } else {
    console.log("AI enabled via local rules coach. Set LLM_BACKEND=ollama or anthropic for model-backed coaching.");
  }
} catch (err) {
  console.error("AI client init failed; falling back to local rules coach:", err.message);
  anthropic = null;
  aiEnabled = true;
}

export function modelId(bare) {
  if (backend !== "bedrock") return bare;
  return bare.startsWith("anthropic.") ? bare : `anthropic.${bare}`;
}

export async function structuredCompletion(args) {
  if (!aiEnabled) return null;

  if (backend === "rules") return rulesStructuredCompletion(args);
  if (backend === "ollama") return ollamaStructuredCompletion(args);

  if ((backend === "anthropic" || backend === "bedrock") && anthropic) {
    const res = await claudeStructuredCompletion(args);
    return res || rulesStructuredCompletion(args);
  }

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
  console.warn(`Unknown LLM_BACKEND=${value}; using rules.`);
  return "rules";
}
