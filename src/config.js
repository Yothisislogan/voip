import dotenv from "dotenv";
dotenv.config();

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_CALLER_ID",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `\u26A0\uFE0F  Missing env vars: ${missing.join(", ")}.\n` +
      "   Copy .env.example to .env and fill these in before placing calls."
  );
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
    callerId: process.env.TWILIO_CALLER_ID,
  },
  defaultAgentIdentity: process.env.DEFAULT_AGENT_IDENTITY || "agent",
  databaseUrl: process.env.DATABASE_URL || null,

  // ─── SuiteCRM V8 REST API (OAuth2) ───────────────────────
  // Feature is optional: if baseUrl/clientId/secret are unset, the CRM
  // integration no-ops (screen-pop + recap silently skip) so the phone
  // keeps working. SuiteCRM 7.10+ exposes the V8 JSON:API at /Api/V8.
  suitecrm: {
    baseUrl: (process.env.SUITECRM_BASE_URL || "").replace(/\/$/, ""),
    clientId: process.env.SUITECRM_CLIENT_ID || null,
    clientSecret: process.env.SUITECRM_CLIENT_SECRET || null,
    // Password grant (recommended for a trusted server-to-server agent user).
    username: process.env.SUITECRM_USERNAME || null,
    password: process.env.SUITECRM_PASSWORD || null,
    // Deep-link base used by the agent UI to open a record in SuiteCRM.
    // Defaults to baseUrl if unset.
    uiUrl: (process.env.SUITECRM_UI_URL || process.env.SUITECRM_BASE_URL || "").replace(/\/$/, ""),
  },

  // ─── Anthropic (Claude) — real-time coaching + call recap ─
  // Optional: if apiKey is unset, coaching + recap silently skip.
  // Recap uses the high-quality default; coaching can be pointed at a
  // lower-latency model (e.g. claude-haiku-4-5) since cues are time-sensitive.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    coachingModel:
      process.env.ANTHROPIC_COACHING_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      "claude-opus-4-8",
  },

  // ─── AI feature flags ─────────────────────────────────────
  coachingEnabled: process.env.COACHING_ENABLED !== "false",
  recapEnabled: process.env.RECAP_ENABLED !== "false",
  // Minimum ms between coaching LLM calls per call, to bound cost/latency
  // when the transcript is chatty.
  coachingThrottleMs: Number(process.env.COACHING_THROTTLE_MS) || 6000,
};

// Build an absolute webhook URL Twilio can reach.
// Throws at call time if PUBLIC_BASE_URL is not set, so the misconfiguration
// surfaces on the first request rather than silently producing relative paths
// that Twilio cannot reach.
export const webhookUrl = (path) => {
  if (!config.publicBaseUrl) {
    throw new Error(
      `webhookUrl("${path}") called but PUBLIC_BASE_URL is not set. ` +
        "Set PUBLIC_BASE_URL to your ngrok/public URL in .env."
    );
  }
  return `${config.publicBaseUrl}${path}`;
};
