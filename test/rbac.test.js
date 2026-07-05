// Role-based access control: viewer < agent < admin.
process.env.SESSION_SECRET = "test-session-secret";
process.env.AUTH_REQUIRED = "true";

import { test } from "node:test";
import assert from "node:assert/strict";

const { requireAuth, requireRole, roleAtLeast, normalizeRole, ROLE_RANK } = await import(
  "../src/auth/middleware.js"
);
const session = await import("../src/auth/session.js");

function cookieFor(role) {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "M",
    level: "full",
    role,
  });
  return `${session.cookieName}=${token}`;
}

function res() {
  return {
    code: null,
    body: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

// ── pure helpers ──
test("ROLE_RANK orders viewer < agent < admin", () => {
  assert.ok(ROLE_RANK.viewer < ROLE_RANK.agent);
  assert.ok(ROLE_RANK.agent < ROLE_RANK.admin);
});

test("roleAtLeast compares by rank", () => {
  assert.equal(roleAtLeast("admin", "agent"), true);
  assert.equal(roleAtLeast("agent", "agent"), true);
  assert.equal(roleAtLeast("viewer", "agent"), false);
  assert.equal(roleAtLeast("nonsense", "viewer"), false); // unknown role → rank 0
});

test("normalizeRole coerces unknown/missing to agent, keeps valid", () => {
  assert.equal(normalizeRole("VIEWER"), "viewer");
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(normalizeRole(""), "agent");
  assert.equal(normalizeRole(undefined), "agent");
  assert.equal(normalizeRole("superuser"), "agent");
});

// ── requireRole middleware ──
test("requireRole passes when the session role meets the minimum", () => {
  const req = { headers: { cookie: cookieFor("agent") } };
  const r = res();
  requireAuth(req, r, () => {});
  let nexted = false;
  requireRole("agent")(req, r, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(r.code, null);
});

test("requireRole 403s when the session role is below the minimum", () => {
  const req = { headers: { cookie: cookieFor("viewer") } };
  const r = res();
  requireAuth(req, r, () => {});
  let nexted = false;
  requireRole("agent")(req, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 403);
});

test("requireRole 401s when there is no authenticated agent", () => {
  const r = res();
  let nexted = false;
  requireRole("agent")({ headers: {} }, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 401);
});

test("admin satisfies an agent-level gate", () => {
  const req = { headers: { cookie: cookieFor("admin") } };
  const r = res();
  requireAuth(req, r, () => {});
  let nexted = false;
  requireRole("agent")(req, r, () => (nexted = true));
  assert.equal(nexted, true);
});

test("requireAuth defaults a role-less session to agent", () => {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "M",
    level: "full",
  });
  const req = { headers: { cookie: `${session.cookieName}=${token}` } };
  const r = res();
  requireAuth(req, r, () => {});
  assert.equal(req.agent.role, "agent");
});
