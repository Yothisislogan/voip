import { config } from "./config.js";
import { validateRouting } from './services/routing.js';

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
  if (!['twilio', 'telnyx'].includes(config.voiceProvider)) fatal.push('VOICE_PROVIDER must be twilio or telnyx.');
  if (config.voiceProvider === 'telnyx') {
    for (const key of ['apiKey', 'publicKey', 'connectionId', 'callerId', 'mediaSecret']) if (!config.telnyx[key]) fatal.push(`Telnyx ${key} is required.`);
    if ((config.telnyx.mediaSecret?.length || 0) < 32) fatal.push('TELNYX_MEDIA_SECRET must have at least 32 characters.');
    for (const field of ['telnyxCredentialId','telnyxSipUsername']) {
      const values = config.auth.agents.filter(a => a.role !== 'viewer').map(a => a[field]).filter(Boolean);
      if (new Set(values).size !== values.length) fatal.push(`Each agent needs a distinct ${field}.`);
    }
    if (config.transcription.provider !== 'assemblyai') fatal.push('Telnyx voice requires TRANSCRIPTION_PROVIDER=assemblyai.');
    for (const agent of config.auth.agents.filter(a => a.role !== 'viewer')) if (!agent.telnyxCredentialId || !agent.telnyxSipUsername) fatal.push(`Telnyx WebRTC mapping missing for ${agent.identity}.`);
  }
  if (!['twilio', 'assemblyai'].includes(config.transcription.provider)) fatal.push('TRANSCRIPTION_PROVIDER must be twilio or assemblyai.');
  if (config.transcription.provider === 'assemblyai') {
    if (!config.transcription.apiKey) fatal.push('ASSEMBLYAI_API_KEY is required for AssemblyAI transcription.');
    if (config.voiceProvider === 'twilio' && (!config.twilio.accountSid || !config.twilio.authToken)) fatal.push('Twilio account SID and auth token are required for signed Media Streams.');
    if (!['wss://streaming.assemblyai.com/v3/ws', 'wss://streaming.us.assemblyai.com/v3/ws', 'wss://streaming.eu.assemblyai.com/v3/ws'].includes(config.transcription.endpoint)) fatal.push('ASSEMBLYAI_STREAMING_URL must be an official AssemblyAI v3 endpoint.');
    if (!Number.isInteger(config.transcription.maxCalls) || config.transcription.maxCalls < 1 || config.transcription.maxCalls > 100) fatal.push('ASSEMBLYAI_MAX_CALLS must be an integer from 1 to 100.');
    if (!config.coachingEnabled && !config.recapEnabled) warn.push('Both coaching and recap are disabled: transcription will not start.');
  }
  fatal.push(...validateRouting(config.voice.routing));
  if (isProd && !config.databaseUrl) fatal.push('DATABASE_URL is required for durable call records and delivery.');
  if (isProd && (config.voiceProvider === 'twilio' || config.messaging.enabled) && !process.env.TWILIO_AUTH_TOKEN) fatal.push('TWILIO_AUTH_TOKEN is required to authenticate provider webhooks.');
  if (config.witnext.enabled && !config.witnext.integrationId) fatal.push('WITNEXT_INTEGRATION_ID is required by the WiTnext receiver.');
  if (isProd && config.emailIntake.enabled && !config.emailIntake.token) fatal.push('EMAIL_INBOUND_TOKEN is required when email intake is enabled.');

  if (isProd && config.auth.twoFactor.enabled && (!config.auth.twoFactor.verifyServiceSid || !config.twilio.accountSid || !config.twilio.apiKeySid || !config.twilio.apiKeySecret)) fatal.push('Twilio Verify credentials are required while TWO_FACTOR_ENABLED=true; voice-provider migration must not disable MFA.');

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
    fatal.push("PUBLIC_BASE_URL must use https:// in production.");
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
  if (config.voiceProvider === 'twilio' && twilioMissing.length) warn.push(`Twilio not fully configured (${twilioMissing.join(", ")}) — calls/SMS won't work.`);
  if (config.voiceProvider === 'twilio' && config.publicBaseUrl && !process.env.TWILIO_AUTH_TOKEN) {
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
