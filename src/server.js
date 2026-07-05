import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

import { config } from "./config.js";
import { validateEnv } from "./validate-env.js";
import { db } from "./db.js";
import { log, requestId } from "./logger.js";
import { tokenRouter } from "./routes/token.js";
import { voiceRouter } from "./routes/voice.js";
import { recordingRouter } from "./routes/recording.js";
import { authRouter } from "./routes/auth.js";
import { aiRouter } from "./routes/ai.js";
import { messagingRouter, messagingWebhookRouter } from "./routes/messaging.js";
import { emailRouter } from "./routes/email.js";
import { crmRouter } from "./routes/crm.js";
import { pageGate } from "./auth/middleware.js";
import { attachAgentWss } from "./realtime/ws.js";
import { securityHeaders } from "./middleware/security.js";
import { ensureCsrfCookie } from "./middleware/csrf.js";
import { authLimiter, apiLimiter, webhookLimiter } from "./middleware/rateLimit.js";

// Fail fast on bad/insecure config in production (before we bind a port).
validateEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.disable("x-powered-by");

// Correlation id + structured access logging on every request.
app.use(requestId);

// Security response headers (CSP, HSTS on https, nosniff, frame-deny, …).
app.use(securityHeaders);

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

// Plant the double-submit CSRF cookie so browser pages can echo it back.
app.use(ensureCsrfCookie);

// ── Liveness + readiness ──
// /health: process is up (never touches the DB). /ready: dependencies are
// reachable — returns 503 (fail closed) so a load balancer can drain us.
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ready", async (_req, res) => {
  if (!db.enabled) return res.json({ ok: true, db: "disabled" });
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch (err) {
    res.status(503).json({ ok: false, db: "down", error: err.message });
  }
});

// Authentication (Google OAuth + Twilio Verify 2FA) — login flow is public.
// Rate-limited hard on the auth paths: this is the credential-stuffing /
// OTP-brute surface. (Path-scoped so the limit doesn't apply app-wide.)
app.use(["/auth", "/2fa", "/logout"], authLimiter);
app.use(authRouter);
app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/2fa", (_req, res) => res.sendFile(path.join(publicDir, "2fa.html")));

// Gate the app pages: an authenticated "full" session is required, otherwise
// redirect to /login. The login + 2FA pages are served by static, ungated.
const PROTECTED_PAGES = new Set(["/", "/index.html", "/softphone.html", "/agent.html", "/contacts.html", "/call.html"]);
app.use((req, res, next) => {
  if (PROTECTED_PAGES.has(req.path)) return pageGate(req, res, next);
  next();
});

app.use(express.static(publicDir));

// Validate X-Twilio-Signature on all webhook routes.
// Twilio signs against the exact public URL it was configured with, so we must
// reconstruct that URL to match. twilio.webhook() expects `host` (and optional
// `protocol`) SEPARATELY — passing a full scheme-qualified URL as `host` yields
// a doubled scheme (https://https://…) and rejects every real webhook. Split
// PUBLIC_BASE_URL into protocol + host so the reconstructed URL is correct.
// TODO(prod): remove the config.publicBaseUrl guard once PUBLIC_BASE_URL is always set.
const twilioWebhook = (() => {
  if (!config.publicBaseUrl) {
    return (_req, _res, next) => next(); // dev-only bypass when no public URL is set
  }
  const pub = new URL(config.publicBaseUrl);
  return twilio.webhook({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    protocol: pub.protocol.replace(/:$/, ""), // "https:" -> "https"
    host: pub.host, // hostname[:port], no scheme
  });
})();

// Authenticated app API — general per-IP rate limit.
app.use(apiLimiter, tokenRouter);
app.use(apiLimiter, aiRouter);
app.use(apiLimiter, crmRouter); // authenticated CRM API (requireAuth + CSRF inside)
app.use(apiLimiter, messagingRouter); // agent send + conversation list (requireAuth + CSRF inside)

// Webhooks — separate, looser budget (providers can burst). Twilio routes are
// additionally signature-validated; email intake uses an optional shared token.
app.use(webhookLimiter, emailRouter); // inbound email intake webhook (optional token)
app.use(webhookLimiter, twilioWebhook, voiceRouter);
app.use(webhookLimiter, twilioWebhook, recordingRouter);
app.use(webhookLimiter, twilioWebhook, messagingWebhookRouter); // provider inbound webhook (signed)

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
