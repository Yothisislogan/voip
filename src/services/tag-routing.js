import { config } from '../config.js';
import { normalizeTags } from './call-organization.js';
import { normalizePhone } from '../util/phone.js';

const bad = message => Object.assign(new Error(message), { status: 400 });
export function callerPhone(raw) {
  if (typeof raw !== 'string' || !/^[+\d\s().-]+$/.test(raw)) throw bad('Use a valid customer phone number');
  const phone = normalizePhone(raw);
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || config.voice.sharedSourceNumbers.includes(phone))
    throw bad('Use a customer number, not a shared lead-transfer number');
  return phone;
}
export function validateTagRule(body) {
  const label = normalizeTags([body.tag])[0];
  if (!config.auth.agents.some(a => a.identity === body.preferredAgent && a.role !== 'viewer')) throw bad('Choose an active calling-enabled user');
  if (!Number.isInteger(body.priority) || body.priority < 1 || body.priority > 1000) throw bad('Priority must be 1–1000; lower numbers ring first');
  if (!Number.isInteger(body.ringSeconds) || body.ringSeconds < 5 || body.ringSeconds > 45) throw bad('Ring time must be 5–45 seconds');
  if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.version) || body.version < 0) throw bad('Enabled and current version are required');
  return { ...body, tag: label.toLowerCase(), label };
}
// Matching is deterministic: lowest priority, then tag name. Busy/unavailable
// preferred users are skipped; no call ownership is used as an implicit route.
export function chooseTagRule(tags, rules, availableIdentities) {
  const normalized = new Set(tags.map(t => t.toLowerCase()));
  const available = new Set(availableIdentities);
  return rules.filter(r => r.enabled && normalized.has(r.tag) && available.has(r.preferred_agent))
    .sort((a,b) => a.priority - b.priority || a.tag.localeCompare(b.tag))[0] || null;
}
