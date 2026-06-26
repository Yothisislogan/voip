import { config } from "../config.js";
import { normalizePhone, phoneVariants } from "../util/phone.js";

/**
 * SuiteCRM 7.10+ V8 REST API client (JSON:API, OAuth2).
 *
 * Endpoints used:
 *   POST /Api/access_token        -> OAuth2 token (password or client_credentials grant)
 *   GET  /Api/V8/module/Contacts  -> filter[...] lookup by phone
 *   POST /Api/V8/module           -> create Notes / Calls linked to a Contact
 *
 * Entirely optional: if SUITECRM_BASE_URL / client credentials are unset the
 * client reports `enabled = false` and every method resolves to a safe empty
 * result, so a missing CRM never breaks a live call. This mirrors the DB layer.
 */

const cfg = config.suitecrm;

export const crmEnabled = Boolean(cfg.baseUrl && cfg.clientId && cfg.clientSecret);

if (!crmEnabled) {
  console.log("🗂️  SuiteCRM not configured — screen-pop + recap disabled (phone still works).");
} else {
  console.log(`🗂️  SuiteCRM integration enabled (${cfg.baseUrl}).`);
}

// ─── OAuth2 token cache ─────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const usePassword = Boolean(cfg.username && cfg.password);
  const body = new URLSearchParams({
    grant_type: usePassword ? "password" : "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (usePassword) {
    body.set("username", cfg.username);
    body.set("password", cfg.password);
  }

  const res = await fetch(`${cfg.baseUrl}/Api/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SuiteCRM auth failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  return cachedToken;
}

// Authenticated JSON:API request helper.
async function api(method, path, payload) {
  const token = await getAccessToken();
  const res = await fetch(`${cfg.baseUrl}/Api/V8${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (res.status === 401) {
    // Token may have been revoked early; drop cache so the next call retries.
    cachedToken = null;
    tokenExpiresAt = 0;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SuiteCRM ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  // 204/empty bodies are valid for some writes.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Look up a Contact by phone number. Returns a normalized record the agent UI
 * can render, plus a deep link, or null if not found / CRM disabled.
 */
export async function findContactByPhone(rawPhone) {
  if (!crmEnabled || !rawPhone) return null;
  try {
    const e164 = normalizePhone(rawPhone);
    // SuiteCRM stores phones in several columns and formats; try the most
    // distinctive variant (last 7+ digits) with a CONTAINS-style filter on the
    // primary phone fields. JSON:API filter syntax: filter[field][op]=value.
    for (const variant of phoneVariants(rawPhone)) {
      const qs = new URLSearchParams();
      qs.set("filter[operator]", "or");
      qs.set("filter[phone_work][contains]", variant);
      qs.set("filter[phone_mobile][contains]", variant);
      qs.set("filter[phone_home][contains]", variant);
      qs.set("page[size]", "1");
      const json = await api("GET", `/module/Contacts?${qs.toString()}`);
      const row = json?.data?.[0];
      if (row) return shapeContact(row, e164);
    }
    return null;
  } catch (err) {
    console.error("findContactByPhone failed:", err.message);
    return null;
  }
}

function shapeContact(row, e164) {
  const a = row.attributes || {};
  return {
    id: row.id,
    type: row.type || "Contacts",
    firstName: a.first_name || "",
    lastName: a.last_name || "",
    fullName: [a.first_name, a.last_name].filter(Boolean).join(" ") || "(no name)",
    accountName: a.account_name || "",
    title: a.title || "",
    email: a.email1 || "",
    phone: a.phone_work || a.phone_mobile || a.phone_home || e164 || "",
    matchedPhone: e164,
    url: cfg.uiUrl
      ? `${cfg.uiUrl}/index.php?module=Contacts&action=DetailView&record=${row.id}`
      : null,
  };
}

/**
 * Write the post-call recap onto the contact as a Note. Returns the new
 * Note id, or null on failure / CRM disabled.
 */
export async function writeRecapNote({ contactId, subject, description }) {
  if (!crmEnabled) return null;
  try {
    const payload = {
      data: {
        type: "Notes",
        attributes: {
          name: subject?.slice(0, 255) || "Call recap",
          description: description || "",
          ...(contactId
            ? { parent_type: "Contacts", parent_id: contactId, contact_id: contactId }
            : {}),
        },
      },
    };
    const json = await api("POST", "/module", payload);
    return json?.data?.id || null;
  } catch (err) {
    console.error("writeRecapNote failed:", err.message);
    return null;
  }
}

/**
 * Optionally log the interaction as a completed Call activity (richer than a
 * Note for reporting). Best-effort; returns the Call id or null.
 */
export async function logCallActivity({ contactId, subject, description, durationSec }) {
  if (!crmEnabled) return null;
  try {
    const minutes = durationSec ? Math.floor(durationSec / 60) : 0;
    const seconds = durationSec ? durationSec % 60 : 0;
    const payload = {
      data: {
        type: "Calls",
        attributes: {
          name: subject?.slice(0, 255) || "Phone call",
          description: description || "",
          status: "Held",
          direction: "Inbound",
          duration_hours: 0,
          duration_minutes: minutes,
          duration_seconds: seconds,
          ...(contactId
            ? { parent_type: "Contacts", parent_id: contactId, contact_id: contactId }
            : {}),
        },
      },
    };
    const json = await api("POST", "/module", payload);
    return json?.data?.id || null;
  } catch (err) {
    console.error("logCallActivity failed:", err.message);
    return null;
  }
}
