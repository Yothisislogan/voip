// Session revocation + live directory re-check on the auth path.
process.env.SESSION_SECRET = "test-session-secret";
process.env.AUTH_REQUIRED = "true";
// A one-agent directory so the live re-check is exercised.
process.env.AGENT_DIRECTORY = JSON.stringify([
  { email: "amy@wit.com", identity: "amy", name: "Amy", role: "agent" },
]);

import { test } from "node:test";
import assert from "node:assert/strict";

const session = await import("../src/auth/session.js");
const { requireAuth } = await import("../src/auth/middleware.js");
const { revokeJti, revokeIdentity } = await import("../src/auth/revocation.js");

function cookieFor({ email, identity, role }) {
  const { token } = session.issueSession({ email, identity, name: "N", level: "full", role });
  return { token, cookie: `${session.cookieName}=${token}` };
}
function res() {
  return { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
}
function run(cookie) {
  const req = { headers: { cookie } };
  const r = res();
  let ok = false;
  requireAuth(req, r, () => (ok = true));
  return { ok, code: r.code, agent: req.agent };
}

test("an allowlisted agent passes and gets the DIRECTORY role, not the token's", () => {
  // Token claims admin, but the directory says agent — directory must win.
  const { cookie } = cookieFor({ email: "amy@wit.com", identity: "amy", role: "admin" });
  const out = run(cookie);
  assert.equal(out.ok, true);
  assert.equal(out.agent.role, "agent"); // live directory role overrides stale claim
});

test("an agent removed from the directory is rejected immediately", () => {
  const { cookie } = cookieFor({ email: "ghost@wit.com", identity: "ghost", role: "agent" });
  const out = run(cookie);
  assert.equal(out.ok, false);
  assert.equal(out.code, 401);
});

test("revoking a single jti kills that session (logout)", async () => {
  const { token, cookie } = cookieFor({ email: "amy@wit.com", identity: "amy", role: "agent" });
  assert.equal(run(cookie).ok, true); // valid before
  const payload = session.verifyToken(token);
  await revokeJti(payload.jti, payload.exp);
  assert.equal(run(cookie).ok, false); // dead after
});

test("revoking an identity kills all its existing sessions (log out everywhere)", async () => {
  const a = cookieFor({ email: "amy@wit.com", identity: "amy", role: "agent" });
  const b = cookieFor({ email: "amy@wit.com", identity: "amy", role: "agent" });
  assert.equal(run(a.cookie).ok, true);
  assert.equal(run(b.cookie).ok, true);
  await revokeIdentity("amy");
  // Both sessions were issued before the revocation cutoff → both dead.
  assert.equal(run(a.cookie).ok, false);
  assert.equal(run(b.cookie).ok, false);
});
