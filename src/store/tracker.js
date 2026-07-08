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

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function trackerUrl(token) {
  const base = (config.publicBaseUrl || "").replace(/\/$/, "");
  return `${base || ""}/t/${encodeURIComponent(token)}`;
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
    return { ...tracker, status_label: statusLabel(tracker.status), events };
  } catch (err) {
    console.error("getTrackerForContact failed:", err.message);
    return null;
  }
}

export async function createTrackerForContact(contactId, { publicTitle, status, publicNote, actorIdentity, expiresAt } = {}) {
  if (!db.enabled || !contactId) return null;
  const token = makeToken();
  const tokenHash = hashToken(token);
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
      [contactId, tokenHash, title, safeStatus, note, expiresAt || null, actorIdentity || null]
    );
    const tracker = r.rows[0] || null;
    if (!tracker) return null;
    await recordEvent(tracker.id, { status: safeStatus, publicNote: note, actorIdentity, eventType: "created" });
    return { ...tracker, status_label: statusLabel(tracker.status), token, url: trackerUrl(token), events: [] };
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
  if (fields.expires_at !== undefined) set("expires_at", fields.expires_at || null);

  if (!updates.length) return null;
  updates.push("updated_at = now()");

  try {
    const r = await db.query(
      `UPDATE case_tracker_links SET ${updates.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    const tracker = r.rows[0] || null;
    if (!tracker) return null;
    await recordEvent(tracker.id, {
      status: tracker.status,
      publicNote: tracker.public_note,
      actorIdentity,
      eventType: fields.is_active === false ? "revoked" : "status_update",
    });
    return { ...tracker, status_label: statusLabel(tracker.status) };
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
    const tokenHash = hashToken(token);
    const tracker = (
      await db.query(
        `SELECT id, public_title, status, public_note, is_active, expires_at, updated_at, created_at
           FROM case_tracker_links
          WHERE token_hash = $1
            AND is_active = true
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`,
        [tokenHash]
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
