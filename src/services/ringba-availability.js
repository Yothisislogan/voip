import { config } from '../config.js';
import { getAgentAvailability } from './agent-availability.js';
import { isOpen, validateRouting } from './routing.js';

export function validateRingba() {
  const r = config.ringba, errors = [];
  if (!r.enabled) return errors;
  if (r.token.length < 32) errors.push('RINGBA_AVAILABILITY_TOKEN requires at least 32 characters.');
  if (!Number.isInteger(r.requestsPerMinute) || r.requestsPerMinute < 1 || r.requestsPerMinute > 60000)
    errors.push('RINGBA_AVAILABILITY_RATE_PER_MINUTE must be 1–60000.');
  if (!Array.isArray(r.campaigns) || !r.campaigns.length || r.campaigns.length > 100)
    return [...errors, 'RINGBA_AVAILABILITY_CAMPAIGNS_JSON requires 1–100 campaign pools.'];
  const ids = new Set(), directory = config.auth.agents.filter(a => a.role !== 'viewer').map(a => a.identity);
  for (const c of r.campaigns) {
    if (!c || typeof c !== 'object') { errors.push('Each Ringba campaign must be an object.'); continue; }
    if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id || '') || ids.has(c.id)) errors.push('Ringba campaign IDs must be unique, 1–80 letters/digits/underscore/hyphen.');
    ids.add(c.id);
    if (!Array.isArray(c.agents) || !c.agents.length || c.agents.some(id => !directory.includes(id)) || new Set(c.agents).size !== c.agents.length)
      errors.push(`Ringba campaign ${c.id}: list unique calling-enabled agent identities.`);
    if (typeof c.enabled !== 'boolean') errors.push(`Ringba campaign ${c.id}: enabled must be true or false.`);
    if (c.hours !== undefined || c.holidays !== undefined || c.timezone !== undefined)
      errors.push(...validateRouting({ ...c, agents: [directory[0]], strategy: 'fixed' }));
  }
  return errors;
}
export function deniedAvailability(campaign, reason, now = new Date()) {
  return { response: { available: 0, active: 0, accept: false, status: 'red' },
    campaign: typeof campaign === 'string' ? campaign : null, reason,
    generatedAt: now.toISOString(), snapshotOnly: true };
}
export async function ringbaAvailability(campaignId, { read = getAgentAvailability, now = new Date() } = {}) {
  if (!config.ringba.enabled) return deniedAvailability(campaignId, 'disabled', now);
  if (validateRingba().length || validateRouting(config.voice.routing).length)
    return deniedAvailability(campaignId, 'invalid_configuration', now);
  const campaign = config.ringba.campaigns.find(c => c.id === campaignId);
  if (!campaign) return deniedAvailability(campaignId, 'unknown_campaign', now);
  if (!campaign.enabled) return deniedAvailability(campaignId, 'campaign_paused', now);
  if (!isOpen(config.voice.routing, now) || !isOpen(campaign, now)) return deniedAvailability(campaignId, 'closed', now);
  // Only report agents the current inbound routing can actually offer the call to.
  const routed = config.voice.routing?.agents || [config.defaultAgentIdentity];
  const identities = campaign.agents.filter(id => routed.includes(id));
  const agents = await read({ identities, now: now.getTime() });
  const available = agents.filter(a => a.available && a.color === 'green').length;
  const active = agents.filter(a => !['disconnected','stale','offline','phone_not_configured'].includes(a.reason)).length;
  return { response: { available, active, accept: available > 0,
    status: available ? 'green' : agents.some(a => a.color === 'yellow') ? 'yellow' : 'red' },
    campaign: campaign.id, reason: available ? 'available' : 'no_ready_agents',
    generatedAt: now.toISOString(), snapshotOnly: true };
}
