import { db } from '../db.js';
import { config } from '../config.js';
import { callerPhone, chooseTagRule } from './tag-routing.js';
import { collaborationHub } from '../realtime/collaboration.js';

export function validateRouting(route) {
  if (!route) return [];
  const errors = [];
  if (!route || route.invalid || typeof route !== 'object') return ['VOICE_ROUTING_JSON must be valid JSON'];
  if (!Array.isArray(route.agents) || !route.agents.length || route.agents.length > 10) errors.push('routing.agents requires 1–10 identities');
  const directory = config.auth.agents.filter(a => a.role !== 'viewer').map(a => a.identity);
  if (Array.isArray(route.agents) && route.agents.some(a => typeof a !== 'string' || !directory.includes(a))) errors.push('routing agents must be calling-enabled AGENT_DIRECTORY identities');
  if (!['simultaneous', 'round_robin', 'longest_idle', 'fixed'].includes(route.strategy || 'simultaneous')) errors.push('unknown routing strategy');
  try { new Intl.DateTimeFormat('en-US', { timeZone: route.timezone || 'America/New_York' }).format(); }
  catch { errors.push('invalid routing timezone'); }
  if (route.hours && (typeof route.hours !== 'object' || Object.entries(route.hours).some(([day, slots]) =>
    !/^[0-6]$/.test(day) || !Array.isArray(slots) || slots.some(slot => !Array.isArray(slot) || slot.length !== 2 || slot.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))))) errors.push('hours must map weekday 0–6 to HH:MM start/end pairs');
  if (route.holidays && (!Array.isArray(route.holidays) || route.holidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d)))) errors.push('holidays must contain YYYY-MM-DD dates');
  return errors;
}

export function isOpen(route, now = new Date()) {
  if (!route) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: route.timezone || 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (route.holidays?.includes(date)) return false;
  if (!route.hours) return true;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const time = `${parts.hour}:${parts.minute}`;
  // Overnight shifts are represented by two intervals on successive days.
  return (route.hours[day] || []).some(([start, end]) => start <= time && time < end);
}

export function orderAgents(agents, strategy) {
  const byTime = key => (a, b) => new Date(a[key] || 0) - new Date(b[key] || 0) || a.identity.localeCompare(b.identity);
  if (strategy === 'round_robin') return [...agents].sort(byTime('last_offered_at'));
  if (strategy === 'longest_idle') return [...agents].sort(byTime('idle_since'));
  return agents;
}

const ringTime = route => Math.max(5, Math.min(60, Number(route?.ringSeconds) || 20));
async function availableTargets(tx, identities, exclude = []) {
  const { rows } = await tx.query(`SELECT * FROM agent_presence WHERE identity=ANY($1::text[])
    AND NOT(identity=ANY($2::text[])) AND status='available' AND heartbeat_at>now()-interval '75 seconds'
    AND (reserved_until IS NULL OR reserved_until<now())
    AND NOT EXISTS(SELECT 1 FROM calls c WHERE c.agent_identity=agent_presence.identity AND c.status='in_progress')`, [identities, exclude]);
  return identities.map(id => rows.find(a => a.identity === id)).filter(a => a && !collaborationHub.busy(a.identity));
}
function normalTargets(rows, route) {
  const sorted = orderAgents(rows, route?.strategy);
  return (!route?.strategy || route.strategy === 'simultaneous' ? sorted : sorted.slice(0,1)).map(a => a.identity);
}
async function reserve(tx, callSid, targets, timeout) {
  if (targets.length) await tx.query(`UPDATE agent_presence SET reserved_call_sid=$1,
    reserved_until=now()+$3 * interval '1 second',last_offered_at=now() WHERE identity=ANY($2::text[])`, [callSid,targets,timeout+15]);
}

export async function selectTargets(callSid, now = new Date(), { from } = {}) {
  const route = config.voice.routing;
  if (!route && !config.voice.tagRoutingEnabled && !config.collaboration.enabled) return { targets: collaborationHub.busy(config.defaultAgentIdentity) ? [] : [config.defaultAgentIdentity], reason: 'default', timeout: 20 };
  if (route && validateRouting(route).length) throw new Error('Invalid voice routing configuration');
  if (!isOpen(route, now)) return { targets: [], reason: 'closed', timeout: 20 };
  if (!db.enabled) return { targets: [], reason: 'unavailable', timeout: 20 };
  return db.transaction(async tx => {
    await tx.query("INSERT INTO calls(twilio_call_sid,status) VALUES($1,'queued') ON CONFLICT DO NOTHING", [callSid]);
    // Every path takes the call row before the shared reservation lock.
    const call = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [callSid])).rows[0];
    await tx.query('SELECT pg_advisory_xact_lock(7170701)');
    if (call.routing_decided_at) return { targets: call.route_targets, reason: 'retry', timeout: call.routing_plan?.timeout || ringTime(route) };
    const normal = route?.agents || [config.defaultAgentIdentity];
    const eligible = config.auth.agents.filter(a => a.role !== 'viewer').map(a => a.identity);
    let tags = [], rules = [];
    if (config.voice.tagRoutingEnabled) {
      let phone; try { phone = callerPhone(call.customer_number || from); } catch { /* Unknown/shared caller: normal route. */ }
      if (phone) tags = (await tx.query('SELECT tags FROM caller_routing_tags WHERE phone=$1', [phone])).rows[0]?.tags || [];
      if (tags.length) rules = (await tx.query('SELECT * FROM tag_routing_rules WHERE enabled AND tag=ANY($1::text[])', [tags.map(t => t.toLowerCase())])).rows;
    }
    const identities = [...new Set([...normal,...rules.map(r => r.preferred_agent)])].filter(id => eligible.includes(id));
    const available = await availableTargets(tx, identities);
    const preferred = chooseTagRule(tags, rules, available.map(a => a.identity));
    const targets = preferred ? [preferred.preferred_agent] : normalTargets(available.filter(a => normal.includes(a.identity)), route);
    const timeout = preferred ? preferred.ring_seconds : ringTime(route);
    const plan = { stage: preferred ? 'preferred' : 'normal', preferred: preferred?.preferred_agent || null,
      matchedTag: preferred?.label || null, normal, timeout, fallbackTimeout: ringTime(route) };
    await reserve(tx, callSid, targets, timeout);
    await tx.query(`UPDATE calls SET route_targets=$2,routing_decided_at=now(),routing_plan=$3 WHERE twilio_call_sid=$1`,
      [callSid, JSON.stringify(targets), JSON.stringify(plan)]);
    return { targets, reason: preferred ? 'tag' : targets.length ? 'open' : 'unavailable', timeout };
  });
}

// Called once the preferred ring attempt ends without an answer. The provider
// holds the call-row lock; this reservation decision commits with its next legs.
export async function fallbackTargets(callSid, tx, now = new Date()) {
  const call = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [callSid])).rows[0];
  const plan = call?.routing_plan;
  if (!call || call.ended_at || plan?.stage !== 'preferred') return null;
  await tx.query('SELECT pg_advisory_xact_lock(7170701)');
  await tx.query('UPDATE agent_presence SET reserved_call_sid=NULL,reserved_until=NULL WHERE reserved_call_sid=$1', [callSid]);
  const eligible = config.auth.agents.filter(a => a.role !== 'viewer').map(a => a.identity);
  const identities = (plan.normal || []).filter(id => id !== plan.preferred && eligible.includes(id));
  const available = isOpen(config.voice.routing, now) ? await availableTargets(tx, identities) : [];
  const targets = normalTargets(available, config.voice.routing);
  const timeout = plan.fallbackTimeout || 20;
  await reserve(tx, callSid, targets, timeout);
  await tx.query(`UPDATE calls SET routing_plan=$2,route_targets=$3,agent_identity=NULL WHERE twilio_call_sid=$1`,
    [callSid, JSON.stringify({ ...plan, stage: 'fallback', timeout }), JSON.stringify(targets)]);
  return { targets, timeout };
}
