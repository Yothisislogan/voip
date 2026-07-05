import { normalizePhone } from "../util/phone.js";
import { extractLeadFields } from "../ai/extract.js";
import * as crm from "../store/crm.js";

/**
 * Email intake: parse an inbound-parse webhook (SendGrid / Mailgun) into a
 * normalized email, extract a phone + lead fields, upsert a contact, and record
 * the raw email. Best-effort; the parser is pure so it can be unit-tested.
 */

/** Normalize provider payloads (SendGrid Inbound Parse or Mailgun) to one shape. */
export function parseInboundEmail(body = {}) {
  const fromRaw = body.from || body.sender || body.From || "";
  const { name, email } = parseFrom(fromRaw);
  const subject = body.subject || body.Subject || "";
  const text =
    body.text || body["body-plain"] || body["stripped-text"] || stripHtml(body.html || body["body-html"] || "");
  const messageId = body.message_id || body["Message-Id"] || body.messageId || null;
  return { fromName: name, fromEmail: email, subject, body: String(text || "").trim(), messageId };
}

export function parseFrom(raw) {
  const s = String(raw || "").trim();
  const angle = s.match(/^(.*?)<([^>]+)>$/);
  if (angle) return { name: angle[1].trim().replace(/^"|"$/g, ""), email: angle[2].trim().toLowerCase() };
  const email = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return { name: "", email: email ? email[0].toLowerCase() : "" };
}

export function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** Find a US phone number anywhere in the text and return it in E.164. */
export function extractPhone(text) {
  const m = String(text || "").match(/\+?1?[\s.\-]?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})/);
  if (!m) return null;
  const e164 = normalizePhone(`${m[1]}${m[2]}${m[3]}`);
  return e164 || null;
}

/**
 * Process one parsed email: upsert the lead + record the intake row.
 * Returns { contactId, emailIntakeId } (ids may be null when DB is disabled).
 */
export async function handleInboundEmail(parsed) {
  const phone = extractPhone(`${parsed.body} ${parsed.subject}`);
  const nameParts = parsed.fromName ? parsed.fromName.split(/\s+/) : [];
  const leadFields = extractLeadFields(`${parsed.subject}\n${parsed.body}`, null);

  const baseFields = {
    email: parsed.fromEmail || leadFields.email || null,
    first_name: nameParts[0] || null,
    last_name: nameParts.slice(1).join(" ") || null,
    source: "email",
    ...leadFields,
  };

  let contact = null;
  if (crm.crmDbEnabled) {
    if (phone) {
      contact = await crm.findOrCreateContactByPhone(phone, { source: "email" });
      if (contact) await crm.updateContactFields(contact.id, baseFields);
    } else {
      contact = await crm.createContact({ ...baseFields, phone_e164: null });
    }
  }

  const emailIntakeId = await crm.insertEmailIntake({
    messageId: parsed.messageId,
    fromEmail: parsed.fromEmail,
    fromName: parsed.fromName,
    subject: parsed.subject,
    body: parsed.body,
    phone,
    contactId: contact?.id || null,
    parsed: leadFields,
  });

  return { contactId: contact?.id || null, emailIntakeId, phone };
}
