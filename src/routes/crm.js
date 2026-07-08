import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { csrfProtect } from "../middleware/csrf.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { audit, listAudit } from "../audit.js";
import { getConsentForCall } from "../store/consent.js";
import * as crm from "../store/crm.js";
import * as tracker from "../store/tracker.js";

/**
 * Authenticated CRM API over the Postgres store. All routes require a full
 * session (viewer role or above). Writes require the agent role and a valid
 * CSRF token. Returns 503 when the database isn't configured.
 */
export const crmRouter = Router();

// ── public case tracker ─────────────────────────────────────────────
// Customer-facing smart links are token-only and return a deliberately tiny,
// safe payload: no internal notes, transcript, call data, contact id, or PII.
// Unauthenticated surface → its own tight rate bucket + never cached (a shared
// proxy must not serve one customer's status to another request).
crmRouter.get("/api/public/tracker/:token", rateLimit("public-tracker", 60), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!crm.crmDbEnabled) return res.status(503).json({ error: "tracker database not configured" });
  const payload = await tracker.getPublicTracker(req.params.token);
  if (!payload) return res.status(404).json({ error: "tracker not found" });
  res.json(payload);
});

crmRouter.use("/api/crm", requireAuth, requireRole("viewer"), csrfProtect, (req, res, next) => {
  if (!crm.crmDbEnabled) return res.status(503).json({ error: "CRM database not configured" });
  next();
});

// ── contacts ──
crmRouter.get("/api/crm/contacts", async (req, res) => {
  const contacts = await crm.listContacts({
    q: req.query.q,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ contacts });
});

crmRouter.get("/api/crm/contacts/:id", async (req, res) => {
  const contact = await crm.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: "contact not found" });
  const calls = await crm.listCalls({ contactId: contact.id });
  // Viewing a contact record touches PII — record who looked.
  audit({ req, action: "contact.view", entityType: "contact", entityId: contact.id });
  res.json({ contact, calls });
});

// Editing CRM data requires at least the agent role; viewers are read-only.
crmRouter.patch("/api/crm/contacts/:id", requireRole("agent"), async (req, res) => {
  const contact = await crm.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: "contact not found" });
  const updated = await crm.updateContactFields(contact.id, req.body || {});
  // updateContactFields returns null when no whitelisted field changed.
  audit({
    req,
    action: "contact.update",
    entityType: "contact",
    entityId: contact.id,
    detail: { fields: Object.keys(req.body || {}) },
  });
  res.json({ contact: updated || contact });
});

// ── customer-facing case tracker smart links ──
crmRouter.get("/api/crm/contacts/:id/tracker", async (req, res) => {
  const contact = await crm.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: "contact not found" });
  const current = await tracker.getTrackerForContact(contact.id);
  audit({ req, action: "tracker.view", entityType: "contact", entityId: contact.id });
  res.json({ tracker: current, statusOptions: tracker.trackerStatusOptions() });
});

crmRouter.post("/api/crm/contacts/:id/tracker", requireRole("agent"), async (req, res) => {
  const contact = await crm.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: "contact not found" });
  const created = await tracker.createTrackerForContact(contact.id, {
    publicTitle: req.body?.public_title,
    status: req.body?.status,
    publicNote: req.body?.public_note,
    expiresAt: req.body?.expires_at,
    actorIdentity: req.agent?.identity,
  });
  if (!created) return res.status(500).json({ error: "tracker could not be created" });
  audit({
    req,
    action: "tracker.create",
    entityType: "contact",
    entityId: contact.id,
    detail: { trackerId: created.id, status: created.status },
  });
  res.status(201).json({ tracker: created, statusOptions: tracker.trackerStatusOptions() });
});

const TRACKER_PATCH_FIELDS = ["public_title", "status", "public_note", "show_agent_name", "is_active", "expires_at"];
crmRouter.patch("/api/crm/trackers/:id", requireRole("agent"), async (req, res) => {
  const body = req.body || {};
  if (!TRACKER_PATCH_FIELDS.some((f) => body[f] !== undefined)) {
    return res.status(400).json({ error: `no updatable fields (${TRACKER_PATCH_FIELDS.join(", ")})` });
  }
  const updated = await tracker.updateTracker(req.params.id, body, req.agent?.identity);
  if (!updated) return res.status(404).json({ error: "tracker not found" });
  audit({
    req,
    action: "tracker.update",
    entityType: "tracker",
    entityId: updated.id,
    detail: { status: updated.status, fields: Object.keys(req.body || {}) },
  });
  res.json({ tracker: updated, statusOptions: tracker.trackerStatusOptions() });
});

crmRouter.post("/api/crm/trackers/:id/revoke", requireRole("agent"), async (req, res) => {
  const updated = await tracker.revokeTracker(req.params.id, req.agent?.identity);
  if (!updated) return res.status(404).json({ error: "tracker not found" });
  audit({ req, action: "tracker.revoke", entityType: "tracker", entityId: updated.id });
  res.json({ tracker: updated });
});

// ── calls ──
crmRouter.get("/api/crm/calls", async (req, res) => {
  const calls = await crm.listCalls({ contactId: req.query.contactId, limit: req.query.limit });
  res.json({ calls });
});

crmRouter.get("/api/crm/calls/:sid", async (req, res) => {
  const detail = await crm.getCallDetail(req.params.sid);
  if (!detail) return res.status(404).json({ error: "call not found" });
  // Include consent/recording state + history for compliance visibility.
  const consent = await getConsentForCall(req.params.sid);
  audit({ req, action: "call.view", entityType: "call", entityId: req.params.sid });
  res.json({ ...detail, consent });
});

// ── audit log (admin only) ──
crmRouter.get("/api/crm/audit", requireRole("admin"), async (req, res) => {
  const entries = await listAudit({
    limit: req.query.limit,
    actor: req.query.actor,
    action: req.query.action,
    entityId: req.query.entityId,
  });
  res.json({ entries });
});
