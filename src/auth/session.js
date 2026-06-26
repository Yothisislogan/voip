import jwt from "jsonwebtoken";
import { config } from "../config.js";

// Minimal cookie parse/serialize — no external dependency.
function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function serializeCookie(name, value, { httpOnly, secure, sameSite, path, maxAge } = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (path) s += `; Path=${path}`;
  if (typeof maxAge === "number") s += `; Max-Age=${maxAge}`;
  if (httpOnly) s += "; HttpOnly";
  if (secure) s += "; Secure";
  if (sameSite) s += `; SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`;
  return s;
}

/**
 * Signed-cookie sessions (stateless JWT). No server-side session store, so this
 * works across multiple instances. Two trust levels:
 *   - "pending-2fa": Google verified, awaiting the second factor (short-lived)
 *   - "full":        fully authenticated, may use the app
 *
 * Cookies are httpOnly + SameSite=Lax, and Secure whenever we're served over
 * HTTPS (detected from PUBLIC_BASE_URL); Lax lets the cookie survive the
 * top-level OAuth redirect back from Google.
 */

const SECRET = config.auth.sessionSecret;
const SECURE = (config.publicBaseUrl || "").startsWith("https");

export function authConfigured() {
  return Boolean(SECRET);
}

// ── Generic signed tokens ──
export function signToken(payload, ttlSec) {
  if (!SECRET) throw new Error("SESSION_SECRET is not set");
  return jwt.sign(payload, SECRET, { expiresIn: ttlSec, algorithm: "HS256" });
}

export function verifyToken(token) {
  if (!SECRET || !token) return null;
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

// ── Cookie helpers ──
export function cookieHeader(name, value, ttlSec) {
  return serializeCookie(name, value, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: ttlSec,
  });
}

export function clearCookieHeader(name) {
  return serializeCookie(name, "", {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function readCookie(req, name) {
  return parseCookieString(req.headers?.cookie)[name];
}

export function parseCookieString(header) {
  if (!header) return {};
  try {
    return parseCookieHeader(header);
  } catch {
    return {};
  }
}

// ── Session-specific convenience ──
const PENDING_TTL = 10 * 60; // 10 minutes to complete 2FA

/** Issue a session token. level: "pending-2fa" | "full". */
export function issueSession({ email, identity, name, level }) {
  const ttl = level === "full" ? config.auth.sessionTtlSec : PENDING_TTL;
  const token = signToken({ email, identity, name, level, typ: "session" }, ttl);
  return { token, ttl };
}

/** Read + verify the session from a request's cookies. Returns payload or null. */
export function readSession(req) {
  return readSessionFromCookieString(req.headers?.cookie);
}

/** Same, from a raw Cookie header string (used in the WS upgrade handler). */
export function readSessionFromCookieString(header) {
  const cookies = parseCookieString(header);
  const payload = verifyToken(cookies[config.auth.cookieName]);
  if (!payload || payload.typ !== "session") return null;
  return payload;
}

export const cookieName = config.auth.cookieName;
