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
