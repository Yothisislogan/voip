import { createPublicKey, verify, randomUUID, createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';

export const telnyxReady = () => Boolean(config.telnyx.apiKey && config.telnyx.connectionId && config.telnyx.callerId);
export const telnyxAgent = identity => config.auth.agents.find(a => a.identity === identity && a.role !== 'viewer');
export function sipDestination(identity) {
  const username = telnyxAgent(identity)?.telnyxSipUsername;
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(username || '')) throw new Error('Agent Telnyx SIP username is not configured');
  return `sip:${username}@sip.telnyx.com`;
}
export async function telnyxRequest(path, { method = 'GET', body, fetcher = fetch } = {}) {
  if (!config.telnyx.apiKey) throw new Error('Telnyx API key is not configured');
  const response = await fetcher(`https://api.telnyx.com/v2${path}`, {
    method, headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error(`Telnyx request failed (${response.status})`), { status: response.status });
  if (response.status === 204) return null;
  const text = await response.text();
  try { return JSON.parse(text).data; } catch { return text; }
}
export async function voiceToken(identity) {
  const id = telnyxAgent(identity)?.telnyxCredentialId;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Agent Telnyx credential ID is not configured');
  return telnyxRequest(`/telephony_credentials/${encodeURIComponent(id)}/token`, { method: 'POST' });
}
export function verifyTelnyxWebhook(raw, headers, now = Date.now()) {
  try {
    const timestamp = headers['telnyx-timestamp'];
    const signature = headers['telnyx-signature-ed25519'];
    if (!Buffer.isBuffer(raw) || !/^\d+$/.test(timestamp || '') || typeof signature !== 'string' ||
      Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const bytes = Buffer.from(config.telnyx.publicKey || '', 'base64');
    if (bytes.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

// Persist an intent BEFORE calling the provider. An ambiguous network result is
// never blindly retried (especially Dial); an operator must reconcile it first.
// Accepted responses make webhook replays safe after a later database rollback.
export async function telnyxCommand(key, path, body = {}) {
  const id = randomUUID();
  const normalized = { ...body };
  if (normalized.stream_url) { const url = new URL(normalized.stream_url); url.searchParams.delete('ticket'); normalized.stream_url = url.toString(); }
  const fingerprint = createHash('sha256').update(JSON.stringify([path, normalized])).digest('hex');
  const inserted = await db.query(`INSERT INTO telnyx_commands(command_key,command_id,request_hash,state)
    VALUES($1,$2,$3,'attempting') ON CONFLICT DO NOTHING RETURNING command_id`, [key, id, fingerprint]);
  if (!inserted.rows.length) {
    const prior = (await db.query('SELECT * FROM telnyx_commands WHERE command_key=$1', [key])).rows[0];
    if (prior.request_hash !== fingerprint) throw new Error('Telnyx command key was already used with different parameters');
    if (prior.state === 'accepted') return prior.response;
    throw new Error('Telnyx command outcome needs reconciliation; automatic resend blocked');
  }
  try {
    const response = await telnyxRequest(path, { method: 'POST', body: { ...body, command_id: id } });
    await db.query("UPDATE telnyx_commands SET state='accepted',response=$2 WHERE command_key=$1", [key, JSON.stringify(response || {})]);
    return response;
  } catch (error) {
    await db.query("UPDATE telnyx_commands SET state='uncertain' WHERE command_key=$1", [key]);
    throw error;
  }
}

export async function recordingDownload(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid recording ID');
  const recording = await telnyxRequest(`/recordings/${encodeURIComponent(id)}`);
  const url = new URL(recording?.download_urls?.mp3 || '');
  // Only URLs obtained through the authenticated Telnyx API, never webhook URLs.
  const hosts = config.telnyx.recordingHosts;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new Error('Recording host is not configured in TELNYX_RECORDING_HOSTS');
  }
  return url.toString();
}
