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
  // Cross-origin allowlist for browser fetches. Empty = same-origin only
  // (most secure; the agent UI is served from this same server).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
    callerId: process.env.TWILIO_CALLER_ID,
  },
  defaultAgentIdentity: process.env.DEFAULT_AGENT_IDENTITY || "agent",
  databaseUrl: process.env.DATABASE_URL || null,

  // ─── ERPNext (Frappe) REST API ───────────────────────────
  // Feature is optional: if baseUrl/apiKey/apiSecret are unset, the CRM
  // integration no-ops (screen-pop + recap silently skip) so the phone keeps
  // working. Uses Frappe token auth + /api/resource endpoints.
  erpnext: {
    baseUrl: (process.env.ERPNEXT_BASE_URL || "").replace(/\/$/, ""),
    apiKey: process.env.ERPNEXT_API_KEY || null,
    apiSecret: process.env.ERPNEXT_API_SECRET || null,
    // Deep-link base used by the agent UI to open a record in ERPNext.
    // Defaults to baseUrl if unset.
    uiUrl: (process.env.ERPNEXT_UI_URL || process.env.ERPNEXT_BASE_URL || "").replace(/\/$/, ""),
  },

  // ─── Anthropic (Claude) — real-time coaching + call recap ─
  // Two backends:
  //   - "anthropic" (default): direct Anthropic API, needs ANTHROPIC_API_KEY.
  //   - "bedrock": Amazon Bedrock (keeps data in your AWS account/region under
  //     your BAA). Needs AWS_REGION + AWS credentials (standard AWS chain); no
  //     ANTHROPIC_API_KEY. Model IDs are auto-prefixed with "anthropic.".
  // Model IDs are stored bare; coaching can use a lower-latency model since cues
  // are time-sensitive.
  anthropic: {
    backend: (process.env.LLM_BACKEND || "anthropic").toLowerCase(),
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null,
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

  // ─── Authentication (Google OAuth + Twilio Verify 2FA) ────
  auth: {
    // Secure by default. Set AUTH_REQUIRED=false ONLY for local dev — it
    // bypasses login and injects DEV_IDENTITY. Never do this in production.
    required: process.env.AUTH_REQUIRED !== "false",
    devIdentity: process.env.DEV_IDENTITY || "marisol.vega",
    // Temporary developer login: when true, /auth/dev issues a full session for
    // a chosen identity WITHOUT Google or 2FA. Off by default; opt-in for testing
    // and remove before production. Keeps auth "on" (unlike AUTH_REQUIRED=false).
    devLoginEnabled: process.env.DEV_LOGIN_ENABLED === "true",
    // HMAC secret for the signed session cookie (JWT). Required when auth is on.
    sessionSecret: process.env.SESSION_SECRET || null,
    cookieName: process.env.SESSION_COOKIE_NAME || "wit_session",
    sessionTtlSec: Number(process.env.SESSION_TTL_SEC) || 8 * 60 * 60, // 8h
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
      // Falls back to PUBLIC_BASE_URL (or localhost) + /auth/google/callback.
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ||
        ((process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "") +
          "/auth/google/callback"),
      // Optional: restrict logins to a Google Workspace domain (extra guard
      // on top of the agent allowlist).
      hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN || null,
    },
    twoFactor: {
      enabled: process.env.TWO_FACTOR_ENABLED !== "false",
      verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || null,
    },
    // Allowlist mapping verified Google emails -> Twilio identity + MFA target.
    // AGENT_DIRECTORY is a JSON array, e.g.:
    // [{"email":"a@wit.com","identity":"marisol.vega","name":"Marisol Vega",
    //   "mfaChannel":"sms","phone":"+14805550100"}]
    agents: parseAgentDirectory(process.env.AGENT_DIRECTORY),
  },
};

function parseAgentDirectory(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn(`⚠️  AGENT_DIRECTORY is not valid JSON — no agents loaded: ${err.message}`);
    return [];
  }
}

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
