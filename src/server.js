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
import { attachAgentWss } from "./realtime/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

// Serve the browser softphone at /softphone.html
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Validate X-Twilio-Signature on all webhook routes.
// TODO(prod): remove the config.publicBaseUrl guard once PUBLIC_BASE_URL is always set.
const twilioWebhook = config.publicBaseUrl
  ? twilio.webhook({ authToken: process.env.TWILIO_AUTH_TOKEN, host: config.publicBaseUrl })
  : (_req, _res, next) => next(); // dev-only bypass when no public URL is set

app.use(tokenRouter);
app.use(twilioWebhook, voiceRouter);
app.use(twilioWebhook, recordingRouter);

// Single HTTP server shared by Express and the agent WebSocket channel.
const server = http.createServer(app);
attachAgentWss(server);

server.listen(config.port, () => {
  console.log(`\u260E\uFE0F  WIT Connect telephony running on http://localhost:${config.port}`);
  console.log(`   Softphone:       http://localhost:${config.port}/softphone.html`);
  console.log(`   Agent workspace: http://localhost:${config.port}/agent.html?identity=marisol.vega`);
  if (!config.publicBaseUrl) {
    console.log("   \u26A0\uFE0F  PUBLIC_BASE_URL is empty \u2014 webhooks/recordings/transcription need a public URL (use ngrok).");
  }
});
