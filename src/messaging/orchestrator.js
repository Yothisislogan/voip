import { config } from "../config.js";
import { conversations, normalizeTwilioConversations } from "./conversations.js";
import { sendOutbound } from "./providers.js";
import { findContactByPhone, logChatMessage } from "../crm/erpnext.js";
import { publishToAgent } from "../realtime/bus.js";

/**
 * Ties an inbound message provider to the agent's screen + ERPNext, mirroring
 * the voice orchestrator. Everything is best-effort and self-contained.
 */

// Known agent identities (so inbound normalization can ignore our own echoes).
function agentIdentities() {
  return new Set((config.auth.agents || []).map((a) => a.identity).filter(Boolean));
}

/** Lightweight conversation view for the agent UI (no internal fields). */
export function viewConversation(c) {
  if (!c) return null;
  return {
    conversationId: c.conversationId,
    channel: c.channel,
    customerRef: c.customerRef,
    customerPhone: c.customerPhone,
    contact: c.contact,
    messages: c.messages,
    lastAt: c.lastAt,
  };
}

/**
 * Handle a raw provider webhook body: normalize, buffer, screen-pop, push to the
 * agent, and log to ERPNext. Returns the normalized message (or null if ignored).
 */
export async function handleInbound(body, now = Date.now()) {
  const msg = normalizeTwilioConversations(body, {
    businessAuthor: config.messaging.businessAuthor,
    agentIdentities: agentIdentities(),
  });
  if (!msg) return null;

  // Route to the default agent (MVP — replace with queue/routing later).
  const agentIdentity = config.defaultAgentIdentity;
  const convo = conversations.upsert(msg.conversationId, {
    channel: msg.channel,
    customerRef: msg.customerRef,
    customerPhone: msg.customerPhone,
    agentIdentity,
    at: now,
  });
  conversations.addMessage(msg.conversationId, "customer", msg.text, now);

  // Screen-pop: resolve the customer once (SMS exposes a phone; AMB does not).
  if (!convo.contact && msg.customerPhone) {
    const contact = await findContactByPhone(msg.customerPhone);
    conversations.setContact(msg.conversationId, contact);
  }

  publishToAgent(agentIdentity, "message", {
    conversationId: msg.conversationId,
    channel: msg.channel,
    from: "customer",
    text: msg.text,
    customerRef: msg.customerRef,
    contact: convo.contact,
  });

  // Log to the customer's CRM timeline (best-effort).
  logChatMessage({
    contact: convo.contact,
    subject: `${msg.channel.toUpperCase()} from ${msg.customerRef}`,
    content: msg.text,
    direction: "Received",
  }).catch(() => {});

  return msg;
}

/**
 * Agent reply: persist, send via the provider, log, and echo to the agent's
 * other tabs. `agentIdentity` comes from the authenticated session. Returns true
 * if the message was sent.
 */
export async function sendReply({ agentIdentity, conversationId, text }, now = Date.now()) {
  const convo = conversations.get(conversationId);
  if (!convo || !text?.trim()) return false;
  // Only the assigned agent may reply on this conversation.
  if (convo.agentIdentity && convo.agentIdentity !== agentIdentity) return false;

  conversations.addMessage(conversationId, "agent", text, now);

  const ok = await sendOutbound({
    conversationId,
    channel: convo.channel,
    customerRef: convo.customerRef,
    text,
  });

  logChatMessage({
    contact: convo.contact,
    subject: `${convo.channel.toUpperCase()} to ${convo.customerRef}`,
    content: text,
    direction: "Sent",
  }).catch(() => {});

  publishToAgent(agentIdentity, "message", {
    conversationId,
    channel: convo.channel,
    from: "agent",
    text,
  });

  return ok;
}
