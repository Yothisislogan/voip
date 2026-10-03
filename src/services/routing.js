import { db } from '../db.js';
import { config } from '../config.js';

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

export async function selectTargets(callSid, now = new Date()) {
  const route = config.voice.routing;
  if (!route) return { targets: [config.defaultAgentIdentity], reason: 'default', timeout: 20 };
  if (validateRouting(route).length) throw new Error('Invalid voice routing configuration');
  if (!isOpen(route, now)) return { targets: [], reason: 'closed', timeout: 20 };
  if (!db.enabled) return { targets: [], reason: 'unavailable', timeout: 20 };
  return db.transaction(async tx => {
    // Serialize offers, including across app processes: two calls cannot reserve
    // the same available agent between selection and reservation.
    await tx.query("SELECT pg_advisory_xact_lock(7170701)");
    const existing = await tx.query('SELECT route_targets,routing_decided_at FROM calls WHERE twilio_call_sid=$1', [callSid]);
    if (existing.rows[0]?.routing_decided_at) return { targets: existing.rows[0].route_targets, reason: 'retry', timeout: Math.max(5, Math.min(60, Number(route.ringSeconds) || 20)) };
    const { rows } = await tx.query(`SELECT * FROM agent_presence WHERE identity=ANY($1::text[])
      AND status='available' AND heartbeat_at>now()-interval '75 seconds'
      AND (reserved_until IS NULL OR reserved_until<now())
      AND NOT EXISTS(SELECT 1 FROM calls c WHERE c.agent_identity=agent_presence.identity AND c.status='in_progress')`, [route.agents]);
    const fixed = route.agents.map(id => rows.find(a => a.identity === id)).filter(Boolean);
    const available = orderAgents(fixed, route.strategy);
    const targets = (route.strategy === 'simultaneous' || !route.strategy ? available : available.slice(0, 1)).map(a => a.identity);
    const timeout = Math.max(5, Math.min(60, Number(route.ringSeconds) || 20));
    if (targets.length) await tx.query(`UPDATE agent_presence SET reserved_call_sid=$1,
      reserved_until=now()+$3 * interval '1 second',last_offered_at=now() WHERE identity=ANY($2::text[])`, [callSid, targets, timeout + 15]);
    await tx.query(`INSERT INTO calls(twilio_call_sid,route_targets,routing_decided_at,status) VALUES($1,$2,now(),'queued')
      ON CONFLICT(twilio_call_sid) DO UPDATE SET route_targets=$2,routing_decided_at=now()`, [callSid, JSON.stringify(targets)]);
    return { targets, reason: targets.length ? 'open' : 'unavailable', timeout };
  });
}
