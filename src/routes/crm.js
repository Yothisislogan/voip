import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import * as crm from "../store/crm.js";

/**
 * Authenticated CRM API over the Postgres store. All routes require a full
 * session. Returns 503 when the database isn't configured.
 */
export const crmRouter = Router();

crmRouter.use("/api/crm", requireAuth, (req, res, next) => {
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
  res.json({ contact, calls });
});

// Editing CRM data requires at least the agent role; viewers are read-only.
crmRouter.patch("/api/crm/contacts/:id", requireRole("agent"), async (req, res) => {
  const contact = await crm.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: "contact not found" });
  const updated = await crm.updateContactFields(contact.id, req.body || {});
  // updateContactFields returns null when no whitelisted field changed.
  res.json({ contact: updated || contact });
});

// ── calls ──
crmRouter.get("/api/crm/calls", async (req, res) => {
  const calls = await crm.listCalls({ contactId: req.query.contactId, limit: req.query.limit });
  res.json({ calls });
});

crmRouter.get("/api/crm/calls/:sid", async (req, res) => {
  const detail = await crm.getCallDetail(req.params.sid);
  if (!detail) return res.status(404).json({ error: "call not found" });
  res.json(detail);
});
