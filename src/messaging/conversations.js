/**
 * In-memory conversation registry + inbound normalization for the messaging
 * channel. Mirrors the voice-side session/transcript stores: process-local,
 * back with Redis for multi-instance.
 *
 * A "conversation" is one customer thread (SMS today, Apple Messages for
 * Business later) identified by the provider's conversation id.
 */

const MAX_MESSAGES = 500;

export class ConversationStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.byId = new Map();
  }

  upsert(conversationId, init = {}) {
    let convo = this.byId.get(conversationId);
    if (!convo) {
      convo = {
        conversationId,
        channel: init.channel || "sms",
        customerRef: init.customerRef || null, // phone (SMS) or opaque id (AMB)
        customerPhone: init.customerPhone || null,
        contact: null,
        agentIdentity: init.agentIdentity || null,
        messages: [],
        createdAt: init.at || 0,
        lastAt: init.at || 0,
      };
      this.byId.set(conversationId, convo);
    }
    // Fill in any newly-known fields without clobbering existing values.
    if (init.channel) convo.channel = init.channel;
    if (init.customerRef && !convo.customerRef) convo.customerRef = init.customerRef;
    if (init.customerPhone && !convo.customerPhone) convo.customerPhone = init.customerPhone;
    if (init.agentIdentity) convo.agentIdentity = init.agentIdentity;
    return convo;
  }

  get(conversationId) {
    return this.byId.get(conversationId) || null;
  }

  setContact(conversationId, contact) {
    const c = this.byId.get(conversationId);
    if (c) c.contact = contact;
  }

  addMessage(conversationId, from, text, at = 0) {
    const c = this.byId.get(conversationId);
    if (!c) return null;
    const msg = { from, text, at };
    c.messages.push(msg);
    if (c.messages.length > MAX_MESSAGES) c.messages.shift();
    c.lastAt = at || c.lastAt;
    return msg;
  }

  /** Active conversations assigned to an agent, newest activity first. */
  listForAgent(identity) {
    return [...this.byId.values()]
      .filter((c) => c.agentIdentity === identity)
      .sort((a, b) => b.lastAt - a.lastAt);
  }
}

export const conversations = new ConversationStore();

const E164 = /^\+?[1-9]\d{6,15}$/;

/**
 * Normalize a Twilio Conversations webhook (form-encoded body) into our channel-
 * agnostic shape, or null when the event isn't an inbound customer message
 * (wrong event type, or our own outbound echo).
 *
 * Pure: callers inject `businessAuthor` and the set of known `agentIdentities`
 * so we can tell customer messages from our own.
 */
export function normalizeTwilioConversations(body, { businessAuthor, agentIdentities } = {}) {
  if (!body || body.EventType !== "onMessageAdded") return null;

  const author = body.Author || "";
  const source = body.Source || ""; // "SMS" | "WHATSAPP" | "API" | ...
  const text = body.Body || "";

  // Messages we sent via the API (Source=API) or authored by us/an agent are echoes.
  const known = agentIdentities instanceof Set ? agentIdentities : new Set(agentIdentities || []);
  const isOurs = source === "API" || author === businessAuthor || known.has(author);
  if (isOurs) return null;

  const customerPhone = E164.test(author) ? (author.startsWith("+") ? author : `+${author}`) : null;
  return {
    provider: "twilio_conversations",
    channel: (source || "sms").toLowerCase(),
    conversationId: body.ConversationSid,
    customerRef: author,
    customerPhone,
    text,
    messageSid: body.MessageSid || null,
  };
}
