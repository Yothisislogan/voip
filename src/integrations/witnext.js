import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * WiTNext CRM bridge — WIT Connect's broker role. Normalized events are
 * HMAC-signed and POSTed to WiTNext's integration API per the WiTNext plan §8:
 *
 *   envelope: { event_id, event_type, provider, occurred_at, sent_at, nonce, payload }
 *   signature = HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${event_id}\n${rawBody}`)
 *
 * Headers: X-WIT-Event-Id, X-WIT-Timestamp (unix seconds), X-WIT-Nonce,
 * X-WIT-Signature (hex). The receiver must verify against the RAW body before
 * parsing, reject requests older than 5 minutes, reused nonces, repeated
 * event ids, oversized payloads, and unknown event types.
 *
 * Delivery semantics: the event_id is generated ONCE (at emit time) and reused
 * on every retry, so WiTNext can dedupe; timestamp/nonce/signature are fresh
 * per attempt so replay protection still holds. Failures throw — callers wrap
 * in runTracked() so undelivered events land in the DLQ and retry with backoff.
 */

export const CALL_EVENT_TYPES = new Set([
  "call.completed",
  "call.recap_available",
  "call.transcript_available",
  "call.recording_available",
  "call.updated",
]);

export function witnextEnabled() {
  return config.witnext.enabled;
}

/** Compute the signature for a prepared request. Exported for tests + docs. */
export function signWitnextRequest({ secret, timestamp, nonce, eventId, rawBody }) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${eventId}\n${rawBody}`)
    .digest("hex");
}

/**
 * Reference receiver-side verifier (copy into WiTNext). Checks signature
 * (timing-safe) and freshness; nonce/event-id replay tracking is the
 * receiver's job (it needs storage).
 */
export function verifyWitnextRequest({ secret, timestamp, nonce, eventId, rawBody, signature, maxAgeSec = 300, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!secret || !timestamp || !nonce || !eventId || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxAgeSec) return false; // stale or future-dated
  const expected = signWitnextRequest({ secret, timestamp, nonce, eventId, rawBody });
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Build the signed request parts for one delivery attempt. */
export function buildSignedEvent({ eventType, payload, eventId, occurredAt, provider = "wit_connect" }) {
  const id = eventId || randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({
    event_id: id,
    event_type: eventType,
    provider,
    occurred_at: occurredAt || new Date().toISOString(),
    sent_at: new Date().toISOString(),
    nonce,
    payload,
  });
  const signature = signWitnextRequest({ secret: config.witnext.secret, timestamp, nonce, eventId: id, rawBody: body });
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-WIT-Event-Id": id,
      "X-WIT-Timestamp": String(timestamp),
      "X-WIT-Nonce": nonce,
      "X-WIT-Signature": signature,
    },
  };
}

/**
 * Deliver one event to WiTNext. Returns the event_id on success (2xx, or 409 =
 * already processed — idempotent success). Throws on any other outcome so the
 * DLQ can capture and retry. No-ops (returns null) when the bridge is off.
 *
 * Pass a stable `eventId` when retrying so WiTNext dedupes correctly.
 */
export async function sendWitnextEvent(eventType, payload, { eventId, occurredAt } = {}) {
  if (!witnextEnabled()) return null;

  const path = eventType.startsWith("email.") ? config.witnext.emailEventsPath : config.witnext.callEventsPath;
  const { body, headers } = buildSignedEvent({ eventType, payload, eventId, occurredAt });
  const id = headers["X-WIT-Event-Id"];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.witnext.timeoutMs);
  try {
    const res = await fetch(`${config.witnext.url}${path}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // 409 = WiTNext already processed this event_id → treat as delivered.
    if (!res.ok && res.status !== 409) {
      throw new Error(`WiTNext responded ${res.status} for ${eventType}`);
    }
    log.info("witnext.event_sent", { eventType, eventId: id, status: res.status });
    return id;
  } catch (err) {
    const msg = err.name === "AbortError" ? "timed out" : err.message;
    // Rethrow with the event id preserved so the DLQ payload can pin it.
    const e = new Error(`witnext ${eventType} delivery failed: ${msg}`);
    e.eventId = id;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget emit used on hot paths: assigns the durable event_id up
 * front, records a DLQ job on failure that REUSES that id on retry.
 */
export function emitWitnextEvent(eventType, payload, { occurredAt, recordFailedJob } = {}) {
  if (!witnextEnabled()) return;
  const eventId = randomUUID();
  sendWitnextEvent(eventType, payload, { eventId, occurredAt }).catch((err) => {
    log.warn("witnext.event_queued_for_retry", { eventType, eventId, err: err.message });
    if (recordFailedJob) {
      recordFailedJob({
        kind: "witnextEvent",
        payload: { eventType, payload, eventId, occurredAt: occurredAt || new Date().toISOString() },
        error: err.message,
      }).catch(() => {});
    }
  });
}
