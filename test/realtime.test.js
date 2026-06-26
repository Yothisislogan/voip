import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpeaker } from "../src/realtime/orchestrator.js";
import {
  identityFromClient,
  startSession,
  getSession,
  setContact,
  endSession,
} from "../src/realtime/sessions.js";

test("resolveSpeaker maps tracks by call direction", () => {
  // inbound: caller is the customer
  assert.equal(resolveSpeaker("inbound", "inbound_track"), "customer");
  assert.equal(resolveSpeaker("inbound", "outbound_track"), "agent");
  // outbound: caller is the agent's browser
  assert.equal(resolveSpeaker("outbound", "inbound_track"), "agent");
  assert.equal(resolveSpeaker("outbound", "outbound_track"), "customer");
  // unknown track defaults to customer
  assert.equal(resolveSpeaker("inbound", "weird"), "customer");
});

test("identityFromClient strips the client: prefix", () => {
  assert.equal(identityFromClient("client:marisol.vega"), "marisol.vega");
  assert.equal(identityFromClient("+14805550100"), null);
  assert.equal(identityFromClient(""), null);
});

test("session registry lifecycle", () => {
  startSession("CA_TEST", {
    identity: "marisol.vega",
    customerNumber: "+14805550100",
    direction: "inbound",
    from: "+14805550100",
    to: "+14805550111",
  });
  const s = getSession("CA_TEST");
  assert.equal(s.identity, "marisol.vega");
  assert.equal(s.contact, null);
  assert.ok(s.startedAt > 0);

  setContact("CA_TEST", { id: "abc", fullName: "Jane Doe" });
  assert.equal(getSession("CA_TEST").contact.fullName, "Jane Doe");

  endSession("CA_TEST");
  assert.equal(getSession("CA_TEST"), null);
});
