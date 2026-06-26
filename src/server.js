import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

import { config } from "./config.js";
import { tokenRouter } from "./routes/token.js";
import { voiceRouter } from "./routes/voice.js";
import { recordingRouter } from "./routes/recording.js";
import { authRouter } from "./routes/auth.js";
import { aiRouter } from "./routes/ai.js";
import { messagingRouter, messagingWebhookRouter } from "./routes/messaging.js";
import { pageGate } from "./auth/middleware.js";
import { attachAgentWss } from "./realtime/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();

// Restrictive CORS with credentials. Same-origin requests don't hit CORS at
// all; only the configured origins may make cross-origin authenticated calls.
app.use(
  cors({
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    credentials: true,
  })
);
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Authentication (Google OAuth + Twilio Verify 2FA) — login flow is public.
app.use(authRouter);
app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/2fa", (_req, res) => res.sendFile(path.join(publicDir, "2fa.html")));

// Gate the app pages: an authenticated "full" session is required, otherwise
// redirect to /login. The login + 2FA pages are served by static, ungated.
const PROTECTED_PAGES = new Set(["/", "/index.html", "/softphone.html", "/agent.html"]);
app.use((req, res, next) => {
  if (PROTECTED_PAGES.has(req.path)) return pageGate(req, res, next);
  next();
});

app.use(express.static(publicDir));

// Validate X-Twilio-Signature on all webhook routes.
// TODO(prod): remove the config.publicBaseUrl guard once PUBLIC_BASE_URL is always set.
const twilioWebhook = config.publicBaseUrl
  ? twilio.webhook({ authToken: process.env.TWILIO_AUTH_TOKEN, host: config.publicBaseUrl })
  : (_req, _res, next) => next(); // dev-only bypass when no public URL is set

app.use(tokenRouter);
app.use(aiRouter);
app.use(messagingRouter); // agent send + conversation list (requireAuth inside)
app.use(twilioWebhook, voiceRouter);
app.use(twilioWebhook, recordingRouter);
app.use(twilioWebhook, messagingWebhookRouter); // provider inbound webhook (signed)

// Single HTTP server shared by Express and the agent WebSocket channel.
const server = http.createServer(app);
attachAgentWss(server);

server.listen(config.port, () => {
  console.log(`☎️  WIT Connect telephony running on http://localhost:${config.port}`);
  console.log(`   Agent workspace: http://localhost:${config.port}/agent.html`);
  if (!config.auth.required) {
    console.log("   ⚠️  AUTH_REQUIRED=false — login is BYPASSED (dev only). Never use in production.");
  } else if (!config.auth.sessionSecret) {
    console.log("   ⚠️  SESSION_SECRET is not set — login cannot issue sessions. Set it before use.");
  }
  if (!config.publicBaseUrl) {
    console.log("   ⚠️  PUBLIC_BASE_URL is empty — webhooks/recordings/transcription need a public URL (use ngrok).");
  }
});
