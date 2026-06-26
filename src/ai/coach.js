import { config } from "../config.js";
import { structuredCompletion } from "./client.js";

/**
 * Real-time sales coaching. Given the rolling transcript window of a live
 * call, return a few short, actionable cues for the agent across four lenses:
 * objection handling, compliance disclosures, next-best question, and
 * sentiment/pacing. Returns null when AI is disabled or nothing is worth
 * surfacing.
 */

const COACH_SYSTEM = `You are a live sales coach for an agent at "We Insure Things", a US insurance brokerage. You read the running transcript of an in-progress phone call and whisper brief, high-value cues to the AGENT only (the customer never sees these).

Coach across four lenses:
- objection: the customer raised a concern (price, timing, trust, coverage) — suggest a concise rebuttal.
- compliance: a required disclosure is due or missing (call recording consent, state-specific insurance language, do-not-call). Flag it.
- next_question: the best discovery or closing question to move the sale forward right now.
- sentiment: the customer's tone is shifting, the agent is talking too much, or there is a long silence — alert with a pacing tip.

Rules:
- Only emit a cue when it is genuinely useful for the NEXT thing the agent says. Silence is fine — return an empty list rather than filler.
- Each cue is one short sentence (max ~15 words), phrased as a direct prompt to the agent.
- At most 3 cues. Prefer the single most important one.
- Never fabricate facts about the customer's policy or pricing.`;

const COACH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          lens: {
            type: "string",
            enum: ["objection", "compliance", "next_question", "sentiment"],
          },
          priority: { type: "string", enum: ["high", "normal"] },
          text: { type: "string" },
        },
        required: ["lens", "priority", "text"],
      },
    },
    customerSentiment: {
      type: "string",
      enum: ["positive", "neutral", "negative"],
    },
  },
  required: ["cues", "customerSentiment"],
};

/**
 * @param {string} recentTranscript labelled "Agent:/Customer:" lines
 * @returns {Promise<{cues: {lens,priority,text}[], customerSentiment: string}|null>}
 */
export async function generateCoaching(recentTranscript) {
  if (!recentTranscript?.trim()) return null;

  return structuredCompletion({
    model: config.anthropic.coachingModel,
    system: COACH_SYSTEM,
    user: `Live call transcript so far (most recent last):\n\n${recentTranscript}\n\nGive the agent cues for what to say next.`,
    schema: COACH_SCHEMA,
    schemaName: "coaching_cues",
    effort: "low", // latency-sensitive: keep it fast
    maxTokens: 500,
  });
}
