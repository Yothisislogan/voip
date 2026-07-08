// Security middleware: CSRF, rate limiting, headers.
process.env.SESSION_SECRET = "test-session-secret";
process.env.AUTH_REQUIRED = "true"; // enables CSRF by default
process.env.CSRF_ENABLED = "true";

import { test } from "node:test";
import assert from "node:assert/strict";

const { csrfProtect, ensureCsrfCookie, CSRF_COOKIE } = await import("../src/middleware/csrf.js");
const { rateLimit } = await import("../src/middleware/rateLimit.js");
const { securityHeaders } = await import("../src/middleware/security.js");

function res() {
  return {
    headers: {},
    code: null,
    body: null,
    _cookies: [],
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    append(k, v) { if (k.toLowerCase() === "set-cookie") this._cookies.push(v); },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

// ── CSRF ──
test("csrfProtect allows safe methods", () => {
  const r = res();
  let nexted = false;
  csrfProtect({ method: "GET", headers: {} }, r, () => (nexted = true));
  assert.equal(nexted, true);
});

test("csrfProtect 403s a POST with no token", () => {
  const r = res();
  let nexted = false;
  csrfProtect({ method: "POST", headers: {} }, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 403);
});

test("csrfProtect passes when header matches the cookie (double-submit)", () => {
  const token = "a".repeat(64);
  const req = { method: "POST", headers: { cookie: `${CSRF_COOKIE}=${token}`, "x-csrf-token": token } };
  const r = res();
  let nexted = false;
  csrfProtect(req, r, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(r.code, null);
});

test("csrfProtect 403s when header does not match the cookie", () => {
  const req = { method: "POST", headers: { cookie: `${CSRF_COOKIE}=aaa`, "x-csrf-token": "bbb" } };
  const r = res();
  let nexted = false;
  csrfProtect(req, r, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(r.code, 403);
});

test("ensureCsrfCookie plants a cookie when absent", () => {
  const r = res();
  ensureCsrfCookie({ headers: {} }, r, () => {});
  assert.equal(r._cookies.length, 1);
  assert.match(r._cookies[0], new RegExp(`^${CSRF_COOKIE}=`));
});

test("ensureCsrfCookie does not overwrite an existing cookie", () => {
  const r = res();
  ensureCsrfCookie({ headers: { cookie: `${CSRF_COOKIE}=existing` } }, r, () => {});
  assert.equal(r._cookies.length, 0);
});

// ── Rate limiting ──
test("rateLimit allows up to max then 429s", () => {
  const mw = rateLimit("unit-test-bucket", 2);
  const req = { headers: {}, socket: { remoteAddress: "1.2.3.4" } };
  const outcomes = [];
  for (let i = 0; i < 3; i++) {
    const r = res();
    let nexted = false;
    mw(req, r, () => (nexted = true));
    outcomes.push(nexted ? "ok" : r.code);
  }
  assert.deepEqual(outcomes, ["ok", "ok", 429]);
});

test("rateLimit is not bypassed by rotating a forged X-Forwarded-For prefix", () => {
  const mw = rateLimit("xff-spoof-bucket", 2);
  let blocked = 0;
  for (let i = 0; i < 5; i++) {
    // Attacker varies the (client-forgeable) first XFF entry; the proxy appends
    // the REAL connection IP last. Bucketing must key on the trusted entry.
    const req = {
      headers: { "x-forwarded-for": `10.9.9.${i}, 203.0.113.7` },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const r = res();
    let ok = false;
    mw(req, r, () => (ok = true));
    if (!ok && r.code === 429) blocked++;
  }
  assert.equal(blocked, 3); // first 2 pass, remaining 3 blocked despite rotation
});

test("rateLimit isolates buckets per client IP", () => {
  const mw = rateLimit("unit-test-bucket-2", 1);
  const mk = (ip) => ({ headers: {}, socket: { remoteAddress: ip } });
  const a = res(), b = res();
  let aNext = false, bNext = false;
  mw(mk("10.0.0.1"), a, () => (aNext = true));
  mw(mk("10.0.0.2"), b, () => (bNext = true));
  assert.equal(aNext, true);
  assert.equal(bNext, true); // different IP → own budget
});

// ── Security headers ──
test("securityHeaders sets the hardening headers", () => {
  const r = res();
  securityHeaders({}, r, () => {});
  assert.equal(r.getHeader("X-Content-Type-Options"), "nosniff");
  assert.equal(r.getHeader("X-Frame-Options"), "DENY");
  assert.ok(r.getHeader("Content-Security-Policy"));
  assert.ok(r.getHeader("Referrer-Policy"));
});
