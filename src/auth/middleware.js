import { config } from "../config.js";
import { readSession, readSessionFromCookieString } from "./session.js";

/**
 * Auth gates. When AUTH_REQUIRED=false (local dev only) every gate injects a
 * dev identity and passes — this mirrors the existing dev-only webhook bypass.
 * In production (default) a valid "full" session is required everywhere that
 * touches customer data: the token endpoint, the agent page, and the WebSocket.
 */

function devAgent() {
  return { identity: config.auth.devIdentity, email: "dev@local", name: "Dev (auth disabled)" };
}

function agentFromSession(payload) {
  if (!payload || payload.level !== "full") return null;
  return { identity: payload.identity, email: payload.email, name: payload.name };
}

/** API gate — 401 JSON on failure (used by /token). */
export function requireAuth(req, res, next) {
  if (!config.auth.required) {
    req.agent = devAgent();
    return next();
  }
  const agent = agentFromSession(readSession(req));
  if (!agent) return res.status(401).json({ error: "authentication required" });
  req.agent = agent;
  next();
}

/** Page gate — redirect to /login on failure (used for /agent.html). */
export function pageGate(req, res, next) {
  if (!config.auth.required) {
    req.agent = devAgent();
    return next();
  }
  const agent = agentFromSession(readSession(req));
  if (!agent) return res.redirect("/login");
  req.agent = agent;
  next();
}

/** WebSocket upgrade gate — returns the agent or null (no Express res here). */
export function authenticateUpgrade(req) {
  if (!config.auth.required) return devAgent();
  return agentFromSession(readSessionFromCookieString(req.headers?.cookie));
}
