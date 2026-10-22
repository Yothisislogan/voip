'use strict';
// Ordered signaling keeps early ICE candidates behind the remote description.
window.WitRTC = class {
  constructor({ rtc, stream, offerer, send, onTrack, onState, onError }) {
    this.pc = new RTCPeerConnection(rtc); this.closed = false; this.pending = []; this.queue = Promise.resolve();
    this.send = send; this.onError = onError;
    if (stream) for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
    this.pc.onicecandidate = e => { if (e.candidate) send({ candidate: e.candidate.toJSON() }); };
    this.pc.ontrack = e => onTrack(e.streams[0] || new MediaStream([e.track]));
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState; onState(state);
      if (state === 'connected') clearTimeout(this.deadline);
      if (state === 'failed') onError(new Error('Media connection failed. Check the TURN relay and network.'));
      clearTimeout(this.disconnected);
      if (state === 'disconnected') this.disconnected = setTimeout(() => onError(new Error('Media connection lost.')), 15000);
    };
    this.deadline = setTimeout(() => onError(new Error('Media connection timed out. Check the TURN relay and network.')), 30000);
    if (offerer) this.run(async () => {
      await this.pc.setLocalDescription(await this.pc.createOffer()); send({ description: this.pc.localDescription });
    });
  }
  run(fn) { this.queue = this.queue.then(() => { if (!this.closed) return fn(); }).catch(e => { if (!this.closed) this.onError(e); }); return this.queue; }
  receive(signal) { return this.run(async () => {
    if (signal.description) {
      await this.pc.setRemoteDescription(signal.description);
      for (const candidate of this.pending.splice(0)) await this.pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer()); this.send({ description: this.pc.localDescription });
      }
    } else if (signal.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(signal.candidate); else this.pending.push(signal.candidate);
    }
  }); }
  close() { this.closed = true; clearTimeout(this.deadline); clearTimeout(this.disconnected); this.pc.close(); }
};
