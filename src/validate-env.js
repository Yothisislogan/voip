import { config } from "./config.js";

/**
 * Fail-fast configuration validation. In production (NODE_ENV=production) a fatal
 * misconfiguration exits the process with a clear message, so a bad deploy stops
 * immediately instead of running insecurely. Outside production, problems are
 * warnings only.
 *
 * Returns { fatal: string[], warn: string[] } (also logs). Call at startup.
 */
export function validateEnv({ exitOnFatal = true } = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const fatal = [];
  const warn = [];

  // ── Security-critical (fatal in production) ──
  if (!config.auth.required) {
    fatal.push("AUTH_REQUIRED=false disables login — never run this in production.");
  }
  if (config.auth.devLoginEnabled) {
    fatal.push("DEV_LOGIN_ENABLED=true exposes a passwordless login — disable it in production.");
  }
  if (!config.auth.sessionSecret) {
    fatal.push("SESSION_SECRET is required (used to sign session cookies). Set a long random value.");
  }
  if (!config.publicBaseUrl) {
    fatal.push("PUBLIC_BASE_URL is required in production (webhooks + Secure cookies).");
  } else if (!config.publicBaseUrl.startsWith("https://")) {
    warn.push("PUBLIC_BASE_URL is not https:// — session cookies won't be marked Secure.");
  }

  // Auth must actually be usable: Google client + at least one agent.
  if (config.auth.required && !config.auth.devLoginEnabled) {
    if (!config.auth.google.clientId || !config.auth.google.clientSecret) {
      fatal.push("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — no one could sign in.");
    }
    if (!config.auth.agents.length) {
      fatal.push("AGENT_DIRECTORY is empty — no agent is allowed to sign in.");
    }
  }

  // ── Functional (warnings) ──
  const twilioMissing = ["accountSid", "apiKeySid", "apiKeySecret", "twimlAppSid", "callerId"]
    .filter((k) => !config.twilio[k]);
  if (twilioMissing.length) warn.push(`Twilio not fully configured (${twilioMissing.join(", ")}) — calls/SMS won't work.`);
  if (config.publicBaseUrl && !process.env.TWILIO_AUTH_TOKEN) {
    warn.push("TWILIO_AUTH_TOKEN not set — inbound webhook signatures aren't validated.");
  }
  if (!config.databaseUrl) warn.push("DATABASE_URL not set — the Postgres CRM/pipeline is disabled.");

  // WiTNext bridge: half-configured = silently disabled — make that visible.
  if (Boolean(config.witnext.url) !== Boolean(config.witnext.secret)) {
    warn.push("WiTNext bridge is half-configured (need BOTH WITNEXT_URL and WITNEXT_INTEGRATION_SECRET) — events are NOT being forwarded.");
  }

  // AI backends: a Groq backend selected without a key silently falls back to
  // rules — warn so it isn't mistaken for "Groq is running".
  const backends = [config.llm.coachingBackend, config.llm.recapBackend, config.llm.automationBackend];
  if (backends.includes("groq") && !config.llm.groq.apiKey) {
    warn.push("An LLM backend is set to 'groq' but GROQ_API_KEY is missing — those tasks fall back to local rules.");
  }

  // ── Hardening (fatal/warn in production) ──
  if (isProd && config.auth.required && !config.security.csrfEnabled) {
    fatal.push("CSRF_ENABLED=false with auth on — browser POST/PATCH would be forgeable. Enable CSRF.");
  }
  if (isProd && config.databaseUrl && !config.retention.transcriptDays && !config.retention.recordingDays) {
    warn.push("No data-retention window set (RETENTION_TRANSCRIPT_DAYS / RETENTION_RECORDING_DAYS) — PII is kept forever.");
  }

  // ── Report ──
  for (const w of warn) console.warn(`⚠️  ${w}`);
  for (const f of fatal) console.error(`❌ ${f}`);

  if (fatal.length && isProd) {
    console.error(`\nRefusing to start: ${fatal.length} fatal configuration error(s) in production.`);
    if (exitOnFatal) process.exit(1);
  } else if (fatal.length) {
    console.warn(`\n(${fatal.length} issue(s) would be fatal in production; continuing because NODE_ENV != production.)`);
  }

  return { fatal, warn };
}
