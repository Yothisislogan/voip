import { config } from "../config.js";
import { readSession, readSessionFromCookieString } from "./session.js";
import { findAgentByEmail } from "./agents.js";
import { isRevoked } from "./revocation.js";

/**
 * Auth gates. When AUTH_REQUIRED=false (local dev only) every gate injects a
 * dev identity and passes — this mirrors the existing dev-only webhook bypass.
 * In production (default) a valid "full" session is required everywhere that
 * touches customer data: the token endpoint, the agent page, and the WebSocket.
 */

// Role hierarchy: viewer (read-only) < agent (handle calls/edit) < admin (all).
export const ROLE_RANK = { viewer: 1, agent: 2, admin: 3 };
export function roleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);
}
export function normalizeRole(role) {
  const r = String(role || "").toLowerCase();
  return ROLE_RANK[r] ? r : "agent";
}

function devAgent() {
  // Dev bypass gets admin so all surfaces are testable.
  return { identity: config.auth.devIdentity, email: "dev@local", name: "Dev (auth disabled)", role: "admin" };
}

function agentFromSession(payload) {
  if (!payload || payload.level !== "full") return null;

  // Revoked (logout / offboarding / compromise) → session is dead immediately.
  if (isRevoked(payload)) return null;

  // Re-check the live allowlist on EVERY request so removing an email from
  // AGENT_DIRECTORY (or changing a role) takes effect instantly, instead of
  // trusting stale claims baked into the JWT until it expires. Only enforced
  // when a directory is actually configured (production requires one — an empty
  // directory is a fatal misconfig there); dev/test without one trust the token.
  if ((config.auth.agents || []).length) {
    const current = findAgentByEmail(payload.email);
    if (!current) return null; // agent was removed from the directory
    return {
      identity: current.identity,
      email: current.email,
      name: payload.name,
      role: normalizeRole(current.role), // current role wins over the token's
    };
  }

  return {
    identity: payload.identity,
    email: payload.email,
    name: payload.name,
    role: normalizeRole(payload.role),
  };
}

/**
 * Role gate — use AFTER requireAuth. Returns a middleware that 403s when the
 * authenticated agent's role is below `min`.
 */
export function requireRole(min) {
  return (req, res, next) => {
    if (!req.agent) return res.status(401).json({ error: "authentication required" });
    if (!roleAtLeast(req.agent.role, min)) {
      return res.status(403).json({ error: `requires ${min} role` });
    }
    next();
  };
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
