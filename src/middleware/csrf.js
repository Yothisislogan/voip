import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { readCookie } from "../auth/session.js";

/**
 * CSRF protection via the double-submit-cookie pattern. We already set
 * SameSite=Lax on the session cookie (which blocks most cross-site POSTs), but
 * this adds defense-in-depth for cookie-authenticated browser routes:
 *
 *   - ensureCsrfCookie: on safe requests, plant a NON-httpOnly `wit_csrf`
 *     cookie the page's JS can read.
 *   - csrfProtect: on unsafe methods, require the `X-CSRF-Token` header to equal
 *     that cookie. A cross-site attacker can drive the browser to send the
 *     cookie but cannot read it to set the matching header.
 *
 * Twilio-signed webhooks and the token-authed email intake are mounted WITHOUT
 * csrfProtect — they carry no session cookie, so there is nothing to forge.
 * Disabled automatically when AUTH_REQUIRED=false (no session cookie exists).
 */

export const CSRF_COOKIE = "wit_csrf";
const HEADER = "x-csrf-token";
const SECURE = (config.publicBaseUrl || "").startsWith("https");
const ENABLED = config.security.csrfEnabled;

function newToken() {
  return randomBytes(32).toString("hex");
}

function serialize(name, value) {
  // Readable by JS (no HttpOnly), Lax so top-level navigations keep it.
  let s = `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${config.auth.sessionTtlSec}`;
  if (SECURE) s += "; Secure";
  return s;
}

/** Plant a CSRF cookie on safe requests if the client doesn't have one yet. */
export function ensureCsrfCookie(req, res, next) {
  if (ENABLED && !readCookie(req, CSRF_COOKIE)) {
    res.append("Set-Cookie", serialize(CSRF_COOKIE, newToken()));
  }
  next();
}

function safeMethod(m) {
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Reject unsafe cookie-authed requests whose header token doesn't match the cookie. */
export function csrfProtect(req, res, next) {
  if (!ENABLED || safeMethod(req.method)) return next();
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.headers[HEADER];
  if (!cookieToken || !equal(cookieToken, headerToken)) {
    return res.status(403).json({ error: "invalid or missing CSRF token" });
  }
  next();
}
