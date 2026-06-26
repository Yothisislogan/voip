/**
 * Phone-number helpers. Twilio gives us E.164 (`+14805550100`), but CRM
 * records may store numbers in any human format (`(480) 555-0100`, `480-555-0100`).
 * We normalize for display and generate a few "contains" variants for lookup.
 */

// Strip everything except digits and a single leading +.
export function normalizePhone(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  // US 10-digit -> assume +1; 11-digit starting with 1 -> +1XXXXXXXXXX.
  if (!hasPlus) {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return `+${digits}`;
}

// Just the digits (no +), for substring matching.
export function digitsOnly(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * Variants to try against the CRM, most-distinctive first. The last 7 digits
 * are the most format-agnostic match (local number), so they go first; then
 * last 10 (area code + number); then the full digit string.
 */
export function phoneVariants(raw) {
  const d = digitsOnly(raw);
  const variants = [];
  if (d.length >= 7) variants.push(d.slice(-7));
  if (d.length >= 10) variants.push(d.slice(-10));
  if (d.length > 0) variants.push(d);
  // Dedupe while preserving order.
  return [...new Set(variants)];
}
