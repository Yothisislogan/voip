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
    `⚠️  Missing env vars: ${missing.join(", ")}.\n` +
      "   Copy .env.example to .env and fill these in before placing calls."
  );
}

// Render's `fromService property: host` injects a bare hostname (no scheme);
// normalize to a full https:// URL so webhook building + Secure-cookie detection
// work. Accepts already-qualified http(s) URLs unchanged.
function normalizeBaseUrl(v) {
  const raw = (v || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: normalizeBaseUrl(process.env.PUBLIC_BASE_URL),
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

  messaging: {
    enabled: process.env.MESSAGING_ENABLED !== "false",
    provider: (process.env.MESSAGING_PROVIDER || "twilio_conversations").toLowerCase(),
    conversationsServiceSid: process.env.TWILIO_CONVERSATIONS_SERVICE_SID || null,
    businessAuthor: process.env.MESSAGING_BUSINESS_AUTHOR || "wit-connect",
  },

  erpnext: {
    baseUrl: (process.env.ERPNEXT_BASE_URL || "").replace(/\/$/, ""),
    apiKey: process.env.ERPNEXT_API_KEY || null,
    apiSecret: process.env.ERPNEXT_API_SECRET || null,
    uiUrl: (process.env.ERPNEXT_UI_URL || process.env.ERPNEXT_BASE_URL || "").replace(/\/$/, ""),
  },

  // Pluggable AI provider for live coaching + call recap.
  //   rules     = deterministic local sales coach, no API, no GPU
  //   ollama    = local/server-hosted model with rules fallback
  //   anthropic = direct Claude API
  //   bedrock   = Claude through Amazon Bedrock
  llm: {
    backend: (process.env.LLM_BACKEND || "rules").toLowerCase(),
    // Per-task backends. Live coaching stays LOCAL-first (rules, or the tiny
    // local LLM when LLM_BACKEND=ollama) and never uses Claude unless explicitly
    // overridden — real-time tips must not depend on a cloud LLM. Recap follows
    // LLM_BACKEND, so Claude/Bedrock can power higher-quality recaps.
    coachingBackend: (
      process.env.LLM_COACHING_BACKEND ||
      ((process.env.LLM_BACKEND || "rules").toLowerCase() === "ollama" ? "ollama" : "rules")
    ).toLowerCase(),
    recapBackend: (process.env.LLM_RECAP_BACKEND || process.env.LLM_BACKEND || "rules").toLowerCase(),
    // Automation = heavier, on-demand reasoning (follow-up plans, task creation,
    // email/SMS drafts, coverage-gap analysis, manager summaries). NEVER runs on
    // every call — invoked explicitly. Defaults to LLM_BACKEND so it stays local
    // (rules) unless an operator opts into a cloud model like GPT-OSS 120B.
    automationBackend: (process.env.LLM_AUTOMATION_BACKEND || process.env.LLM_BACKEND || "rules").toLowerCase(),
    timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 1200,
    // Groq (OpenAI-compatible API). Recap/extraction on 70B, coaching on 8B,
    // automation on GPT-OSS 120B. Rules remain the fallback on any failure.
    groq: {
      apiKey: process.env.GROQ_API_KEY || null,
      baseUrl: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      recapModel: process.env.GROQ_RECAP_MODEL || "llama-3.3-70b-versatile",
      coachingModel: process.env.GROQ_COACHING_MODEL || "llama-3.1-8b-instant",
      automationModel: process.env.GROQ_AUTOMATION_MODEL || "openai/gpt-oss-120b",
      timeoutMs: Number(process.env.GROQ_TIMEOUT_MS) || 10000,
      coachingTimeoutMs: Number(process.env.GROQ_COACHING_TIMEOUT_MS) || 2500,
    },
    // AI-extracted CRM fields at/above this confidence are auto-applied; the rest
    // are surfaced to the agent as "AI found these updates. Apply?" suggestions.
    extractAutoApplyConfidence: Number(process.env.AI_EXTRACT_AUTOAPPLY_CONFIDENCE) || 0.85,
    ollama: {
      baseUrl: (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, ""),
      model: process.env.OLLAMA_MODEL || "qwen2.5:0.5b",
      coachingModel: process.env.OLLAMA_COACHING_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:0.5b",
      recapModel: process.env.OLLAMA_RECAP_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:0.5b",
      recapTimeoutMs: Number(process.env.OLLAMA_RECAP_TIMEOUT_MS) || 8000,
      contextTokens: Number(process.env.OLLAMA_CONTEXT_TOKENS) || 2048,
    },
  },

  // Claude settings remain optional providers.
  anthropic: {
    backend: (process.env.LLM_BACKEND || "rules").toLowerCase(),
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null,
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    coachingModel:
      process.env.ANTHROPIC_COACHING_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      "claude-opus-4-8",
  },

  coachingEnabled: process.env.COACHING_ENABLED !== "false",
  recapEnabled: process.env.RECAP_ENABLED !== "false",
  coachingThrottleMs: Number(process.env.COACHING_THROTTLE_MS) || 6000,

  // Post-call survey SMS follow-up (opt-in).
  survey: {
    enabled: process.env.SURVEY_ENABLED === "true",
    text:
      process.env.SURVEY_TEXT ||
      "Thanks for speaking with We Insure Things! How likely are you to recommend us? Reply 1-5.",
  },

  // Inbound email intake (SendGrid/Mailgun inbound-parse webhook).
  emailIntake: {
    enabled: process.env.EMAIL_INTAKE_ENABLED !== "false",
    token: process.env.EMAIL_INBOUND_TOKEN || null, // optional shared secret
  },

  auth: {
    required: process.env.AUTH_REQUIRED !== "false",
    devIdentity: process.env.DEV_IDENTITY || "marisol.vega",
    devLoginEnabled: process.env.DEV_LOGIN_ENABLED === "true",
    sessionSecret: process.env.SESSION_SECRET || null,
    cookieName: process.env.SESSION_COOKIE_NAME || "wit_session",
    sessionTtlSec: Number(process.env.SESSION_TTL_SEC) || 8 * 60 * 60,
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ||
        ((process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "") +
          "/auth/google/callback"),
      hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN || null,
    },
    twoFactor: {
      enabled: process.env.TWO_FACTOR_ENABLED !== "false",
      verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || null,
    },
    agents: parseAgentDirectory(process.env.AGENT_DIRECTORY),
  },

  // Security middleware knobs (hand-rolled; see src/middleware/).
  security: {
    // Enforce CSRF on cookie-authenticated browser POST/PATCH. Off only for
    // AUTH_REQUIRED=false dev, where there's no session cookie to forge.
    csrfEnabled: process.env.CSRF_ENABLED
      ? process.env.CSRF_ENABLED !== "false"
      : process.env.AUTH_REQUIRED !== "false",
    // Content-Security-Policy for the app pages. Inline is allowed because the
    // agent UIs use inline <script>; tighten with nonces if those are extracted.
    csp:
      process.env.CONTENT_SECURITY_POLICY ||
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    hstsMaxAge: Number(process.env.HSTS_MAX_AGE) || 15552000, // 180 days
    rateLimit: {
      // Requests per window per client IP. Auth endpoints are stricter.
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
      apiMax: Number(process.env.RATE_LIMIT_API_MAX) || 300,
      authMax: Number(process.env.RATE_LIMIT_AUTH_MAX) || 20,
      webhookMax: Number(process.env.RATE_LIMIT_WEBHOOK_MAX) || 600,
      trustProxy: process.env.RATE_LIMIT_TRUST_PROXY !== "false", // read X-Forwarded-For (behind Caddy/CF)
      // How many proxies WE control append to X-Forwarded-For. 1 = Caddy/Render
      // alone; 2 = Cloudflare in front of Caddy. Entries left of these are
      // client-forgeable and must never be trusted.
      trustHops: Math.max(1, Number(process.env.RATE_LIMIT_TRUST_HOPS) || 1),
    },
  },

  // Data retention (days). 0 = keep forever. Enforced by scripts/purge-retention.js.
  retention: {
    transcriptDays: Number(process.env.RETENTION_TRANSCRIPT_DAYS) || 0,
    recordingDays: Number(process.env.RETENTION_RECORDING_DAYS) || 0,
    auditDays: Number(process.env.RETENTION_AUDIT_DAYS) || 0,
    deleteTwilioRecordings: process.env.RETENTION_DELETE_TWILIO_RECORDINGS === "true",
  },
};

function parseAgentDirectory(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Normalize role: viewer | agent | admin. Unknown/missing → agent.
    const ROLES = new Set(["viewer", "agent", "admin"]);
    return arr.map((a) => {
      const role = String(a?.role || "").toLowerCase();
      return { ...a, role: ROLES.has(role) ? role : "agent" };
    });
  } catch (err) {
    console.warn(`⚠️  AGENT_DIRECTORY is not valid JSON — no agents loaded: ${err.message}`);
    return [];
  }
}

export const webhookUrl = (path) => {
  if (!config.publicBaseUrl) {
    throw new Error(
      `webhookUrl("${path}") called but PUBLIC_BASE_URL is not set. ` +
        "Set PUBLIC_BASE_URL to your ngrok/public URL in .env."
    );
  }
  return `${config.publicBaseUrl}${path}`;
};
