import { client as twilioClient } from "../twilio.js";
import { config } from "../config.js";
import { mfaTarget } from "./agents.js";

/**
 * Second factor via Twilio Verify (reuses the existing Twilio account). Twilio
 * handles OTP generation, delivery (SMS or email), expiry, and rate limiting —
 * we never store or generate codes ourselves.
 *
 * Disabled gracefully if TWO_FACTOR_ENABLED=false or no Verify service is set;
 * callers treat "not enforced" as a skip (the AUTH flow decides policy).
 */

const svc = config.auth.twoFactor.verifyServiceSid;

export function twoFactorEnforced() {
  return config.auth.twoFactor.enabled && Boolean(svc) && Boolean(twilioClient);
}

/** Send a verification code to the agent's MFA destination. Returns true on success. */
export async function startVerification(agent) {
  const target = mfaTarget(agent);
  if (!target) {
    console.error("2FA start failed: agent has no MFA destination", agent?.email);
    return false;
  }
  try {
    await twilioClient.verify.v2
      .services(svc)
      .verifications.create({ to: target.to, channel: target.channel });
    return true;
  } catch (err) {
    console.error("2FA start failed:", err.message);
    return false;
  }
}

/** Check a code the agent entered. Returns true only on an approved match. */
export async function checkVerification(agent, code) {
  const target = mfaTarget(agent);
  if (!target || !code) return false;
  try {
    const check = await twilioClient.verify.v2
      .services(svc)
      .verificationChecks.create({ to: target.to, code: String(code).trim() });
    return check.status === "approved";
  } catch (err) {
    console.error("2FA check failed:", err.message);
    return false;
  }
}
