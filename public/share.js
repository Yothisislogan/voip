'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let token = location.hash.slice(1), socket, rtc, roomId, finished = false;
  history.replaceState(null, '', location.pathname); // Never send the bearer link in a referrer or request URL.
  const status = text => { $('shareStatus').textContent = text; };
  const send = message => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };
  function finish(text) {
    if (finished) return; finished = true;
    rtc?.close(); socket?.close(); token = ''; $('sharedScreen').srcObject = null;
    $('sharedScreen').hidden = true; $('leave').hidden = true; $('join').disabled = true; status(text);
  }
  if (!/^[\w-]{43}$/.test(token)) { status('This link is missing or invalid. Ask your agent for a new link.'); $('join').disabled = true; }
  $('joinForm').onsubmit = event => {
    event.preventDefault(); if (socket || finished) return;
    if (!window.RTCPeerConnection) return status('This browser does not support screen viewing. Open the link in a current browser.');
    $('join').disabled = true; status('Connecting…');
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/share`);
    socket.onopen = () => send({ type: 'join', token, name: $('visitorName').value });
    socket.onmessage = event => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'waiting') { roomId = m.roomId; token = ''; $('joinForm').hidden = true; $('leave').hidden = false; status('Waiting for your agent to approve you…'); }
      if (m.type === 'ready' && m.roomId === roomId && !rtc) {
        status('Connecting to the shared screen…');
        try { rtc = new window.WitRTC({ rtc: m.rtc, offerer: false, send: signal => send({ type: 'signal', roomId, signal }),
          onTrack: stream => { $('sharedScreen').srcObject = stream; $('sharedScreen').hidden = false; $('sharedScreen').play().catch(() => status('Press Play to view the screen.')); },
          onState: state => status(state === 'connected' ? 'Viewing your agent’s screen. View only.' : `Screen connection: ${state}`),
          onError: e => finish(e.message) }); } catch (e) { finish(e.message); }
      }
      if (m.type === 'signal' && m.roomId === roomId) rtc?.receive(m.signal);
      if (m.type === 'ended') finish(m.reason === 'declined' ? 'Your request was declined.' : 'Screen sharing ended. Ask your agent for a new link to reconnect.');
      if (m.type === 'error') finish(m.message);
    };
    socket.onclose = () => finish('Screen sharing disconnected. Ask your agent for a new link.');
    socket.onerror = () => finish('Unable to connect to screen sharing.');
  };
  $('leave').onclick = () => { send({ type: 'end', roomId }); finish('You left the screen share.'); };
  window.addEventListener('pagehide', () => finish('Screen sharing ended.'));
})();
