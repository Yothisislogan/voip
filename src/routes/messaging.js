import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { csrfProtect } from "../middleware/csrf.js";
import { audit } from "../audit.js";
import { runTracked } from "../jobs/deadletter.js";
import { handleInbound, sendReply, viewConversation } from "../messaging/orchestrator.js";
import { conversations } from "../messaging/conversations.js";

/**
 * Two routers:
 *  - webhook router: POST /messaging/inbound — mounted behind Twilio signature
 *    validation in server.js (provider posts here).
 *  - app router: agent send + conversation list — behind requireAuth.
 */

export const messagingWebhookRouter = Router();

messagingWebhookRouter.post("/messaging/inbound", (req, res) => {
  // Respond fast; do the routing/AI/CRM work fire-and-forget (tracked in the DLQ).
  runTracked("handleInbound", { body: req.body }, () => handleInbound(req.body));
  res.sendStatus(204);
});

export const messagingRouter = Router();

// Active conversations for the signed-in agent.
messagingRouter.get("/messaging/conversations", requireAuth, (req, res) => {
  const list = conversations.listForAgent(req.agent.identity).map(viewConversation);
  res.json({ conversations: list });
});

// Agent sends a reply on a conversation — viewers cannot send.
messagingRouter.post("/messaging/send", requireAuth, requireRole("agent"), csrfProtect, async (req, res) => {
  const { conversationId, text } = req.body || {};
  if (!conversationId || !text?.trim()) {
    return res.status(400).json({ error: "conversationId and text are required" });
  }
  const ok = await sendReply({ agentIdentity: req.agent.identity, conversationId, text });
  if (!ok) return res.status(409).json({ error: "could not send (unknown conversation or send failed)" });
  audit({ req, action: "message.send", entityType: "conversation", entityId: conversationId });
  res.json({ ok: true });
});
