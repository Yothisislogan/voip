import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";

/**
 * Shared Claude client for coaching + recap. Two interchangeable backends:
 *
 *   - "anthropic": direct Anthropic API (needs ANTHROPIC_API_KEY)
 *   - "bedrock":   Amazon Bedrock via the Mantle client (needs AWS_REGION +
 *                  AWS credentials; data stays in your AWS account/region)
 *
 * Both expose the same `.messages.create` surface, so coach.js / recap.js are
 * backend-agnostic. If the chosen backend isn't configured, `aiEnabled` is false
 * and coaching/recap silently skip — the phone keeps working.
 */

const backend = config.anthropic.backend === "bedrock" ? "bedrock" : "anthropic";

/** Bedrock requires an "anthropic." prefix on model IDs; direct API uses bare. */
export function modelId(bare) {
  if (backend !== "bedrock") return bare;
  return bare.startsWith("anthropic.") ? bare : `anthropic.${bare}`;
}

export let aiEnabled = false;
export let anthropic = null;

try {
  if (backend === "bedrock") {
    if (config.anthropic.awsRegion) {
      anthropic = new AnthropicBedrockMantle({ awsRegion: config.anthropic.awsRegion });
      aiEnabled = true;
      console.log(
        `🤖 Claude AI enabled via Amazon Bedrock (${config.anthropic.awsRegion}; ` +
          `recap: ${modelId(config.anthropic.model)}, coaching: ${modelId(config.anthropic.coachingModel)}).`
      );
    } else {
      console.log("🤖 LLM_BACKEND=bedrock but AWS_REGION is not set — coaching + recap disabled.");
    }
  } else if (config.anthropic.apiKey) {
    anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
    aiEnabled = true;
    console.log(
      `🤖 Claude AI enabled via Anthropic API (recap: ${config.anthropic.model}, coaching: ${config.anthropic.coachingModel}).`
    );
  } else {
    console.log("🤖 ANTHROPIC_API_KEY not set — coaching + recap disabled.");
  }
} catch (err) {
  console.error("🤖 Claude client init failed — coaching + recap disabled:", err.message);
  anthropic = null;
  aiEnabled = false;
}

/**
 * Run a structured (JSON-schema-constrained) Claude request and return the
 * parsed object, or null on any failure. Centralizes error handling so callers
 * never throw into a live-call code path.
 */
export async function structuredCompletion({
  model,
  system,
  user,
  schema,
  schemaName,
  effort = "medium",
  maxTokens = 1024,
}) {
  if (!aiEnabled) return null;
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
