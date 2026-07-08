import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

export const TRACKER_STATUSES = [
  "request_received",
  "need_more_information",
  "submitted",
  "waiting_underwriting",
  "quote_delivered",
  "ready_to_bind",
  "complete",
  "paused",
  "closed",
  "declined",
  "cancelled",
];

const STATUS_LABELS = {
  request_received: "Request received",
  need_more_information: "Need more information",
  submitted: "Submitted / in review",
  waiting_underwriting: "Waiting on underwriting",
  quote_delivered: "Quote delivered",
  ready_to_bind: "Ready to bind",
  complete: "Complete",
  paused: "Paused",
  closed: "Closed",
  declined: "Declined",
  cancelled: "Cancelled",
};

const STEP_ORDER = [
  "request_received",
  "need_more_information",
  "submitted",
  "waiting_underwriting",
  "quote_delivered",
  "ready_to_bind",
  "complete",
];

function cleanText(value, max = 1000) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function normalizeStatus(status) {
  const s = String(status || "request_received").trim().toLowerCase();
  return TRACKER_STATUSES.includes(s) ? s : "request_received";
}

// User-supplied expiry → ISO timestamp or null. Invalid dates become null
// (no expiry) instead of bubbling a Postgres cast error up as a 500.
function cleanTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

let warnedDevSecret = false;
function trackerSecret() {
  // Prefer a dedicated secret; otherwise DERIVE a purpose-specific key from
  // SESSION_SECRET (never use it raw — the session-JWT key and the link-signing
  // key must not be interchangeable). Production validation already requires
  // SESSION_SECRET, so the hardcoded value only ever signs local dev links —
  // warn loudly so it is never mistaken for a real secret.
  if (process.env.TRACKER_LINK_SECRET) return process.env.TRACKER_LINK_SECRET;
  if (config.auth?.sessionSecret) {
    return crypto.createHmac("sha256", config.auth.sessionSecret).update("wit-tracker-link-v1").digest();
  }
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn("⚠️  Tracker links are signed with the DEV fallback secret — anyone can forge them. Set SESSION_SECRET (or TRACKER_LINK_SECRET).");
  }
  return "wit-connect-dev-tracker-secret";
}

export function signTrackerId(id) {
  const payload = Buffer.from(String(id)).toString("base64url");
  const sig = crypto.createHmac("sha256", trackerSecret()).update(payload).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifyTrackerToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", trackerSecret()).update(payload).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const id = Number(Buffer.from(payload, "base64url").toString("utf8"));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function randomNonceHash() {
  return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

function trackerUrlForId(id) {
  const base = (config.publicBaseUrl || "").replace(/\/$/, "");
  return `${base || ""}/t/${encodeURIComponent(signTrackerId(id))}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function publicSteps(status) {
  const currentIdx = STEP_ORDER.indexOf(status);
  const safeIdx = currentIdx >= 0 ? currentIdx : 0;
  return STEP_ORDER.map((key, idx) => ({
    key,
    label: statusLabel(key),
    complete: idx < safeIdx || status === "complete",
    current: idx === safeIdx && status !== "complete",
  }));
}

function shapeTracker(row, events = []) {
  if (!row) return null;
  return {
    ...row,
    status_label: statusLabel(row.status),
    url: trackerUrlForId(row.id),
    events,
  };
}

async function recordEvent(trackerId, { status, publicNote, actorIdentity, eventType = "status_update" } = {}) {
  if (!db.enabled || !trackerId) return;
  try {
    await db.query(
      `INSERT INTO case_tracker_events (tracker_id, status, public_note, actor_identity, event_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [trackerId, normalizeStatus(status), cleanText(publicNote), actorIdentity || null, eventType]
    );
  } catch (err) {
    console.error("recordTrackerEvent failed:", err.message);
  }
}

export async function getTrackerForContact(contactId) {
  if (!db.enabled || !contactId) return null;
  try {
    const tracker = (
      await db.query(
        `SELECT * FROM case_tracker_links
          WHERE contact_id = $1
          ORDER BY is_active DESC, updated_at DESC
          LIMIT 1`,
        [contactId]
      )
    ).rows[0] || null;
    if (!tracker) return null;
    const events = (
      await db.query(
        `SELECT status, public_note, actor_identity, event_type, created_at
           FROM case_tracker_events
          WHERE tracker_id = $1
          ORDER BY created_at DESC
          LIMIT 25`,
        [tracker.id]
      )
    ).rows;
    return shapeTracker(tracker, events);
  } catch (err) {
    console.error("getTrackerForContact failed:", err.message);
    return null;
  }
}

export async function createTrackerForContact(contactId, { publicTitle, status, publicNote, actorIdentity, expiresAt } = {}) {
  if (!db.enabled || !contactId) return null;
  const safeStatus = normalizeStatus(status);
  const title = cleanText(publicTitle, 160) || "Your insurance request";
  const note = cleanText(publicNote);
  try {
    await db.query("UPDATE case_tracker_links SET is_active = false, updated_at = now() WHERE contact_id = $1 AND is_active = true", [contactId]);
    const r = await db.query(
      `INSERT INTO case_tracker_links
         (contact_id, token_hash, public_title, status, public_note, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [contactId, randomNonceHash(), title, safeStatus, note, cleanTimestamp(expiresAt), actorIdentity || null]
    );
    const row = r.rows[0] || null;
    if (!row) return null;
    await recordEvent(row.id, { status: safeStatus, publicNote: note, actorIdentity, eventType: "created" });
    return shapeTracker(row, []);
  } catch (err) {
    console.error("createTrackerForContact failed:", err.message);
    return null;
  }
}

export async function updateTracker(trackerId, fields = {}, actorIdentity) {
  if (!db.enabled || !trackerId) return null;
  const updates = [];
  const params = [trackerId];

  function set(col, value) {
    params.push(value);
    updates.push(`${col} = $${params.length}`);
  }

  if (fields.public_title !== undefined) set("public_title", cleanText(fields.public_title, 160) || "Your insurance request");
  if (fields.status !== undefined) set("status", normalizeStatus(fields.status));
  if (fields.public_note !== undefined) set("public_note", cleanText(fields.public_note));
  if (fields.show_agent_name !== undefined) set("show_agent_name", Boolean(fields.show_agent_name));
  if (fields.is_active !== undefined) set("is_active", Boolean(fields.is_active));
  if (fields.expires_at !== undefined) set("expires_at", cleanTimestamp(fields.expires_at));

  if (!updates.length) return null;
  updates.push("updated_at = now()");

  try {
    const r = await db.query(
      `UPDATE case_tracker_links SET ${updates.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    const row = r.rows[0] || null;
    if (!row) return null;
    await recordEvent(row.id, {
      status: row.status,
      publicNote: row.public_note,
      actorIdentity,
      eventType: fields.is_active === false ? "revoked" : "status_update",
    });
    return shapeTracker(row);
  } catch (err) {
    console.error("updateTracker failed:", err.message);
    return null;
  }
}

export async function revokeTracker(trackerId, actorIdentity) {
  return updateTracker(trackerId, { is_active: false }, actorIdentity);
}

export async function getPublicTracker(token) {
  if (!db.enabled || !token) return null;
  try {
    const trackerId = verifyTrackerToken(token);
    if (!trackerId) return null;
    const tracker = (
      await db.query(
        `SELECT id, public_title, status, public_note, is_active, expires_at, updated_at, created_at
           FROM case_tracker_links
          WHERE id = $1
            AND is_active = true
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`,
        [trackerId]
      )
    ).rows[0] || null;
    if (!tracker) return null;
    return {
      title: tracker.public_title,
      status: tracker.status,
      status_label: statusLabel(tracker.status),
      public_note: tracker.public_note,
      last_updated: tracker.updated_at,
      created_at: tracker.created_at,
      steps: publicSteps(tracker.status),
    };
  } catch (err) {
    console.error("getPublicTracker failed:", err.message);
    return null;
  }
}

export function trackerStatusOptions() {
  return TRACKER_STATUSES.map((key) => ({ key, label: statusLabel(key) }));
}
