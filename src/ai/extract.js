/**
 * Deterministic lead-field extraction from a call transcript (+ recap). Pulls
 * insurance-relevant fields into the shape used by the contacts table. Local and
 * dependency-free; runs regardless of AI backend. Each extractor is conservative
 * — it only emits a field when reasonably confident.
 *
 * Returns a partial object of contact columns.
 */

const CARRIERS = [
  ["geico", "GEICO"], ["progressive", "Progressive"], ["state farm", "State Farm"],
  ["allstate", "Allstate"], ["usaa", "USAA"], ["farmers", "Farmers"],
  ["nationwide", "Nationwide"], ["liberty mutual", "Liberty Mutual"],
  ["travelers", "Travelers"], ["american family", "American Family"],
];

const POLICY_TYPES = [
  [["auto", "car ", "vehicle", "vin"], "Auto"],
  [["homeowners", "home ", "house"], "Home"],
  [["renters", "apartment"], "Renters"],
  [["life insurance", "term life", "whole life"], "Life"],
  [["commercial auto", "box truck", "tow truck"], "Commercial Auto"],
  [["general liability"], "General Liability"],
  [["workers comp", "workers compensation", "payroll"], "Workers Compensation"],
  [["umbrella"], "Umbrella"],
];

const VEHICLE_MAKES = [
  "toyota", "honda", "ford", "chevrolet", "chevy", "nissan", "gmc", "ram", "dodge",
  "jeep", "subaru", "hyundai", "kia", "bmw", "mercedes", "audi", "lexus", "mazda",
  "volkswagen", "vw", "tesla", "buick", "cadillac", "chrysler", "acura", "infiniti",
  "volvo", "porsche", "mitsubishi", "land rover", "lincoln",
];

const BUSINESS_TYPES = [
  ["trucking", "Trucking"], ["restaurant", "Restaurant"], ["contractor", "Contractor"],
  ["construction", "Construction"], ["retail", "Retail"], ["landscaping", "Landscaping"],
  ["cleaning", "Cleaning"], ["auto repair", "Auto Repair"], ["salon", "Salon"],
  ["consulting", "Consulting"], ["ecommerce", "E-commerce"], ["e-commerce", "E-commerce"],
];

export function extractLeadFields(transcript = "", recap = null) {
  const raw = String(transcript);
  const t = ` ${raw.toLowerCase()} `;
  const out = {};

  // Policy type — prefer the recap's product, else keyword scan.
  if (recap?.productsDiscussed?.length) {
    out.policy_type = recap.productsDiscussed[0];
  } else {
    for (const [needles, label] of POLICY_TYPES) {
      if (needles.some((n) => t.includes(n))) { out.policy_type = label; break; }
    }
  }

  for (const [needle, label] of CARRIERS) {
    if (t.includes(needle)) { out.carrier = label; break; }
  }

  const premium = extractPremium(raw);
  if (premium != null) out.premium = premium;

  const email = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (email) out.email = email[0].toLowerCase();

  const vin = extractVin(raw);
  if (vin) out.vin = vin;

  const dob = extractDob(raw);
  if (dob) out.dob = dob;

  const address = extractAddress(raw);
  if (address) out.address = address;

  const vehicles = extractVehicles(raw);
  if (vehicles.length) out.vehicles = vehicles;

  const drivers = extractDrivers(raw);
  if (drivers.length) out.drivers = drivers;

  const business = extractBusiness(raw);
  if (business.business_name) out.business_name = business.business_name;
  if (business.business_type) out.business_type = business.business_type;

  if (recap?.outcome === "sale") out.lifecycle_stage = "customer";
  else if (recap?.outcome === "not_interested") out.lifecycle_stage = "lost";

  return out;
}

export function extractPremium(transcript) {
  const text = String(transcript);
  const re = /\$\s?([0-9][0-9,]{1,7}(?:\.\d{2})?)|([0-9][0-9,]{1,7}(?:\.\d{2})?)\s*dollars/gi;
  let best = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number((m[1] || m[2] || "").replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 10 && n <= 1_000_000 && (best == null || n > best)) best = n;
  }
  return best;
}

// A 17-char VIN (no I/O/Q), containing at least one letter and one digit.
export function extractVin(text) {
  const m = String(text).toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  if (!m) return null;
  const v = m[0];
  if (!/[A-Z]/.test(v) || !/\d/.test(v)) return null;
  return v;
}

// Date of birth near a birth keyword → ISO YYYY-MM-DD.
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const BIRTH_KEY = "(?:d\\.?o\\.?b\\.?|date of birth|born(?: on)?|birthday)";

function isoDate(yyyy, mm, dd) {
  if (yyyy < 100) yyyy = yyyy <= 25 ? 2000 + yyyy : 1900 + yyyy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export function extractDob(text) {
  const s = String(text);
  // Numeric: 3/4/1985, 03-04-85, etc.
  const num = s.match(
    new RegExp(`\\b${BIRTH_KEY}\\b[^0-9]{0,12}(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{2,4})`, "i")
  );
  if (num) return isoDate(+num[3], +num[1], +num[2]);

  // Month-name: "March 4th, 1985", "born on Mar 4 1985" — how callers actually say it.
  const mon = s.match(
    new RegExp(
      `\\b${BIRTH_KEY}\\b[^0-9]{0,15}?([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2,4})`,
      "i"
    )
  );
  if (mon) {
    const mm = MONTHS[mon[1].slice(0, 3).toLowerCase()];
    if (mm) return isoDate(+mon[3], mm, +mon[2]);
  }
  return null;
}

export function extractAddress(text) {
  const m = String(text).match(
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|circle|cir|place|pl|terrace|ter|highway|hwy|parkway|pkwy)\b\.?(?:,?\s*[A-Za-z .]+,?\s*[A-Z]{2}\s*\d{5})?/i
  );
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

// "2019 Toyota Camry" style → [{year, make, model}].
export function extractVehicles(text) {
  const re = new RegExp(`\\b(19|20)(\\d{2})\\s+(${VEHICLE_MAKES.join("|")})\\s+([A-Za-z0-9-]{2,})`, "gi");
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null && out.length < 6) {
    const year = Number(`${m[1]}${m[2]}`);
    const make = title(m[3]);
    const model = title(m[4]);
    const key = `${year} ${make} ${model}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push({ year, make, model }); }
  }
  return out;
}

// Words that look capitalized but aren't names (sentence starts, pronouns).
const NON_NAME = new Set([
  "add", "also", "and", "but", "her", "his", "i", "me", "my", "now", "our", "so",
  "the", "their", "then", "we", "you", "a", "an", "just", "please", "he", "she",
]);

// Names introduced as drivers, e.g. "add my wife Jane Smith as a driver".
export function extractDrivers(text) {
  const out = [];
  const seen = new Set();
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b(?=[^.?!]{0,40}\bdriver)|\bdriver[^.?!]{0,20}?\b(?:is|named|called)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < 8) {
    let name = (m[1] || m[2] || "").trim();
    // Drop leading filler tokens ("Add my wife Jane Smith" → "Jane Smith").
    const tokens = name.split(/\s+/).filter((w) => !NON_NAME.has(w.toLowerCase()));
    name = tokens.join(" ");
    if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
  }
  return out;
}

export function extractBusiness(text) {
  const out = {};
  // 1–4 capitalized words immediately preceding a company suffix.
  const name = String(text).match(
    /\b((?:[A-Z][A-Za-z0-9&'.]*\s+){1,4}(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Company|Ltd\.?))\b/
  );
  if (name) out.business_name = name[1].replace(/\s+/g, " ").trim();
  const lower = String(text).toLowerCase();
  for (const [needle, label] of BUSINESS_TYPES) {
    if (lower.includes(needle)) { out.business_type = label; break; }
  }
  return out;
}

function title(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
