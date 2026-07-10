import { Router } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { log } from "../logger.js";
import { emitWitnextEvent, witnextEnabled } from "../integrations/witnext.js";
import { recordFailedJob } from "../jobs/deadletter.js";

/**
 * Dialpad inbound webhooks (experimental, flag-gated on DIALPAD_WEBHOOK_SECRET).
 *
 * WIT Connect's broker role for the WiTNext plan: Dialpad → WIT Connect →
 * normalized signed event → WiTNext. Dialpad signs webhook payloads as an
 * HS256 JWT using the subscription's webhook secret; we REQUIRE that secret —
 * unsigned or unverifiable events are rejected. We do not become a second CRM
 * here: events are normalized and forwarded, nothing else.
 *
 * Tolerates out-of-order arrival by design: each event forwards independently
 * (call.completed may land after the transcript); WiTNext upserts by call id.
 */
export const dialpadRouter = Router();

// Dialpad event → our normalized event type. Unknown types are acknowledged
// but not forwarded (Dialpad retries on non-2xx; unknown ≠ error).
function normalizedType(body) {
  if (body?.call_recap || body?.recap) return "call.recap_available";
  if (body?.transcript || body?.transcript_url) return "call.transcript_available";
  if (body?.recording_url || body?.admin_recording_urls?.length) return "call.recording_available";
  const state = String(body?.state || body?.call_state || "").toLowerCase();
  if (["hangup", "ended", "completed"].includes(state)) return "call.completed";
  if (body?.call_id || body?.id) return "call.updated";
  return null;
}

function normalizePayload(body) {
  const callId = String(body?.call_id || body?.id || "");
  return {
    source: "dialpad",
    call_id: callId ? `dialpad:${callId}` : null,
    dialpad_call_id: callId || null,
    direction: body?.direction || null,
    external_number: body?.external_number || body?.contact?.phone || null,
    agent_identity: body?.target?.email || body?.operator?.email || null,
    started_at: body?.date_started || null,
    ended_at: body?.date_ended || null,
    duration_seconds: body?.duration ? Math.round(Number(body.duration) / 1000) || null : null,
    recording_reference: body?.recording_url || body?.admin_recording_urls?.[0] || null,
    recap: body?.call_recap || body?.recap || null,
    transcript_reference: body?.transcript_url || null,
  };
}

dialpadRouter.post("/dialpad/events", (req, res) => {
  if (!config.dialpad.enabled) return res.status(404).json({ error: "not found" });

  // Dialpad delivers the event as a JWT string body when a secret is set.
  // Accept either a raw JWT (text/plain) or {jwt: "..."} / already-parsed JSON
  // carrying a JWT — verify before trusting anything.
  let event = null;
  const raw =
    typeof req.body === "string"
      ? req.body.trim()
      : req.body?.jwt || (typeof req.body?.payload === "string" ? req.body.payload : null);
  if (raw && raw.split(".").length === 3) {
    try {
      event = jwt.verify(raw, config.dialpad.webhookSecret, { algorithms: ["HS256"] });
    } catch (err) {
      log.warn("dialpad.bad_signature", { err: err.message });
      return res.status(403).json({ error: "invalid signature" });
    }
  } else {
    // No verifiable JWT → reject. We never ingest unsigned call data.
    return res.status(403).json({ error: "signed JWT payload required" });
  }

  const type = normalizedType(event);
  if (!type) {
    log.info("dialpad.event_ignored", { keys: Object.keys(event || {}).slice(0, 8) });
    return res.sendStatus(204); // acknowledged, not forwarded
  }

  if (witnextEnabled()) {
    emitWitnextEvent(type, normalizePayload(event), {
      occurredAt: event?.date_ended || event?.date_started || undefined,
      recordFailedJob,
    });
  }
  log.info("dialpad.event_forwarded", { type, witnext: witnextEnabled() });
  res.sendStatus(204);
});
