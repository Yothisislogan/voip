import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { csrfProtect } from "../middleware/csrf.js";
import { audit } from "../audit.js";
import { runTracked } from "../jobs/deadletter.js";
import { handleInbound, sendReply, viewConversation } from "../messaging/orchestrator.js";
import { conversations } from "../messaging/conversations.js";
import { db } from '../db.js';
import { listConversations } from '../messaging/store.js';
import { asyncRoute } from '../util/async-route.js';

/**
 * Two routers:
 *  - webhook router: POST /messaging/inbound — mounted behind Twilio signature
 *    validation in server.js (provider posts here).
 *  - app router: agent send + conversation list — behind requireAuth.
 */

export const messagingWebhookRouter = Router();

messagingWebhookRouter.post("/messaging/inbound", asyncRoute(async (req, res) => {
  // Persist before acknowledgement so provider retries can recover DB failures.
  if (db.enabled) await handleInbound(req.body);
  else runTracked("handleInbound", { body: req.body }, () => handleInbound(req.body));
  res.sendStatus(204);
}));

export const messagingRouter = Router();

// Active conversations for the signed-in agent.
messagingRouter.get("/messaging/conversations", requireAuth, asyncRoute(async (req, res) => {
  const list = db.enabled ? await listConversations(req.agent.identity) : conversations.listForAgent(req.agent.identity).map(viewConversation);
  res.json({ conversations: list });
}));

// Agent sends a reply on a conversation — viewers cannot send.
messagingRouter.post("/messaging/send", requireAuth, requireRole("agent"), csrfProtect, asyncRoute(async (req, res) => {
  const { conversationId, text } = req.body || {};
  if (!conversationId || typeof text !== 'string' || !text.trim() || text.length > 1600) {
    return res.status(400).json({ error: "conversationId and text are required" });
  }
  const requestId = req.get('Idempotency-Key');
  if (db.enabled && (!requestId || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId))) return res.status(400).json({ error: 'Idempotency-Key required' });
  const ok = await sendReply({ agentIdentity: req.agent.identity, conversationId, text, requestId });
  if (!ok) return res.status(409).json({ error: "Send not confirmed. Check assignment, opt-out status, and provider logs before starting another send." });
  audit({ req, action: "message.send", entityType: "conversation", entityId: conversationId });
  res.json({ ok: true });
}));
