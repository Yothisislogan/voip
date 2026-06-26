import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, normalizeTwilioConversations } from "../src/messaging/conversations.js";

const AUTHORS = { businessAuthor: "wit-connect", agentIdentities: new Set(["marisol.vega"]) };

test("normalizes an inbound SMS message", () => {
  const m = normalizeTwilioConversations(
    { EventType: "onMessageAdded", ConversationSid: "CH1", Author: "+14805550100", Source: "SMS", Body: "hi there", MessageSid: "IM1" },
    AUTHORS
  );
  assert.deepEqual(m, {
    provider: "twilio_conversations",
    channel: "sms",
    conversationId: "CH1",
    customerRef: "+14805550100",
    customerPhone: "+14805550100",
    text: "hi there",
    messageSid: "IM1",
  });
});

test("ignores our own outbound echoes", () => {
  // Sent via API
  assert.equal(normalizeTwilioConversations({ EventType: "onMessageAdded", Author: "wit-connect", Source: "API", Body: "x" }, AUTHORS), null);
  // Authored by the business label
  assert.equal(normalizeTwilioConversations({ EventType: "onMessageAdded", Author: "wit-connect", Source: "SMS", Body: "x" }, AUTHORS), null);
  // Authored by a known agent identity
  assert.equal(normalizeTwilioConversations({ EventType: "onMessageAdded", Author: "marisol.vega", Source: "SMS", Body: "x" }, AUTHORS), null);
});

test("ignores non-message events", () => {
  assert.equal(normalizeTwilioConversations({ EventType: "onConversationAdded", ConversationSid: "CH1" }, AUTHORS), null);
  assert.equal(normalizeTwilioConversations(null, AUTHORS), null);
});

test("opaque (non-phone) authors yield no customerPhone (e.g. Apple Messages)", () => {
  const m = normalizeTwilioConversations(
    { EventType: "onMessageAdded", ConversationSid: "CH9", Author: "urn:mbid:AQAAy...", Source: "APPLE", Body: "hello" },
    AUTHORS
  );
  assert.equal(m.channel, "apple");
  assert.equal(m.customerPhone, null);
  assert.equal(m.customerRef, "urn:mbid:AQAAy...");
});

test("conversation store buffers, lists by agent, and caps", () => {
  const s = new ConversationStore();
  s.upsert("CH1", { channel: "sms", customerRef: "+14805550100", agentIdentity: "marisol.vega", at: 1 });
  s.addMessage("CH1", "customer", "hi", 2);
  s.addMessage("CH1", "agent", "hello", 3);
  s.upsert("CH2", { channel: "sms", customerRef: "+14805550111", agentIdentity: "other.agent", at: 1 });

  assert.equal(s.get("CH1").messages.length, 2);
  assert.equal(s.listForAgent("marisol.vega").length, 1);
  assert.equal(s.listForAgent("marisol.vega")[0].conversationId, "CH1");

  s.setContact("CH1", { id: "C-1", fullName: "Jane Doe" });
  assert.equal(s.get("CH1").contact.fullName, "Jane Doe");
});

test("upsert does not clobber an existing contact or duplicate the conversation", () => {
  const s = new ConversationStore();
  s.upsert("CH1", { channel: "sms", customerRef: "+1", agentIdentity: "a", at: 1 });
  s.setContact("CH1", { id: "C-1" });
  s.upsert("CH1", { channel: "sms", at: 5 }); // second inbound on same thread
  assert.equal(s.get("CH1").contact.id, "C-1");
  assert.equal(s.listForAgent("a").length, 1);
});
