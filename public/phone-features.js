'use strict';
window.WitFeatures = (() => {
  const $ = id => document.getElementById(id);
  const el = (tag, text) => { const n = document.createElement(tag); n.textContent = text; return n; };
  let app, socket, screen, voice, team = [], peer = '', messages = [], attempt, sending = false, poll, retry, stopped = false, selected;
  const drafts = new Map();
  const send = m => { if (socket?.readyState !== 1) throw new Error('Team connection is offline. Reconnect before continuing.'); socket.send(JSON.stringify(m)); };
  const stopStream = s => s?.getTracks().forEach(t => t.stop());
  const signalEnd = id => { if (id && socket?.readyState === 1) send({ type: 'end', roomId: id }); };
  const status = (id, text) => { $(id).textContent = text; };
  const name = id => team.find(t => t.identity === id)?.name || id;
  function finishScreen(text = 'Screen sharing stopped.', notify = true) {
    const s = screen; screen = null; if (notify) signalEnd(s?.id); s?.rtc?.close(); stopStream(s?.stream);
    $('screenPreview').srcObject = null; $('screenPreview').hidden = true; $('shareDetails').hidden = true; $('viewerApproval').hidden = true;
    $('shareLink').value = ''; $('startShare').disabled = false; status('screenStatus', text);
  }
  function finishVoice(text = 'Internal call ended.', notify = true) {
    const v = voice; voice = null; if (notify) signalEnd(v?.id); v?.rtc?.close(); stopStream(v?.stream);
    $('officeAudio').srcObject = null; $('officeIncoming').hidden = true; $('officeEnd').disabled = true; $('officeMute').disabled = true;
    $('officeMute').textContent = 'Mute'; app?.setInternalBusy(false); status('officeCallStatus', text);
  }
  function startRTC(m, session) {
    if (session.rtc) return;
    session.rtc = new window.WitRTC({ rtc: m.rtc, stream: session.stream, offerer: m.offerer,
      send: signal => send({ type: 'signal', roomId: m.roomId, signal }),
      onTrack: stream => { if (m.kind === 'voice') { $('officeAudio').srcObject = stream; $('officeAudio').play().catch(() => status('officeCallStatus', 'Press Play below to hear your teammate.')); } },
      onState: state => status(m.kind === 'screen' ? 'screenStatus' : 'officeCallStatus', state === 'connected' ? (m.kind === 'screen' ? 'Viewer connected. They can see your selected screen or tab.' : `Connected with ${name(session.peer)}`) : `Media: ${state}`),
      onError: e => m.kind === 'screen' ? finishScreen(e.message) : finishVoice(e.message) });
  }
  function connect() {
    if (stopped) return;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/collaboration`);
    socket.onopen = () => { status('officeStatus', 'Team connection online'); refreshTeam().catch(e => app.toast(e.message)); };
    socket.onmessage = event => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      try {
        if (m.type === 'incoming') {
          if (voice || app.isPhoneBusy() || ['dnd','away','wrapup'].includes($('presence').value)) { signalEnd(m.roomId); return; }
          voice = { id: m.roomId, peer: m.from }; app.setInternalBusy(true);
          $('officeIncoming').hidden = false; $('officeAnswer').disabled = false; $('officeEnd').disabled = false;
          status('officeCallStatus', `${name(m.from)} is calling you`); app.toast(`Internal call from ${name(m.from)}`);
          if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('WiT Connect internal call', { body: name(m.from) });
        }
        if (m.type === 'outgoing' && voice) voice.id = m.roomId;
        if (m.type === 'viewer_waiting' && m.roomId === screen?.id) { $('viewerApproval').hidden = false; status('viewerName', `${m.name} requests to view your screen. Confirm this is the person on your call.`); }
        if (m.type === 'viewer_left') $('viewerApproval').hidden = true;
        if (m.type === 'ready') {
          const session = m.kind === 'screen' ? screen : voice;
          if (session?.id === m.roomId) { $('viewerApproval').hidden = true; if (m.kind === 'voice') { $('officeIncoming').hidden = true; $('officeMute').disabled = false; } startRTC(m, session); }
        }
        if (m.type === 'signal') (m.roomId === screen?.id ? screen : m.roomId === voice?.id ? voice : null)?.rtc?.receive(m.signal);
        if (m.type === 'ended') {
          if (m.roomId === screen?.id) finishScreen(`Screen sharing ${m.reason}.`, false);
          if (m.roomId === voice?.id) finishVoice(`Internal call ${m.reason}.`, false);
        }
        if (m.type === 'office_message') { refreshTeam().catch(() => {}); if ([m.sender,m.recipient].includes(peer)) loadMessages().catch(e => app.toast(e.message)); }
        if (m.type === 'error') { app.toast(m.message); if (voice) finishVoice(m.message); if (screen) finishScreen(m.message); }
      } catch (e) { app.toast(e.message); if (voice) finishVoice(e.message); if (screen) finishScreen(e.message); }
    };
    socket.onclose = event => {
      finishScreen('Screen sharing disconnected.', false); finishVoice('Internal call disconnected.', false);
      status('officeStatus', 'Team connection offline');
      // Never fight another tab or retry an expired login indefinitely.
      if (!stopped && event.code !== 1000 && event.code !== 1008) retry = setTimeout(connect, 5000);
      else if (!stopped) status('officeStatus', 'Team connection closed. Reload this workspace to reconnect.');
    };
    socket.onerror = () => status('officeStatus', 'Team connection unavailable');
  }
  async function refreshTeam() {
    const result = await app.api('/api/office/team'); team = result.teammates;
    $('officePeer').replaceChildren(el('option', 'Choose a teammate…'), ...team.map(t => {
      const option = el('option', `${t.name} · ${t.busy ? 'in a call' : t.online ? 'online' : 'offline'}${t.unread ? ` · ${t.unread} unread` : ''}`); option.value = t.identity; return option;
    })); $('officePeer').options[0].value = ''; $('officePeer').value = peer;
    $('officeCall').disabled = !peer || !!voice || !team.find(t => t.identity === peer)?.online;
    status('relayStatus', result.relayConfigured ? '' : 'A TURN relay has not been configured. Screen sharing and internal audio may fail across networks.');
  }
  function renderMessages() {
    $('officeThread').replaceChildren(...messages.map(m => {
      const p = el('div', ''); p.className = `office-message ${m.sender === app.me.identity ? 'sent' : ''}`;
      p.append(el('strong', `${name(m.sender)} · ${new Date(m.created_at).toLocaleString()}`), el('p', m.body)); return p;
    }));
    if (!messages.length) $('officeThread').textContent = peer ? 'No messages yet.' : 'Choose a teammate to open a private conversation.';
  }
  async function markRead() {
    if (!peer || document.hidden || !messages.length) return;
    await app.post(`/api/office/messages/${encodeURIComponent(peer)}/read`, { throughId: messages[messages.length - 1].id });
  }
  async function loadMessages(older = false) {
    if (!peer) { messages = []; renderMessages(); return; }
    const requested = peer;
    const result = await app.api(`/api/office/messages/${encodeURIComponent(peer)}${older && messages.length ? `?before=${messages[0].id}` : ''}`);
    if (requested !== peer) return;
    if (older) messages = [...result.messages, ...messages];
    else { const byId = new Map(messages.map(m => [String(m.id),m])); for (const m of result.messages) byId.set(String(m.id),m); messages = [...byId.values()].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1); }
    $('officeOlder').disabled = result.messages.length < 100; renderMessages(); await markRead();
  }
  async function beginVoice() {
    if (!peer || voice || app.isPhoneBusy()) return app.toast('Choose an available teammate and finish your current call first.');
    const session = { peer }; voice = session; app.setInternalBusy(true); $('officeCall').disabled = true;
    try {
      if (socket?.readyState !== 1) throw new Error('Team connection is offline.');
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (voice !== session) { stopStream(session.stream); return; }
      const result = await app.post('/api/office/call', { peer: session.peer });
      if (voice !== session) { signalEnd(result.id); return; }
      session.id = result.id; $('officeEnd').disabled = false; status('officeCallStatus', `Calling ${name(session.peer)}…`);
    } catch (e) { if (voice === session) finishVoice(e.message); else stopStream(session.stream); }
  }
  async function init(bridge) {
    app = bridge;
    $('routingLink').hidden = app.me.role !== 'admin';
    $('experiencePanel').hidden = !app.me.experienceEnabled;
    $('experienceSummary').hidden = !app.me.experienceEnabled || app.me.role !== 'admin';
    $('scoreCall').onclick = async () => {
      if (!selected) return; const sid = selected.call.twilio_call_sid;
      $('scoreCall').disabled = true;
      try { await app.post(`/api/phone/calls/${encodeURIComponent(sid)}/experience`, {}); status('experienceResult', 'Assessment queued. Refresh the call to see its result.'); }
      catch (e) { app.toast(e.message); }
      finally { if (selected?.call.twilio_call_sid === sid) $('scoreCall').disabled = false; }
    };
    $('refreshExperience').onclick = summary;
    if (app.me.experienceEnabled && app.me.role === 'admin') summary();
    if (!app.me.collaborationEnabled || app.me.role === 'viewer') return;
    $('collaborationPanel').hidden = false; $('screenPanel').hidden = false;
    $('officePeer').onchange = () => { drafts.set(peer, $('officeText').value); peer = $('officePeer').value; attempt = null; messages = []; $('officeText').value = drafts.get(peer) || ''; $('officeSend').disabled = !peer; loadMessages().catch(e => app.toast(e.message)); refreshTeam().catch(() => {}); };
    $('officeOlder').onclick = () => loadMessages(true).catch(e => app.toast(e.message));
    $('officeMessageForm').onsubmit = async e => {
      e.preventDefault(); const body = $('officeText').value.trim(), target = peer; if (!body || !target || sending) return;
      if (!attempt || attempt.body !== body || attempt.peer !== target) attempt = { body, peer: target, clientId: crypto.randomUUID() };
      const current = attempt; sending = true; $('officeSend').disabled = true;
      try { await app.post(`/api/office/messages/${encodeURIComponent(target)}`, current);
        drafts.delete(target); if (peer === target && $('officeText').value.trim() === body) $('officeText').value = '';
        if (attempt === current) attempt = null; await loadMessages(); status('officeMessageStatus', 'Sent');
      } catch (e) { status('officeMessageStatus', `Send not confirmed: ${e.message}. Retry uses the same message ID.`); }
      finally { sending = false; $('officeSend').disabled = !peer; }
    };
    $('officeCall').onclick = beginVoice;
    $('officeAnswer').onclick = async () => {
      const session = voice; if (!session || session.stream) return; $('officeAnswer').disabled = true;
      try { session.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (voice !== session) return stopStream(session.stream);
        send({ type: 'accept', roomId: session.id });
      } catch (e) { if (voice === session) finishVoice(e.message); else stopStream(session.stream); }
    };
    $('officeDecline').onclick = () => finishVoice('Internal call declined.'); $('officeEnd').onclick = () => finishVoice();
    $('officeMute').onclick = () => { if (!voice?.stream) return; const tracks = voice.stream.getAudioTracks(); const enabled = !tracks[0]?.enabled; tracks.forEach(t => { t.enabled = enabled; }); $('officeMute').textContent = enabled ? 'Mute' : 'Unmute'; };
    $('startShare').onclick = async () => {
      if (screen) return;
      if (!navigator.mediaDevices?.getDisplayMedia) return app.toast('Screen sharing requires HTTPS and a supported desktop browser.');
      const session = {}; screen = session; $('startShare').disabled = true;
      try {
        session.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (screen !== session) return stopStream(session.stream);
        const result = await app.post('/api/office/screen', {});
        if (screen !== session) { signalEnd(result.id); return; }
        Object.assign(session, { id: result.id });
        session.stream.getVideoTracks()[0].addEventListener('ended', () => { if (screen === session) finishScreen(); });
        if (session.stream.getVideoTracks()[0].readyState === 'ended') return finishScreen();
        $('screenPreview').srcObject = session.stream; $('screenPreview').hidden = false; $('shareLink').value = result.url; $('shareDetails').hidden = false;
        status('screenStatus', `Send this link to your customer. Expires ${new Date(result.expiresAt).toLocaleTimeString()}. Approve the viewer before they can see anything.`);
      } catch (e) { if (screen === session) finishScreen(e.message); else stopStream(session.stream); }
    };
    $('copyShare').onclick = async () => { try { await navigator.clipboard.writeText($('shareLink').value); status('copyStatus', 'Link copied'); } catch { $('shareLink').select(); status('copyStatus', 'Select and copy the link above.'); } };
    $('stopShare').onclick = () => finishScreen();
    $('approveViewer').onclick = () => { try { send({ type: 'accept', roomId: screen.id }); $('viewerApproval').hidden = true; } catch(e) { app.toast(e.message); } };
    $('declineViewer').onclick = () => { try { send({ type: 'decline_viewer', roomId: screen.id }); } catch(e) { app.toast(e.message); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { markRead().catch(() => {}); refreshTeam().catch(() => {}); } });
    connect(); poll = setInterval(() => { refreshTeam().catch(() => {}); loadMessages().catch(() => {}); }, 15000);
  }
  function render(detail) {
    selected = detail; if (!app?.me.experienceEnabled) return;
    const x = detail.experience; $('scoreCall').disabled = !detail.call.ended_at || app.me.role === 'viewer';
    $('experienceResult').replaceChildren();
    if (!x) { status('experienceResult', detail.call.ended_at ? 'No assessment yet.' : 'Available after the call ends.'); return; }
    const target = $('experienceResult');
    if (x.state === 'ready') {
      target.append(el('p', `Predicted satisfaction: ${x.csat ?? 'Not enough evidence'}${x.csat == null ? '' : ' / 5'}`),
        el('p', `Predicted likelihood to recommend: ${x.recommendation ?? 'Not enough evidence'}${x.recommendation == null ? '' : ' / 10'}`));
    }
    target.append(el('p', x.reason), el('small', `${x.confidence} confidence · ${x.backend} · ${x.rubric_version}${x.partial_transcript ? ' · Incomplete transcript' : ''}`));
    for (const quote of x.evidence || []) target.append(el('blockquote', quote));
  }
  async function summary() {
    try { const s = await app.api('/api/phone/experience-summary');
      status('experienceSummaryResult', `Last 30 days · ${s.assessed} assessed calls · Average predicted satisfaction: ${s.csatAverage ?? '—'} / 5 (${s.csatCount} scored) · Projected NPS: ${s.projectedNps ?? '—'} (${s.recommendationCount} predictions; ${s.promoters} promoters, ${s.passives} passives, ${s.detractors} detractors). ${s.unscored} calls without a usable assessment.`);
    } catch(e) { status('experienceSummaryResult', e.message); }
  }
  function close() { if (stopped) return; stopped = true; clearInterval(poll); clearTimeout(retry); finishScreen(); finishVoice(); socket?.close(); }
  window.addEventListener('pagehide', () => { if (app) close(); });
  return { init, render, close, busy: () => !!(voice || screen), hasDraft: () => !!$('officeText')?.value || [...drafts.values()].some(Boolean) };
})();
