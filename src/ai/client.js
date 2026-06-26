import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * Shared Anthropic (Claude) client for coaching + recap.
 *
 * Optional: if ANTHROPIC_API_KEY is unset the client is null and `aiEnabled`
 * is false, so coaching and recap silently skip and the phone keeps working.
 */
export const aiEnabled = Boolean(config.anthropic.apiKey);

export const anthropic = aiEnabled
  ? new Anthropic({ apiKey: config.anthropic.apiKey })
  : null;

if (aiEnabled) {
  console.log(
    `🤖 Claude AI enabled (recap: ${config.anthropic.model}, coaching: ${config.anthropic.coachingModel}).`
  );
} else {
  console.log("🤖 ANTHROPIC_API_KEY not set — coaching + recap disabled.");
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
      model,
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
