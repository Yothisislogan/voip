import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { db } from '../db.js';
import { enqueueJob } from '../jobs/queue.js';

/**
 * WiTNext CRM bridge — WIT Connect's broker role. Normalized events are
 * HMAC-signed and POSTed to WiTNext's integration API per the WiTNext plan §8:
 *
 *   envelope: { event_id, event_type, provider, occurred_at, sent_at, nonce, payload }
 *   signature = HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${event_id}\n${rawBody}`)
 *
 * Headers: X-WIT-Event-Id, X-WIT-Timestamp (unix seconds), X-WIT-Nonce,
 * X-WIT-Signature (hex), X-WIT-Integration-Id. Verify the RAW body before
 * parsing; reject stale requests, reused nonces, oversized payloads and unknown
 * types. Repeated event IDs are idempotently acknowledged after verification.
 *
 * Delivery semantics: the event_id is generated ONCE (at emit time) and reused
 * on every retry, so WiTNext can dedupe; timestamp/nonce/signature are fresh
 * per attempt so replay protection still holds. emitWitnextEvent persists the
 * delivery intent; the service worker retries failed delivery with backoff.
 */

export const CALL_EVENT_TYPES = new Set([
  "call.completed",
  "call.recap_available",
  "call.transcript_available",
  "call.recording_available",
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
      "X-WIT-Integration-Id": config.witnext.integrationId || '',
      "X-WIT-Event-Id": id,
      "X-WIT-Timestamp": String(timestamp),
      "X-WIT-Nonce": nonce,
      "X-WIT-Signature": signature,
    },
  };
}

/**
 * Deliver one event to WiTNext. Returns event_id on 2xx only. Throws on
 * non-2xx (including nonce replay 409) so the worker can retry. No-ops (returns null) when the bridge is off.
 *
 * Pass a stable `eventId` when retrying so WiTNext dedupes correctly.
 */
export async function sendWitnextEvent(eventType, payload, { eventId, occurredAt } = {}) {
  if (!witnextEnabled()) return null;
  if (!config.witnext.integrationId) throw new Error('WITNEXT_INTEGRATION_ID is required by WiTnext');

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
      redirect: 'error',
    });
    // WiTnext acknowledges duplicates with 200. A 409 means nonce replay,
    // not delivery: treating it as success silently discards an event.
    if (!res.ok) {
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
 * Await before acknowledging provider input: stores a stable event ID and
 * delivery payload in the durable outbox, optionally in the caller transaction.
 */
export async function emitWitnextEvent(eventType, payload, { occurredAt, recordFailedJob, eventId, connection } = {}) {
  if (!witnextEnabled()) return;
  if (!CALL_EVENT_TYPES.has(eventType) && eventType !== 'email.lead_received') throw new Error(`Unsupported WiTnext event: ${eventType}`);
  eventId ||= stableEventId(eventType, payload);
  payload = normalizeBridgePayload(payload);
  if (db.enabled) {
    await enqueueJob('witnextEvent', eventId, { eventType, payload, eventId, occurredAt: occurredAt || new Date().toISOString() }, { connection });
    return eventId;
  }
  // Explicit development fallback. Production validation requires storage.
  return sendWitnextEvent(eventType, payload, { eventId, occurredAt }).catch(async (err) => {
    log.warn("witnext.event_queued_for_retry", { eventType, eventId, err: err.message });
    if (recordFailedJob) {
      await recordFailedJob({
        kind: "witnextEvent",
        payload: { eventType, payload, eventId, occurredAt: occurredAt || new Date().toISOString() },
        error: err.message,
      });
    }
    throw err;
  });
}

export function stableEventId(type, payload) {
  return `wit:${type}:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

// WiTnext's Zod contracts accept absent optional values, but reject null.
// Its recap consumer expects action_items, not the local nextSteps spelling.
export function normalizeBridgePayload(payload) {
  const out = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null && v !== undefined));
  if (out.recap?.nextSteps && !out.recap.action_items) out.recap = { ...out.recap, action_items: out.recap.nextSteps };
  if (out.extracted) out.extracted = Object.fromEntries(Object.entries(out.extracted).filter(([, v]) => v != null));
  return out;
}
