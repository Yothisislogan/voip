import { client as twilioClient } from "../twilio.js";
import { config } from "../config.js";

/**
 * Messaging provider adapters. The orchestrator is provider-agnostic; each
 * adapter knows how to send an outbound message on its transport. Today:
 * Twilio Conversations (SMS/WhatsApp, and Apple Messages for Business once the
 * Twilio AMB beta / an Apple-approved MSP is live). Add an MSP adapter here to
 * support a different Apple MSP without touching the rest of the app.
 */

const cfg = config.messaging;

function twilioConversationsAdapter() {
  if (!twilioClient) return null;
  const svcSid = cfg.conversationsServiceSid;
  const convos = (sid) =>
    svcSid
      ? twilioClient.conversations.v1.services(svcSid).conversations(sid)
      : twilioClient.conversations.v1.conversations(sid);

  return {
    name: "twilio_conversations",
    async send({ conversationId, text }) {
      await convos(conversationId).messages.create({
        author: cfg.businessAuthor,
        body: text,
      });
      return true;
    },
  };
}

const ADAPTERS = {
  twilio_conversations: twilioConversationsAdapter,
};

const factory = ADAPTERS[cfg.provider];
export const adapter = cfg.enabled && factory ? factory() : null;
export const messagingEnabled = Boolean(adapter);

if (!cfg.enabled) {
  console.log("💬 Messaging disabled (MESSAGING_ENABLED=false).");
} else if (!factory) {
  console.log(`💬 Messaging provider "${cfg.provider}" unknown — messaging disabled.`);
} else if (!messagingEnabled) {
  console.log(`💬 Messaging provider "${cfg.provider}" not configured — messaging disabled (phone/voice unaffected).`);
} else {
  console.log(`💬 Messaging enabled via ${adapter.name}.`);
}

/** Send an outbound message on the active provider. Best-effort; returns bool. */
export async function sendOutbound(message) {
  if (!messagingEnabled) return false;
  try {
    return await adapter.send(message);
  } catch (err) {
    console.error("sendOutbound failed:", err.message);
    return false;
  }
}
