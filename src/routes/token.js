import { Router } from "express";
import { generateVoiceToken } from "../twilio.js";
import { config } from "../config.js";

export const tokenRouter = Router();

// GET /token?identity=marisol.vega
// In production, derive identity from the authenticated user (SSO) instead
// of trusting a query param.
// TODO(prod): replace this param-based identity with SSO — derive identity
// from the authenticated session so callers cannot choose their own identity.
tokenRouter.get("/token", (req, res) => {
  const rawIdentity = req.query.identity;
  if (rawIdentity !== undefined && typeof rawIdentity !== "string") {
    return res.status(400).json({ error: "identity must be a single string value" });
  }
  const identity = (rawIdentity || config.defaultAgentIdentity).trim();
  if (!identity) {
    return res.status(400).json({ error: "identity must not be empty" });
  }
  try {
    const token = generateVoiceToken(identity);
    res.json({ identity, token });
  } catch (err) {
    console.error("token error:", err.message);
    res.status(500).json({ error: "Could not mint token. Check Twilio env vars." });
  }
});
