import { config } from "../config.js";

/**
 * Agent allowlist. A verified Google email must map to an entry here to log in.
 * This is the gate that stops arbitrary Google accounts from accessing the app.
 *
 * Entry shape (from AGENT_DIRECTORY JSON):
 *   { email, identity, name?, mfaChannel: "sms"|"email", phone?, mfaEmail? }
 *  - identity:   the Twilio Voice client identity for this agent
 *  - mfaChannel: how Twilio Verify delivers the second factor
 *  - phone:      E.164 destination for sms channel
 *  - mfaEmail:   destination for email channel (defaults to the login email)
 */

const byEmail = new Map(
  (config.auth.agents || [])
    .filter((a) => a && a.email && a.identity)
    .map((a) => [normalizeEmail(a.email), a])
);

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Look up an allowlisted agent by (verified) email, or null. */
export function findAgentByEmail(email) {
  return byEmail.get(normalizeEmail(email)) || null;
}

/** True if this email is permitted to log in. */
export function isAllowed(email) {
  return byEmail.has(normalizeEmail(email));
}

/** Resolve the Twilio Verify destination + channel for an agent. */
export function mfaTarget(agent) {
  if (!agent) return null;
  const channel = agent.mfaChannel === "email" ? "email" : "sms";
  const to = channel === "email" ? agent.mfaEmail || agent.email : agent.phone;
  if (!to) return null;
  return { channel, to };
}

export const agentCount = byEmail.size;
