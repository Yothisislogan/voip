// Required-auth mode: a valid "full" session is needed everywhere.
process.env.SESSION_SECRET = "test-session-secret";
process.env.AUTH_REQUIRED = "true";

import { test } from "node:test";
import assert from "node:assert/strict";

const { requireAuth, pageGate, authenticateUpgrade } = await import("../src/auth/middleware.js");
const session = await import("../src/auth/session.js");

function fullCookie() {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "M",
    level: "full",
  });
  return `${session.cookieName}=${token}`;
}
function pendingCookie() {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "M",
    level: "pending-2fa",
  });
  return `${session.cookieName}=${token}`;
}
function res() {
  return {
    code: null,
    body: null,
    redirected: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    redirect(u) { this.redirected = u; return this; },
  };
}

test("requireAuth 401s without a session", () => {
  const r = res();
  let nexted = false;
  requireAuth({ headers: {} }, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 401);
});

test("requireAuth passes with a full session and sets req.agent", () => {
  const req = { headers: { cookie: fullCookie() } };
  const r = res();
  let nexted = false;
  requireAuth(req, r, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(req.agent.identity, "marisol.vega");
});

test("requireAuth rejects a pending-2fa session (not yet full)", () => {
  const r = res();
  let nexted = false;
  requireAuth({ headers: { cookie: pendingCookie() } }, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 401);
});

test("pageGate redirects to /login without a session", () => {
  const r = res();
  pageGate({ headers: {} }, r, () => {});
  assert.equal(r.redirected, "/login");
});

test("authenticateUpgrade returns the agent for a valid cookie, null otherwise", () => {
  assert.equal(authenticateUpgrade({ headers: { cookie: fullCookie() } }).identity, "marisol.vega");
  assert.equal(authenticateUpgrade({ headers: {} }), null);
  assert.equal(authenticateUpgrade({ headers: { cookie: pendingCookie() } }), null);
});
