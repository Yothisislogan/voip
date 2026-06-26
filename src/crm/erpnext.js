import { config } from "../config.js";
import { phoneVariants, normalizePhone } from "../util/phone.js";

/**
 * ERPNext (Frappe framework) CRM client over the Frappe REST API.
 *
 *   Auth:  header  Authorization: token <api_key>:<api_secret>
 *   Read:  GET  /api/resource/<DocType>?or_filters=...&fields=...
 *   Write: POST /api/resource/<DocType>
 *
 * Screen-pop looks up the caller as a Contact, then a Lead. The recap is written
 * as a Communication on that record's timeline, plus a best-effort Call Log.
 *
 * Entirely optional: if ERPNEXT_BASE_URL / API key+secret are unset the client
 * reports `crmEnabled = false` and every method resolves to a safe empty result,
 * so a missing CRM never breaks a live call. Same contract as the old SuiteCRM
 * client, so the rest of the app is unchanged.
 */

const cfg = config.erpnext;

export const crmEnabled = Boolean(cfg.baseUrl && cfg.apiKey && cfg.apiSecret);

if (!crmEnabled) {
  console.log("🗂️  ERPNext not configured — screen-pop + recap disabled (phone still works).");
} else {
  console.log(`🗂️  ERPNext integration enabled (${cfg.baseUrl}).`);
}

function authHeaders(extra = {}) {
  return {
    Authorization: `token ${cfg.apiKey}:${cfg.apiSecret}`,
    Accept: "application/json",
    ...extra,
  };
}

async function apiGet(doctype, { orFilters, fields, limit = 1 }) {
  const qs = new URLSearchParams();
  if (fields) qs.set("fields", JSON.stringify(fields));
  if (orFilters) qs.set("or_filters", JSON.stringify(orFilters));
  qs.set("limit_page_length", String(limit));
  const url = `${cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}?${qs.toString()}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ERPNext GET ${doctype} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json())?.data || [];
}

async function apiCreate(doctype, doc) {
  const url = `${cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ERPNext POST ${doctype} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json())?.data || null;
}

/** Build a deep link into the ERPNext desk for a record. */
export function recordUrl(doctype, name) {
  if (!cfg.uiUrl || !doctype || !name) return null;
  const slug = doctype.toLowerCase().replace(/\s+/g, "-");
  return `${cfg.uiUrl}/app/${slug}/${encodeURIComponent(name)}`;
}

/** Normalize a Contact or Lead row into the shape the agent UI renders. */
export function shapeRecord(row, doctype, matchedPhone) {
  const first = row.first_name || "";
  const last = row.last_name || "";
  const full =
    [first, last].filter(Boolean).join(" ") || row.lead_name || row.name || "(no name)";
  return {
    id: row.name,
    doctype,
    firstName: first,
    lastName: last,
    fullName: full,
    accountName: row.company_name || "",
    title: row.designation || "",
    email: row.email_id || "",
    phone: row.mobile_no || row.phone || matchedPhone || "",
    matchedPhone,
    url: recordUrl(doctype, row.name),
  };
}

const CONTACT_FIELDS = ["name", "first_name", "last_name", "email_id", "mobile_no", "phone", "company_name", "designation"];
const LEAD_FIELDS = ["name", "lead_name", "first_name", "last_name", "email_id", "mobile_no", "phone", "company_name", "designation"];

/**
 * Look up the caller as a Contact, then a Lead, by phone. Returns a shaped
 * record (with `doctype`) or null.
 */
export async function findContactByPhone(rawPhone) {
  if (!crmEnabled || !rawPhone) return null;
  try {
    const e164 = normalizePhone(rawPhone);
    for (const variant of phoneVariants(rawPhone)) {
      const like = `%${variant}%`;

      const contacts = await apiGet("Contact", {
        orFilters: [["mobile_no", "like", like], ["phone", "like", like]],
        fields: CONTACT_FIELDS,
      });
      if (contacts[0]) return shapeRecord(contacts[0], "Contact", e164);

      const leads = await apiGet("Lead", {
        orFilters: [["mobile_no", "like", like], ["phone", "like", like], ["whatsapp_no", "like", like]],
        fields: LEAD_FIELDS,
      });
      if (leads[0]) return shapeRecord(leads[0], "Lead", e164);
    }
    return null;
  } catch (err) {
    console.error("findContactByPhone failed:", err.message);
    return null;
  }
}

/**
 * Write the recap as a Communication on the contact's/lead's timeline.
 * Returns the new Communication name, or null.
 */
export async function writeRecapNote({ contact, subject, description }) {
  if (!crmEnabled) return null;
  try {
    const doc = {
      communication_type: "Communication",
      communication_medium: "Phone",
      sent_or_received: "Received",
      subject: (subject || "Call recap").slice(0, 140),
      content: description || "",
      ...(contact?.doctype && contact?.id
        ? { reference_doctype: contact.doctype, reference_name: contact.id }
        : {}),
    };
    const created = await apiCreate("Communication", doc);
    return created?.name || null;
  } catch (err) {
    console.error("writeRecapNote failed:", err.message);
    return null;
  }
}

/**
 * Best-effort Call Log entry (telephony reporting), linked to the contact/lead.
 * Returns the Call Log name or null.
 */
export async function logCallActivity({ contact, callSid, from, to, durationSec, direction }) {
  if (!crmEnabled) return null;
  try {
    const doc = {
      id: callSid || undefined, // unique call id (autoname); omit to let Frappe generate
      from: from || "",
      to: to || "",
      duration: durationSec || 0,
      type: direction === "outbound" ? "Outgoing" : "Incoming",
      status: "Completed",
      ...(contact?.doctype && contact?.id
        ? { links: [{ link_doctype: contact.doctype, link_name: contact.id }] }
        : {}),
    };
    const created = await apiCreate("Call Log", doc);
    return created?.name || null;
  } catch (err) {
    console.error("logCallActivity failed:", err.message);
    return null;
  }
}
