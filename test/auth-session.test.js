// Set the signing secret before the module under test is (dynamically) imported.
process.env.SESSION_SECRET = "test-session-secret";

import { test } from "node:test";
import assert from "node:assert/strict";

const session = await import("../src/auth/session.js");

test("full session round-trips and exposes identity + level", () => {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "Marisol",
    level: "full",
  });
  const payload = session.readSessionFromCookieString(`${session.cookieName}=${token}`);
  assert.equal(payload.level, "full");
  assert.equal(payload.identity, "marisol.vega");
  assert.equal(payload.email, "a@wit.com");
});

test("pending-2fa sessions are distinguishable from full", () => {
  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "Marisol",
    level: "pending-2fa",
  });
  const payload = session.readSessionFromCookieString(`${session.cookieName}=${token}`);
  assert.equal(payload.level, "pending-2fa");
});

test("a tampered token is rejected", () => {
  const { token } = session.issueSession({ email: "a", identity: "i", name: "n", level: "full" });
  assert.equal(session.verifyToken(token + "x"), null);
  assert.equal(session.readSessionFromCookieString(`${session.cookieName}=${token}x`), null);
});

test("a token signed with a different secret is rejected", async () => {
  // Forge with the wrong key — verification must fail.
  const jwt = (await import("jsonwebtoken")).default;
  const forged = jwt.sign({ identity: "evil", level: "full", typ: "session" }, "wrong-secret");
  assert.equal(session.verifyToken(forged), null);
});

test("missing / empty cookie yields null", () => {
  assert.equal(session.readSessionFromCookieString(""), null);
  assert.equal(session.readSessionFromCookieString(undefined), null);
  assert.equal(session.readSessionFromCookieString("other=1"), null);
});

test("cookieHeader sets HttpOnly + SameSite and clear expires it", () => {
  const h = session.cookieHeader("wit_session", "abc", 100);
  assert.match(h, /HttpOnly/);
  assert.match(h, /SameSite=Lax/);
  assert.match(h, /Max-Age=100/);
  assert.match(session.clearCookieHeader("wit_session"), /Max-Age=0/);
});
