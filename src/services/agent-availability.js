import { db } from '../db.js';
import { config } from '../config.js';
import { collaborationHub } from '../realtime/collaboration.js';
import { workspaceOnline } from '../realtime/workspace-presence.js';

export const PRESENCE_MAX_AGE_MS = 45000;
export function agentStatus({ presence, activeCall = false, internalCall = false,
  connected = false, callingEnabled = true, now = Date.now() }) {
  const result = (color, reason, label) => ({ color, reason, label, available: color === 'green' });
  if (!callingEnabled) return result('red', 'phone_not_configured', 'Phone not configured');
  if (!connected) return result('red', 'disconnected', 'Workspace offline');
  const age = now - new Date(presence?.heartbeat_at || 0).getTime();
  if (!presence || !Number.isFinite(age) || age < -5000 || age >= PRESENCE_MAX_AGE_MS)
    return result('red', 'stale', 'Connection lost');
  if (activeCall || internalCall || presence.status === 'busy') return result('red', 'busy', 'On a call');
  if (!presence.phone_registered || presence.status === 'offline') return result('red', 'offline', 'Phone offline');
  if (presence.status === 'dnd') return result('red', 'dnd', 'Do not disturb');
  if (new Date(presence.reserved_until || 0).getTime() > now) return result('yellow', 'reserved', 'Call offered');
  if (presence.status === 'wrapup') return result('yellow', 'wrapup', 'After-call work');
  if (presence.status === 'away') return result('yellow', 'away', 'Away');
  if (presence.status === 'available') return result('green', 'available', 'Ready');
  return result('red', 'unknown', 'Unavailable');
}
export function callingConfigured(agent) {
  if (config.voiceProvider === 'telnyx') return !!(config.telnyx.apiKey && config.telnyx.connectionId
    && config.telnyx.callerId && agent.telnyxCredentialId && agent.telnyxSipUsername);
  return !!(config.twilio.accountSid && config.twilio.apiKeySid && config.twilio.apiKeySecret
    && config.twilio.twimlAppSid && config.twilio.callerId);
}
export async function getAgentAvailability({ identities, connection = db, now = Date.now() } = {}) {
  if (!db.enabled) throw Object.assign(new Error('Availability database unavailable'), { status: 503 });
  // More than one login may map to the same phone identity; capacity is per phone.
  const directory = [...new Map(config.auth.agents
    .filter(a => a.role !== 'viewer' && (!identities || identities.includes(a.identity)))
    .map(a => [a.identity, a])).values()];
  if (!directory.length) return [];
  const rows = (await connection.query({
    text: `SELECT p.*, EXISTS(SELECT 1 FROM calls c WHERE c.ended_at IS NULL
      AND c.status IN ('queued','ringing','in_progress') AND (c.agent_identity=p.identity
        OR (c.agent_identity IS NULL AND c.route_targets ? p.identity))) AS active_call
      FROM agent_presence p WHERE p.identity=ANY($1::text[])`,
    values: [directory.map(a => a.identity)], query_timeout: 750,
  })).rows;
  return directory.map(agent => {
    const presence = rows.find(p => p.identity === agent.identity);
    return { identity: agent.identity, name: agent.name || agent.identity,
      ...agentStatus({ presence, activeCall: !!presence?.active_call, internalCall: collaborationHub.busy(agent.identity),
        connected: workspaceOnline(agent.identity, now, PRESENCE_MAX_AGE_MS), callingEnabled: callingConfigured(agent), now }),
      heartbeatAt: presence?.heartbeat_at || null };
  });
}
