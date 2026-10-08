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
import { dialpadRouter, hydrateDialpadTranscript } from "./routes/dialpad.js";
import { crmRouter } from "./routes/crm.js";
import { adminRouter } from "./routes/admin.js";
import { telnyxRouter } from './routes/telnyx.js';
import { handleTelnyxEvent, runTelnyxStart, startTelnyxMedia, expireTelnyxSetup, stopTelnyxLeg } from './services/telnyx-voice.js';
import { phoneRouter } from './routes/phone.js';
import { runPostCall } from './services/post-call.js';
import { startWorker } from './jobs/queue.js';
import { onCallComplete, doScreenPop } from './realtime/orchestrator.js';
import { sendWitnextEvent } from './integrations/witnext.js';
import { pageGate, roleAtLeast } from "./auth/middleware.js";
import { attachAgentWss } from "./realtime/ws.js";
import { attachMediaWss } from './realtime/media.js';
import { recoverInterruptedStreams } from './realtime/transcription.js';
import { loadRevocations } from "./auth/revocation.js";
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
// Body parsers with explicit size caps — an unbounded body is a cheap DoS.
// Twilio/webhook posts and our JSON APIs are all well under 100kb.
app.use(express.urlencoded({ extended: false, limit: "100kb" })); // Twilio posts form-encoded
app.use(express.json({ limit: "100kb", verify: (req, _res, body) => { if (req.path === "/telnyx/voice") req.rawBody = Buffer.from(body); } }));

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
    await db.query('SELECT id FROM service_jobs LIMIT 1');
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

// Public, token-only customer case tracker smart links. The page itself is
// public; the JSON API returns only safe status fields and never exposes CRM PII.
app.get("/t/:token", (_req, res) => res.sendFile(path.join(publicDir, "tracker.html")));

// Gate the app pages: an authenticated "full" session is required, otherwise
// redirect to /login. The login + 2FA pages are served by static, ungated.
const PROTECTED_PAGES = new Set(["/", "/index.html", "/softphone.html", "/agent.html", "/contacts.html", "/call.html", "/phone.html"]);
app.use((req, res, next) => {
  if (PROTECTED_PAGES.has(req.path)) return pageGate(req, res, next);
  next();
});

// Admin console page — requires the admin role (falls through to static on pass).
app.get("/admin.html", pageGate, (req, res, next) => {
  if (!req.agent || !roleAtLeast(req.agent.role, "admin")) return res.redirect("/agent.html");
  next();
});

app.get('/vendor/telnyx.js', (_req, res) => res.sendFile(path.join(__dirname, '../node_modules/@telnyx/webrtc/lib/bundle.js')));
app.get('/vendor/twilio.min.js', (_req, res) => res.sendFile(path.join(__dirname, '../node_modules/@twilio/voice-sdk/dist/twilio.min.js')));
app.get('/softphone.html', (_req, res) => res.redirect('/phone.html'));
app.get(['/', '/index.html'], (_req, res) => res.redirect('/phone.html'));
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

// Rate limits are PATH-SCOPED so each request is counted exactly once in one
// bucket. (Mounting a limiter as `app.use(limiter, router)` runs it for every
// request that falls through that layer — API calls would be multi-counted and
// unmatched paths would drain the buckets.)
app.use(["/token", "/ai", "/api", "/messaging/send", "/messaging/conversations"], apiLimiter);
app.use(["/telnyx", "/voice", "/recording", "/messaging/inbound", "/email", "/dialpad", "/integrations/lead-signals"], webhookLimiter);

// Dialpad posts its JWT-signed payload as a raw text body; parse it as text on
// that path only (verified inside the route — never trusted unparsed).
app.use("/dialpad", express.text({ type: ["text/*", "application/jwt"], limit: "200kb" }));

// Twilio signature validation, scoped to exactly the Twilio webhook paths —
// unmatched routes must fall through to the 404 handler, not a signature error.
app.use(["/voice", "/recording", "/messaging/inbound"], twilioWebhook);

// Authenticated app API.
app.use(tokenRouter);
app.use(aiRouter);
app.use(crmRouter); // authenticated CRM API + public tracker API
app.use(adminRouter); // admin console API (status, DLQ, audit — admin-only inside)
app.use(phoneRouter);
app.use(messagingRouter); // agent send + conversation list (requireAuth + CSRF inside)

// Webhooks. Twilio routes are signature-validated above; email intake uses an
// optional shared token.
app.use(emailRouter);
app.use(dialpadRouter); // Dialpad → WiTNext broker (JWT-verified inside)
app.use(telnyxRouter);
if (config.voiceProvider === 'twilio') { app.use(voiceRouter); app.use(recordingRouter); }
app.use(messagingWebhookRouter);

// Uniform JSON 404 + a final error handler that never leaks stack traces.
app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, _next) => {
  if (res.headersSent) return _next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error("unhandled.error", { err: err.message, reqId: req.reqId, path: req.path });
  res.status(status).json({ error: status >= 500 ? "internal error" : err.message || "bad request" });
});

// Load persisted session revocations so a restart honors prior logouts/offboards.
loadRevocations().catch(() => {});

// Single HTTP server shared by Express and the agent WebSocket channel.
await recoverInterruptedStreams();
const server = http.createServer(app);
attachAgentWss(server);
const media = attachMediaWss(server);
const stopVoiceWorker = startWorker({ telnyxEvent: handleTelnyxEvent, telnyxStart: runTelnyxStart, telnyxMedia: startTelnyxMedia, telnyxTimeout: expireTelnyxSetup, telnyxHangup: stopTelnyxLeg }, 100);
const stopWorker = startWorker({
  recap: ({ callSid }) => onCallComplete(callSid),
  screenPop: ({ callSid }) => doScreenPop(callSid),
  dialpadTranscript: hydrateDialpadTranscript,
  postCall: runPostCall,
  witnextEvent: ({ eventType, payload, eventId, occurredAt }) => {
    if (!config.witnext.enabled) throw new Error('WiTnext bridge disabled; delivery remains pending');
    return sendWitnextEvent(eventType, payload, { eventId, occurredAt });
  },
});
process.on('SIGTERM', async () => {
  stopWorker(); stopVoiceWorker();
  const deadline = setTimeout(() => process.exit(0), 10000);
  deadline.unref();
  await media.close();
  server.close(() => db.close().then(() => process.exit(0)));
  // Active calls remain on Twilio. Unfinished jobs recover after lease expiry.
});

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
