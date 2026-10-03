import { normalizePhone } from "../util/phone.js";
import { extractLeadFields } from "../ai/extract.js";
import * as crm from "../store/crm.js";
import { createHash } from 'node:crypto';
import { isSharedNumber } from '../services/call-state.js';
import { upsertLeadSignal } from '../services/lead-matching.js';
import { db } from '../db.js';

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
  const messageId = body.message_id || body["Message-Id"] || body.messageId ||
    `email:${createHash('sha256').update(JSON.stringify([fromRaw, subject, text])).digest('hex')}`;
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
  const matches = String(text || '').matchAll(/\+?1?[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/g);
  for (const m of matches) {
    const phone = normalizePhone(`${m[1]}${m[2]}${m[3]}`);
    if (!isSharedNumber(phone)) return phone;
  }
  return null;
}

export function smartFinancialFields(parsed) {
  if (!/(^|@|\.)smartfinancial\.com$/i.test(parsed.fromEmail || '')) return null;
  const field = label => parsed.body.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:\\t]\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || null;
  return {
    name: field('Customer Name|Contact Name|Full Name|Name'),
    phone: extractPhone(field('Customer Phone|Phone Number|Phone|Telephone') || parsed.body),
    email: field('Customer Email|Email Address|Email'),
    business: field('Business Name|Company Name|Company'),
    leadId: field('Lead ID|Lead Number'),
  };
}

/**
 * Process one parsed email: upsert the lead + record the intake row.
 * Returns { contactId, emailIntakeId } (ids may be null when DB is disabled).
 */
export async function handleInboundEmail(parsed) {
  const vendor = smartFinancialFields(parsed);
  const phone = vendor?.phone || extractPhone(`${parsed.body} ${parsed.subject}`);
  const name = vendor ? vendor.name : parsed.fromName;
  const nameParts = name ? name.split(/\s+/) : [];
  const leadFields = extractLeadFields(`${parsed.subject}\n${parsed.body}`, null);

  const baseFields = {
    email: vendor ? vendor.email : parsed.fromEmail || leadFields.email || null,
    first_name: nameParts[0] || null,
    last_name: nameParts.slice(1).join(" ") || null,
    ...leadFields,
    source: vendor ? 'smartfinancial' : 'email',
    ...(vendor ? { email: vendor.email, company: vendor.business } : {}),
  };

  let contactId = null, emailIntakeId = null;
  if (db.enabled) {
    const saved = await db.transaction(async tx => {
      const receipt = await tx.query(`INSERT INTO service_receipts(receipt_key) VALUES($1)
        ON CONFLICT DO NOTHING RETURNING receipt_key`, [`email:${parsed.messageId}`]);
      if (!receipt.rows.length) {
        return (await tx.query('SELECT id,contact_id FROM email_intake WHERE message_id=$1 ORDER BY id LIMIT 1', [parsed.messageId])).rows[0];
      }
      const fields = Object.entries(baseFields).filter(([key,value]) => crm.CONTACT_FIELDS.has(key) && value != null && value !== '');
      let contact;
      if (phone || baseFields.email || baseFields.first_name) {
        const cols = ['phone_e164', ...fields.map(([key]) => key)];
        const values = [phone, ...fields.map(([key,value]) => ['drivers','vehicles'].includes(key) ? JSON.stringify(value) : value)];
        contact = (await tx.query(`INSERT INTO contacts(${cols.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')})
          ON CONFLICT(phone_e164) DO UPDATE SET last_contacted_at=now(),
            ${fields.map(([key]) => `${key}=coalesce(contacts.${key},EXCLUDED.${key})`).join(',')}
          RETURNING id`, values)).rows[0];
      }
      return (await tx.query(`INSERT INTO email_intake(message_id,from_email,from_name,subject,body,phone_e164,contact_id,parsed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,contact_id`,
      [parsed.messageId, parsed.fromEmail, parsed.fromName, parsed.subject, parsed.body, phone, contact?.id || null, JSON.stringify(leadFields)])).rows[0];
    });
    contactId = saved?.contact_id || null; emailIntakeId = saved?.id || null;
  }

  if (vendor && crm.crmDbEnabled) await upsertLeadSignal({ source: 'smartfinancial', source_id: vendor.leadId || parsed.messageId,
    customer_phone: phone, customer_email: vendor.email, customer_name: vendor.name, business_name: vendor.business });
  return { contactId, emailIntakeId, phone,
    fields: { ...leadFields, phone, name: name || undefined },
    fromName: name, fromEmail: vendor ? vendor.email : parsed.fromEmail };
}
