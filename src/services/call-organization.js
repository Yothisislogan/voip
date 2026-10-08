import { db } from '../db.js';
import { config } from '../config.js';
import { canAccessCall } from '../auth/call-access.js';

export function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length > 20) throw Object.assign(new Error('Use at most 20 tags per call'), { status: 400 });
  const result = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') throw Object.assign(new Error('Tags must be text'), { status: 400 });
    const tag = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!tag || tag.length > 40 || /[\p{C},]/u.test(tag)) throw Object.assign(new Error('Each tag needs 1–40 characters, without commas or control characters'), { status: 400 });
    if (!result.some(t => t.toLowerCase() === tag.toLowerCase())) result.push(tag);
  }
  return result;
}

export async function updateOrganization(sid, agent, body) {
  if (!Number.isInteger(body.version)) throw Object.assign(new Error('Reload the call before saving assignment or tags'), { status: 400 });
  const tags = normalizeTags(body.tags);
  const owner = body.assignedTo;
  if (owner !== null && !config.auth.agents.some(a => a.identity === owner && a.role !== 'viewer')) {
    throw Object.assign(new Error('Choose an active calling-enabled user or Unassigned'), { status: 400 });
  }
  return db.transaction(async tx => {
    const call = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [sid])).rows[0];
    if (!canAccessCall(agent, call) || agent.role === 'viewer') throw Object.assign(new Error('Call not found'), { status: 404 });
    if (call.organization_version !== body.version) throw Object.assign(new Error('Another user changed this call. Reload it before saving.'), { status: 409 });
    return (await tx.query(`UPDATE calls SET assigned_to=$2,tags=$3,assignment_explicit=true,
      organization_version=organization_version+1,updated_at=now() WHERE twilio_call_sid=$1 RETURNING *`, [sid, owner, tags])).rows[0];
  });
}
