/* global Twilio */
'use strict';
const $ = id => document.getElementById(id);
const state = { me: null, device: null, registered: false, call: null, callSid: null, selectedSid: null,
  selected: null, calls: [], view: 'calls', offset: 0, muted: false, started: null, conversation: null,
  drafts: new Map(), dialing: false, sending: false, messageAttempt: null, conversations: [], ws: null, reconnect: 0, closing: false, loading: false };
let toastTimer, refreshTimer;
const csrf = () => decodeURIComponent(document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('wit_csrf='))?.split('=')[1] || '');
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), ...options.headers } });
  if (response.status === 401) { state.closing = true; state.device?.destroy(); location.href = '/login'; throw new Error('Session expired'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function pretty(value) { return String(value || '').replaceAll('_', ' '); }
function time(value) { return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
function link(label, href) { const a = node('a', label); a.href = href; return a; }
function requestRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadHistory().catch(e => toast(e.message)), 600); }

async function loadHistory(append = false) {
  if (state.loading) return;
  state.loading = true;
  $('historyStatus').textContent = 'Loading…';
  try {
    if (state.view === 'messages') {
      const result = await api('/messaging/conversations');
      state.conversations = result.conversations || [];
      $('history').replaceChildren(...state.conversations.map(c => {
        const b = node('button', null, 'call-row'); b.append(node('strong', c.contact?.fullName || c.customerRef || 'Text conversation'), node('small', c.channel));
        b.onclick = () => selectConversation(c); return b;
      }));
      if (state.conversation) {
        const current = state.conversations.find(c => c.conversationId === state.conversation.conversationId);
        if (current) selectConversation(current, false);
      }
      $('historyStatus').textContent = state.conversations.length ? '' : 'No assigned text conversations.';
      $('more').hidden = true;
      return;
    }
    if (!append) state.offset = 0;
    const params = new URLSearchParams({ limit: '30', offset: String(state.offset), q: $('search').value,
      status: state.view === 'voicemail' ? 'voicemail' : '' });
    const { calls } = await api(`/api/phone/calls?${params}`);
    state.calls = append ? [...state.calls, ...calls] : calls;
    $('history').replaceChildren(...state.calls.map(c => {
      const b = node('button', null, `call-row${state.selectedSid === c.twilio_call_sid ? ' selected' : ''}`);
      b.append(node('strong', c.customer_name || c.customer_number || (c.source_number ? 'SmartFinancial transfer' : c.from_e164 || 'Unknown caller')),
        node('small', `${c.direction || 'Call'} · ${pretty(c.status)} · ${time(c.created_at)}`));
      if (c.is_voicemail) b.append(node('small', 'Voicemail'));
      b.onclick = () => selectCall(c.twilio_call_sid).catch(e => toast(e.message)); return b;
    }));
    $('historyStatus').textContent = state.calls.length ? `${state.calls.length} calls` : 'No calls found.';
    $('more').hidden = calls.length < 30;
    state.offset += calls.length;
  } catch (error) { $('historyStatus').textContent = error.message; }
  finally { state.loading = false; }
}

function renderTranscript(segments) {
  $('transcript').replaceChildren(...segments.map(s => { const p = node('div', null, 'utterance'); p.append(node('strong', pretty(s.speaker)), node('span', s.text)); return p; }));
  if (!segments.length) $('transcript').textContent = 'No transcript received. Recording and call status remain available independently.';
}
function renderRecap(call) {
  $('recap').textContent = call.recap?.summary || `Recap: ${pretty(call.recap_state || 'waiting')}`;
  $('actionItems').replaceChildren(...(call.recap?.action_items || call.recap?.nextSteps || []).map(item => node('li', typeof item === 'string' ? item.text || item : item.text || item.description || JSON.stringify(item))));
  $('retryRecap').disabled = (!call.ended_at && !call.transcript_stopped_at) || state.me?.role === 'viewer';
}
async function selectCall(sid) {
  state.selectedSid = sid;
  $('messagesPanel').hidden = true;
  const detail = await api(`/api/phone/calls/${encodeURIComponent(sid)}`);
  if (state.selectedSid !== sid) return;
  state.selected = detail;
  const c = detail.call;
  const listed = state.calls.find(x => x.twilio_call_sid === sid);
  $('customer').textContent = listed?.customer_name || c.customer_number || (c.source_number ? 'SmartFinancial transfer' : c.from_e164 || 'Call details');
  $('customerMeta').textContent = [c.customer_number, c.agent_identity ? `Handled by ${c.agent_identity}` : 'Not yet answered', time(c.created_at)].filter(Boolean).join(' · ');
  $('callState').textContent = pretty(c.status || 'pending');
  $('identityBanner').hidden = !c.source_number;
  $('identityBanner').textContent = c.source_number ? `Transfer source: ${c.source_number}. Customer identity: ${pretty(c.identity_state)}. ${c.identity_state === 'suggested' ? 'Confirm the recent email below before linking this customer.' : ''}` : '';
  $('candidates').replaceChildren(...(detail.candidates || []).filter(x => !x.claimed_call_sid || x.claimed_call_sid === sid).map(candidate => {
    const box = node('div', null, 'candidate'); box.append(node('strong', candidate.customer_name || 'Email lead'), node('div', [candidate.business_name, candidate.customer_phone, candidate.customer_email, time(candidate.received_at)].filter(Boolean).join(' · ')));
    const button = node('button', 'Confirm this customer'); button.disabled = state.me?.role === 'viewer';
    button.onclick = async () => { button.disabled = true; try { await post(`/api/phone/calls/${encodeURIComponent(sid)}/match`, { signalId: candidate.id }); await selectCall(sid); requestRefresh(); } catch(e) { toast(e.message); button.disabled = false; } };
    box.append(button); return box;
  }));
  $('links').replaceChildren();
  if (c.contact_id) $('links').append(link('Open customer', `/contacts.html?id=${encodeURIComponent(c.contact_id)}`));
  $('links').append(link('Link to this call', `/phone.html?call=${encodeURIComponent(sid)}`));
  const draft = state.drafts.get(sid);
  $('notes').value = draft?.notes ?? c.notes ?? '';
  $('disposition').value = draft?.disposition ?? c.disposition ?? '';
  $('saveNotes').disabled = state.me?.role === 'viewer';
  $('saveStatus').textContent = draft ? 'Unsaved changes' : '';
  renderRecap(c); renderTranscript(detail.segments || []);
  $('recordings').replaceChildren(...(detail.recordings || []).map(recording => {
    const box = node('div'); box.append(node('p', `${pretty(recording.kind)} · ${recording.duration_seconds ?? '?'} seconds · ${recording.status}`));
    if (recording.status === 'completed') { const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `/api/phone/calls/${encodeURIComponent(sid)}/recordings/${encodeURIComponent(recording.recording_sid)}`; box.append(audio); }
    return box;
  }));
  if (!detail.recordings?.length) $('recordings').textContent = 'No recording available.';
  updateControls();
}

function updateControls() {
  const connected = state.call && state.call.status() === 'open';
  $('call').disabled = !state.registered || !!state.call || state.dialing;
  $('enable').disabled = !state.me?.calling || !!state.call || state.dialing;
  $('end').disabled = !state.call;
  $('mute').disabled = !connected;
  $('transfer').disabled = !connected || state.selectedSid !== state.callSid || state.selected?.call.direction !== 'inbound';
  $('mute').textContent = state.muted ? 'Unmute microphone' : 'Mute microphone';
}
async function presence() {
  if (!state.me || state.me.role === 'viewer') return;
  try { await post('/api/phone/presence', { status: !state.registered ? 'offline' : state.call ? 'busy' : $('presence').value }); }
  catch (error) { $('connection').textContent = `Availability update failed: ${error.message}`; }
}
async function freshToken() { return (await api('/token')).token; }
function cleanup(call) {
  if (state.call !== call) return;
  state.call = null; state.started = null; state.muted = false; $('incoming').hidden = true;
  $('timer').textContent = '00:00'; $('controlStatus').textContent = 'Call ended. Save your notes and outcome.';
  updateControls(); presence(); requestRefresh();
  const sid = state.callSid;
  setTimeout(() => { if (sid && state.selectedSid === sid) selectCall(sid).catch(() => {}); }, 2500);
}
function wireCall(call, incoming = false) {
  state.call = call;
  state.callSid = call.customParameters?.get('rootCallSid') || call.parameters.CallSid || null;
  call.on('accept', () => {
    state.callSid = call.customParameters?.get('rootCallSid') || call.parameters.CallSid;
    state.started = Date.now(); $('incoming').hidden = true;
    $('controlStatus').textContent = 'Connected. Keypad buttons send touch tones during the call.';
    updateControls(); presence();
    if (state.callSid) selectCall(state.callSid).catch(e => toast(e.message));
  });
  for (const event of ['disconnect','cancel','reject']) call.on(event, () => cleanup(call));
  call.on('error', error => { toast(error.message || 'Call failed'); cleanup(call); });
  call.on('warning', warning => { $('controlStatus').textContent = `Call quality: ${warning}. Check your microphone and connection.`; });
  call.on('reconnecting', () => { $('controlStatus').textContent = 'Reconnecting call audio…'; });
  call.on('reconnected', () => { $('controlStatus').textContent = 'Call audio reconnected.'; });
  if (incoming) {
    $('incomingNumber').textContent = call.parameters.From || 'Unknown caller'; $('incoming').hidden = false;
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Incoming WiT call', { body: 'Return to WiT Connect to answer.' });
    if (state.callSid) selectCall(state.callSid).catch(() => {});
  }
  updateControls(); presence();
}
async function audioDevices() {
  if (!state.device?.audio) return;
  const fill = (select, devices) => {
    const value = select.value; select.replaceChildren(...[...devices.values()].map(d => { const option = node('option', d.label || d.deviceId); option.value = d.deviceId; return option; }));
    if ([...select.options].some(o => o.value === value)) select.value = value;
  };
  fill($('microphone'), state.device.audio.availableInputDevices);
  fill($('speaker'), state.device.audio.availableOutputDevices);
  $('speaker').disabled = !Twilio.Device.isSupported || !state.device.audio.isOutputSelectionSupported;
}
async function enablePhone() {
  if (state.call || state.dialing) return;
  $('enable').disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Calling requires HTTPS and microphone access.');
    if (!window.Twilio?.Device) throw new Error('Phone SDK failed to load. Refresh the page.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop());
    if (state.device) state.device.destroy();
    const device = new Twilio.Device(await freshToken(), { codecPreferences: ['opus','pcmu'], tokenRefreshMs: 60000, allowIncomingWhileBusy: false });
    state.device = device;
    device.on('registered', () => { state.registered = true; $('deviceStatus').textContent = 'Phone connected'; $('enable').textContent = 'Reconnect phone'; $('enable').disabled = false; updateControls(); presence(); audioDevices(); });
    device.on('unregistered', () => { state.registered = false; $('deviceStatus').textContent = 'Phone disconnected'; updateControls(); presence(); });
    device.on('error', error => { $('deviceStatus').textContent = 'Phone error'; toast(error.message || 'Phone connection failed'); });
    device.on('tokenWillExpire', async () => { try { device.updateToken(await freshToken()); } catch(e) { toast(`Token refresh failed: ${e.message}`); state.registered = false; updateControls(); presence(); } });
    device.on('incoming', call => { if (state.call || state.dialing || $('presence').value !== 'available') { call.reject(); return; } wireCall(call, true); });
    device.audio.on('deviceChange', audioDevices);
    await device.register();
  } catch (error) { state.registered = false; $('deviceStatus').textContent = 'Phone unavailable'; toast(error.message); }
  finally { $('enable').disabled = false; updateControls(); }
}

function connectWS() {
  if (state.closing) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`);
  state.ws = socket;
  socket.onopen = () => { state.reconnect = 0; $('connection').textContent = 'Live updates connected'; requestRefresh(); };
  socket.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'message') { if (state.view === 'messages') requestRefresh(); return; }
    if (message.type === 'call_status') { requestRefresh(); return; }
    // Do not replace a different call's transcript or customer card.
    if (message.callSid !== state.selectedSid) return;
    if (message.type === 'screenpop') {
      if (message.contact?.fullName) $('customer').textContent = message.contact.fullName;
      if (message.phone) $('customerMeta').textContent = message.phone;
      return;
    }
    if (message.type === 'transcript') {
      const p = node('div', null, 'utterance'); p.append(node('strong', pretty(message.speaker)), node('span', message.text)); $('transcript').append(p); $('transcript').scrollTop = $('transcript').scrollHeight;
    }
    if (message.type === 'coaching') $('coaching').replaceChildren(...(message.cues || []).map(c => node('div', c.text, 'cue')));
    if (message.type === 'recap') { renderRecap({ recap: message.recap, recap_state: 'ready', ended_at: true }); requestRefresh(); }
  };
  socket.onclose = () => { $('connection').textContent = 'Live updates disconnected; reconnecting…'; if (!state.closing) setTimeout(connectWS, Math.min(30000, 1000 * 2 ** state.reconnect++) + Math.random() * 500); };
}

function selectConversation(c, scroll = true) {
  state.conversation = c; $('messagesPanel').hidden = false;
  $('customer').textContent = c.contact?.fullName || c.customerRef || 'Text conversation';
  $('thread').replaceChildren(...(c.messages || []).map(m => node('p', m.text, `message ${m.from}`)));
  if (scroll) $('messagesPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function operations() {
  if (state.me?.role !== 'admin') return;
  try {
    const result = await api('/api/phone/operations'); $('operationsPanel').hidden = false;
    $('metrics').replaceChildren(...Object.entries(result.metrics).map(([key, value]) => { const box = node('div', null, 'metric'); box.append(node('b', value ?? '—'), node('small', pretty(key))); return box; }));
    $('jobs').replaceChildren(node('p', `${result.jobs.length} pending or failed background jobs. WiTnext: ${result.bridgeConfigured ? 'configured' : 'not configured'}.`, 'muted'));
    for (const job of result.jobs) {
      const row = node('div', `${job.kind} · ${job.state} · attempt ${job.attempts}${job.error ? ` · ${job.error}` : ''}`, 'job');
      if (job.state === 'failed') { const button = node('button', 'Retry'); button.onclick = async () => { try { await post(`/api/phone/jobs/${job.id}/retry`, {}); await operations(); } catch(e) { toast(e.message); } }; row.append(button); }
      $('jobs').append(row);
    }
    $('presenceList').textContent = result.agents.map(a => `${a.identity}: ${a.status}`).join(' · ');
  } catch(e) { toast(e.message); }
}

$('enable').onclick = enablePhone;
$('presence').onchange = presence;
$('microphone').onchange = async () => { try { await state.device.audio.setInputDevice($('microphone').value); } catch(e) { toast(e.message); } };
$('speaker').onchange = async () => { try { await state.device.audio.speakerDevices.set($('speaker').value); await state.device.audio.ringtoneDevices.set($('speaker').value); } catch(e) { toast(e.message); } };
$('notifications').onclick = async () => { if ('Notification' in window) toast(`Call notifications: ${await Notification.requestPermission()}`); else toast('Browser notifications are unavailable.'); };
$('dialForm').onsubmit = async event => {
  event.preventDefault(); if (!state.device || !state.registered || state.call || state.dialing) return;
  const to = $('number').value.trim(); if (!to) return toast('Enter a phone number.');
  state.dialing = true; updateControls();
  try { wireCall(await state.device.connect({ params: { To: to } })); $('controlStatus').textContent = `Calling ${to}…`; }
  catch(e) { toast(e.message); }
  finally { state.dialing = false; updateControls(); }
};
$('accept').onclick = () => state.call?.accept();
$('reject').onclick = () => state.call?.reject();
$('end').onclick = () => state.call?.disconnect();
$('mute').onclick = () => { if (!state.call) return; state.muted = !state.muted; state.call.mute(state.muted); updateControls(); };
$('transfer').onclick = async () => {
  const identity = $('transferTarget').value; if (!identity || !state.callSid) return toast('Choose an agent to transfer to.');
  $('transfer').disabled = true;
  try { await api(`/api/phone/calls/${encodeURIComponent(state.callSid)}/transfer`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ identity }) }); toast('Transfer requested. The receiving agent is being called.'); }
  catch(e) { toast(e.message); }
};
for (const digit of '123456789*0#') { const button = node('button', digit); button.type = 'button'; button.setAttribute('aria-label', `Key ${digit}`); button.onclick = () => { if (state.call?.status() === 'open') state.call.sendDigits(digit); else $('number').value += digit; }; $('keypad').append(button); }
const rememberDraft = () => {
  if (!state.selectedSid) return;
  state.drafts.set(state.selectedSid, { notes: $('notes').value, disposition: $('disposition').value });
  $('saveStatus').textContent = 'Unsaved changes';
};
$('notes').oninput = rememberDraft; $('disposition').onchange = rememberDraft;
$('notesForm').onsubmit = async event => {
  event.preventDefault(); if (!state.selectedSid) return;
  const sid = state.selectedSid;
  const draft = { notes: $('notes').value, disposition: $('disposition').value };
  $('saveNotes').disabled = true; $('saveStatus').textContent = 'Saving…';
  try {
    await api(`/api/phone/calls/${encodeURIComponent(sid)}`, { method: 'PATCH', body: JSON.stringify({ notes: draft.notes, ...(draft.disposition ? { disposition: draft.disposition } : {}) }) });
    if (JSON.stringify(state.drafts.get(sid)) === JSON.stringify(draft)) state.drafts.delete(sid);
    if (sid === state.selectedSid) $('saveStatus').textContent = state.drafts.has(sid) ? 'Unsaved changes' : 'Saved.';
  } catch(e) { if (sid === state.selectedSid) $('saveStatus').textContent = e.message; }
  finally { $('saveNotes').disabled = state.me?.role === 'viewer'; }
};
$('retryRecap').onclick = async () => { if (!state.selectedSid) return; try { await post(`/api/phone/calls/${encodeURIComponent(state.selectedSid)}/recap`, {}); toast('Recap queued for processing.'); } catch(e) { toast(e.message); } };
$('messageForm').onsubmit = async event => {
  event.preventDefault(); if (!state.conversation || state.sending) return;
  const text = $('messageText').value.trim(); if (!text) return;
  const conversationId = state.conversation.conversationId;
  if (state.messageAttempt?.text !== text || state.messageAttempt?.conversationId !== conversationId) state.messageAttempt = { text, conversationId, key: crypto.randomUUID() };
  state.sending = true; $('sendMessage').disabled = true; $('messageStatus').textContent = 'Sending…';
  try {
    await api('/messaging/send', { method: 'POST', headers: { 'Idempotency-Key': state.messageAttempt.key }, body: JSON.stringify({ conversationId, text }) });
    state.messageAttempt = null;
    if (state.conversation.conversationId === conversationId && $('messageText').value.trim() === text) $('messageText').value = ''; $('messageStatus').textContent = 'Accepted by messaging provider.';
    $('thread').append(node('p', text, 'message agent'));
  } catch(e) { $('messageStatus').textContent = `Send not confirmed: ${e.message}`; }
  finally { state.sending = false; $('sendMessage').disabled = false; }
};
$('logoutForm').onsubmit = async event => { event.preventDefault(); await post('/logout', {}).catch(() => {}); state.closing = true; state.device?.destroy(); location.href = '/login'; };
$('refresh').onclick = () => loadHistory(); $('more').onclick = () => loadHistory(true);
$('search').oninput = requestRefresh;
$('refreshOps').onclick = operations;
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { state.view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b === button))); loadHistory(); });
setInterval(presence, 25000);
setInterval(() => { if (state.started) { const seconds = Math.floor((Date.now() - state.started) / 1000); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; } }, 1000);
window.addEventListener('beforeunload', event => { if (state.call || state.drafts.size) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { toast('Network restored. Check phone connection.'); requestRefresh(); });
(async () => {
  try {
    state.me = await api('/api/phone/config'); $('who').textContent = state.me.identity;
    $('enable').disabled = !state.me.calling;
    if (!state.me.calling) $('deviceStatus').textContent = state.me.role === 'viewer' ? 'Read-only access' : 'Provider setup required';
    $('adminLink').hidden = state.me.role !== 'admin';
    for (const value of state.me.dispositions) { const option = node('option', pretty(value)); option.value = value; $('disposition').append(option); }
    for (const agent of state.me.agents) if (agent.identity !== state.me.identity) { const option = node('option', agent.name); option.value = agent.identity; $('transferTarget').append(option); }
    await loadHistory(); connectWS(); operations();
    const call = new URLSearchParams(location.search).get('call'); if (call) await selectCall(call);
  } catch(e) { $('historyStatus').textContent = e.message; $('deviceStatus').textContent = 'Setup required'; toast(e.message); }
})();
