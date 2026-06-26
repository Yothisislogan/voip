// Dev-bypass mode: AUTH_REQUIRED=false must inject a dev identity and pass.
// This is the security-sensitive bypass, so we pin its behavior.
process.env.AUTH_REQUIRED = "false";
process.env.DEV_IDENTITY = "dev.agent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { requireAuth, authenticateUpgrade } = await import("../src/auth/middleware.js");

test("requireAuth injects the dev identity and passes with no cookie", () => {
  const req = { headers: {} };
  let nexted = false;
  requireAuth(req, { status() { return this; }, json() {} }, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(req.agent.identity, "dev.agent");
});

test("authenticateUpgrade returns the dev identity with no cookie", () => {
  assert.equal(authenticateUpgrade({ headers: {} }).identity, "dev.agent");
});
