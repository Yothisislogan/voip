// Configure the allowlist before importing the module under test.
process.env.AGENT_DIRECTORY = JSON.stringify([
  {
    email: "Marisol.Vega@WIT.com",
    identity: "marisol.vega",
    name: "Marisol",
    mfaChannel: "sms",
    phone: "+14805550100",
  },
  { email: "bob@wit.com", identity: "bob", mfaChannel: "email" },
]);

import { test } from "node:test";
import assert from "node:assert/strict";

const agents = await import("../src/auth/agents.js");

test("lookup is case-insensitive and trims", () => {
  const a = agents.findAgentByEmail("  marisol.vega@wit.com ");
  assert.ok(a);
  assert.equal(a.identity, "marisol.vega");
});

test("non-allowlisted emails are rejected", () => {
  assert.equal(agents.isAllowed("intruder@gmail.com"), false);
  assert.equal(agents.findAgentByEmail("intruder@gmail.com"), null);
});

test("mfaTarget resolves sms to the phone", () => {
  const a = agents.findAgentByEmail("marisol.vega@wit.com");
  assert.deepEqual(agents.mfaTarget(a), { channel: "sms", to: "+14805550100" });
});

test("mfaTarget for email channel defaults to the login email", () => {
  const a = agents.findAgentByEmail("bob@wit.com");
  assert.deepEqual(agents.mfaTarget(a), { channel: "email", to: "bob@wit.com" });
});

test("two agents loaded", () => {
  assert.equal(agents.agentCount, 2);
});
