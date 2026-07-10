import { Router } from "express";
import { config } from "../config.js";
import { parseInboundEmail, handleInboundEmail } from "../intake/email.js";
import { emitWitnextEvent } from "../integrations/witnext.js";
import { recordFailedJob } from "../jobs/deadletter.js";

/**
 * POST /email/inbound — inbound-parse webhook (SendGrid / Mailgun). Parses the
 * email into a lead and records it. Optionally protected by a shared token
 * (EMAIL_INBOUND_TOKEN) via ?token= or the X-Intake-Token header, since email
 * providers don't sign with a Twilio-style signature.
 *
 * Note: SendGrid Inbound Parse posts multipart/form-data; put a multipart
 * middleware in front, or configure the provider to POST JSON/urlencoded.
 */
export const emailRouter = Router();

emailRouter.post("/email/inbound", async (req, res) => {
  if (!config.emailIntake.enabled) return res.sendStatus(204);

  const token = config.emailIntake.token;
  if (token && req.query.token !== token && req.get("x-intake-token") !== token) {
    return res.status(401).json({ error: "invalid intake token" });
  }

  try {
    const parsed = parseInboundEmail(req.body || {});
    if (!parsed.fromEmail && !parsed.body) return res.status(400).json({ error: "empty email" });
    const result = await handleInboundEmail(parsed);

    // Broker: forward the normalized (never raw) lead to WiTNext intake review.
    // Gmail/message id rides along for receiver-side idempotency.
    emitWitnextEvent(
      "email.lead_received",
      {
        source: "email",
        message_id: parsed.messageId || null,
        from_name: parsed.fromName || null,
        from_email: parsed.fromEmail || null,
        subject: parsed.subject || null,
        extracted: result?.fields || null,
      },
      { recordFailedJob }
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("email intake failed:", err.message);
    res.status(500).json({ error: "intake failed" });
  }
});
