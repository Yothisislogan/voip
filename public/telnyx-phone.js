/* global TelnyxWebRTC */
'use strict';
// Small SDK adapter keeps call controls shared with the existing phone UI.
class TelnyxCall {
  constructor(call) { this.raw = call; this.listeners = new Map(); this.accepted = false;
    const headers = call.options.customHeaders || [];
    const root = headers.find(h => h.name?.toLowerCase() === 'x-wit-call')?.value;
    this.parameters = { CallSid: root || null, From: call.options.remoteCallerNumber };
    this.customParameters = new Map(root ? [['rootCallSid', root]] : []);
  }
  on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  emit(type, value) { for (const fn of this.listeners.get(type) || []) fn(value); }
  status() { return this.raw.state === 'active' ? 'open' : this.raw.state; }
  accept() { return this.raw.answer(); }
  reject() { return this.raw.hangup(); }
  disconnect() { return this.raw.hangup(); }
  mute(value) { value ? this.raw.muteAudio() : this.raw.unmuteAudio(); }
  sendDigits(value) { this.raw.dtmf(value); }
}
class TelnyxPhone {
  constructor(token) {
    this.listeners = new Map(); this.calls = new Map();
    this.client = new TelnyxWebRTC.TelnyxRTC({ login_token: token });
    this.client.remoteElement = 'telnyxAudio';
    this.client.on('telnyx.ready', () => this.emit('registered'));
    this.client.on('telnyx.error', () => { this.emit('unregistered'); this.emit('error', { message: 'Telnyx connection failed. Reconnect your phone.' }); });
    this.client.on('telnyx.socket.close', () => this.emit('unregistered'));
    this.client.on('telnyx.notification', notification => {
      if (notification.type !== 'callUpdate' || !notification.call) return;
      const raw = notification.call;
      let call = this.calls.get(raw.id);
      if (!call) {
        call = new TelnyxCall(raw); this.calls.set(raw.id, call);
        this.emit('incoming', call);
      }
      if (raw.state === 'active' && !call.accepted) { call.accepted = true; call.emit('accept'); }
      if (['hangup','destroy','purge'].includes(raw.state)) { call.emit('disconnect'); this.calls.delete(raw.id); }
    });
    // Tokens last up to 24 hours. Refresh between calls rather than disconnect audio.
    this.refresh = setTimeout(() => this.emit('tokenWillExpire'), 23 * 60 * 60 * 1000);
  }
  on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  emit(type, value) { for (const fn of this.listeners.get(type) || []) fn(value); }
  register() { this.client.connect(); }
  destroy() { clearTimeout(this.refresh); this.client.disconnect(); }
}
window.TelnyxPhone = TelnyxPhone;
