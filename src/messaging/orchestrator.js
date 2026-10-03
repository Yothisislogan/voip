import { config } from "../config.js";
import { conversations, normalizeTwilioConversations } from "./conversations.js";
import { sendOutbound } from "./providers.js";
import { findContactByPhone, logChatMessage } from "../crm/erpnext.js";
import * as crm from "../store/crm.js";
import { parseSurveyRating } from "../realtime/survey.js";
import { publishToAgent } from "../realtime/bus.js";
import { db } from '../db.js';
import * as messageStore from './store.js';

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
  if (!msg.conversationId || !msg.messageSid) throw new Error('ConversationSid and MessageSid required');

  // Route to the default agent (MVP — replace with queue/routing later).
  const agentIdentity = config.defaultAgentIdentity;
  if (db.enabled && !await messageStore.persistInbound(msg, agentIdentity)) return msg;
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

  // If this is a reply to an open post-call survey, record the rating.
  captureSurveyReply(msg.customerPhone, msg.text).catch(() => {});

  return msg;
}

/** Match an inbound SMS to an open survey for that customer and record it. */
async function captureSurveyReply(customerPhone, text) {
  if (!crm.crmDbEnabled || !customerPhone) return;
  const contact = await crm.getContactByPhone(customerPhone);
  if (!contact) return;
  const survey = await crm.findOpenSurveyByContact(contact.id);
  if (!survey) return;
  await crm.recordSurveyResponse({
    surveyId: survey.id,
    rating: parseSurveyRating(text),
    responseText: text,
  });
}

/**
 * Agent reply: persist, send via the provider, log, and echo to the agent's
 * other tabs. `agentIdentity` comes from the authenticated session. Returns true
 * if the message was sent.
 */
export async function sendReply({ agentIdentity, conversationId, text, requestId }, now = Date.now()) {
  const convo = db.enabled ? await messageStore.getConversation(conversationId) : conversations.get(conversationId);
  if (!convo || !text?.trim()) return false;
  // Only the assigned agent may reply on this conversation.
  if (convo.agentIdentity && convo.agentIdentity !== agentIdentity) return false;
  if (convo.optedOut) return false;
  let messageId;
  if (db.enabled) {
    const key = `send:${agentIdentity}:${requestId}`;
    const r = await db.query(`INSERT INTO conversation_messages(conversation_id,event_key,direction,body,status)
      VALUES($1,$2,'agent',$3,'sending') ON CONFLICT(event_key) DO NOTHING RETURNING id`, [conversationId, key, text]);
    if (!r.rows.length) {
      const previous = (await db.query('SELECT status,body,conversation_id FROM conversation_messages WHERE event_key=$1', [key])).rows[0];
      return previous?.status === 'accepted' && previous.body === text && previous.conversation_id === conversationId;
    }
    messageId = r.rows[0].id;
  }

  const ok = await sendOutbound({
    conversationId,
    channel: convo.channel,
    customerRef: convo.customerRef,
    text,
  });
  if (db.enabled) {
    // A timeout leaves an unknown outcome. Do not blindly resend a possibly
    // accepted SMS: the operator can inspect Twilio delivery logs first.
    await db.query('UPDATE conversation_messages SET status=$2 WHERE id=$1', [messageId, ok ? 'accepted' : 'unconfirmed']);
    await db.query('UPDATE conversations SET updated_at=now() WHERE provider_id=$1', [conversationId]);
  }
  if (!ok) return false;
  conversations.addMessage(conversationId, "agent", text, now);

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
