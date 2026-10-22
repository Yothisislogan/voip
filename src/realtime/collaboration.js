import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { authenticateUpgrade } from '../auth/middleware.js';

const error = (message, status = 409) => Object.assign(new Error(message), { status });
const digest = token => createHash('sha256').update(token).digest('hex');
export function rtcConfiguration(now = Date.now()) {
  const iceServers = [];
  if (config.collaboration.stunUrls.length) iceServers.push({ urls: config.collaboration.stunUrls });
  if (config.collaboration.turnUrls.length && config.collaboration.turnSecret) {
    const username = `${Math.floor(now / 1000) + 3900}:${randomBytes(8).toString('hex')}`;
    iceServers.push({ urls: config.collaboration.turnUrls, username,
      credential: createHmac('sha1', config.collaboration.turnSecret).update(username).digest('base64') });
  }
  return { iceServers, iceTransportPolicy: config.collaboration.relayOnly ? 'relay' : 'all' };
}

// Single-instance signaling only: media travels browser-to-browser (or via TURN).
// A restart ends rooms and invalidates every share link. No screen content is stored.
export class CollaborationHub {
  constructor({ now = () => Date.now(), onEnd = () => {} } = {}) {
    this.now = now; this.onEnd = onEnd; this.agents = new Map(); this.rooms = new Map(); this.tokens = new Map();
  }
  send(ws, value) {
    if (ws?.readyState === 1 && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(value));
  }
  connect(ws, identity) {
    const old = this.agents.get(identity);
    if (old && old !== ws) { this.disconnect(old); old.close(1000, 'Workspace opened in another tab'); }
    ws.identity = identity; this.agents.set(identity, ws);
    this.send(ws, { type: 'connected' });
  }
  busy(identity) { return [...this.rooms.values()].some(r => r.kind === 'voice' && [r.owner,r.peer].includes(identity)); }
  createScreen(identity) {
    const host = this.agents.get(identity);
    if (!host) throw error('Connect to the workspace first');
    if ([...this.rooms.values()].some(r => r.kind === 'screen' && r.owner === identity)) throw error('Stop the existing screen share first');
    const token = randomBytes(32).toString('base64url');
    const room = { id: randomUUID(), kind: 'screen', owner: identity, host, guest: null,
      tokenHash: digest(token), state: 'waiting', expires: this.now()+30*60*1000 };
    this.rooms.set(room.id,room); this.tokens.set(room.tokenHash,room.id);
    return { id: room.id, token, expiresAt: room.expires };
  }
  createVoice(owner, peer) {
    if (owner === peer) throw error('Choose another teammate', 400);
    const host = this.agents.get(owner), guest = this.agents.get(peer);
    if (!host || !guest) throw error('Both teammates must have WiT Connect open');
    if (this.busy(owner) || this.busy(peer)) throw error('A teammate is already on an internal call');
    const room = { id: randomUUID(), kind: 'voice', owner, peer, host, guest,
      state: 'ringing', expires: this.now()+30000 };
    this.rooms.set(room.id,room);
    this.send(host,{ type: 'outgoing', roomId: room.id });
    this.send(guest,{ type: 'incoming', roomId: room.id, from: owner });
    return { id: room.id, expiresAt: room.expires };
  }
  joinGuest(ws, token, name) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw error('This screen-sharing link is unavailable',404);
    const room = this.rooms.get(this.tokens.get(digest(token)));
    if (!room || room.expires <= this.now() || room.state !== 'waiting' || room.guest || ws.roomId)
      throw error('This screen-sharing link is unavailable',404);
    ws.roomId = room.id; room.guest = ws;
    this.send(ws,{ type: 'waiting', roomId: room.id });
    this.send(room.host,{ type: 'viewer_waiting', roomId: room.id,
      name: typeof name === 'string' ? name.trim().slice(0,60) || 'Visitor' : 'Visitor' });
  }
  handle(ws, message) {
    const r = this.rooms.get(message.roomId);
    if (!r || r.expires <= this.now() || (ws !== r.host && ws !== r.guest)) throw error('Session unavailable',404);
    const host = ws === r.host, other = host ? r.guest : r.host;
    if (message.type === 'end') {
      if (r.kind === 'screen' && !host && r.state === 'waiting') {
        r.guest = null; ws.roomId = null; this.send(r.host,{ type: 'viewer_left', roomId:r.id });
        return;
      }
      this.end(r.id,'ended'); return;
    }
    if (message.type === 'decline_viewer' && r.kind === 'screen' && host && r.state === 'waiting' && r.guest) {
      this.send(r.guest,{ type: 'ended', roomId:r.id, reason:'declined' });
      r.guest.roomId = null; r.guest.close(1000,'Declined'); r.guest=null;
      this.send(r.host,{ type:'viewer_left', roomId:r.id }); return;
    }
    if (message.type === 'accept') {
      if ((r.kind === 'screen' && (!host || r.state !== 'waiting' || !r.guest)) ||
          (r.kind === 'voice' && (host || r.state !== 'ringing'))) throw error('Cannot accept this session');
      r.state='active';
      if (r.kind === 'voice') r.expires=this.now()+60*60*1000;
      if (r.tokenHash) this.tokens.delete(r.tokenHash); // one admitted viewer, single use
      this.send(r.guest,{ type:'ready', roomId:r.id, kind:r.kind, offerer:false, rtc:rtcConfiguration() });
      this.send(r.host,{ type:'ready', roomId:r.id, kind:r.kind, offerer:true, rtc:rtcConfiguration() }); return;
    }
    if (message.type !== 'signal' || r.state !== 'active') throw error('Session has not been accepted');
    const s = message.signal;
    if (!s || typeof s !== 'object') throw error('Invalid signal',400);
    if (s.description) {
      if (s.description.type !== (host ? 'offer' : 'answer') || typeof s.description.sdp !== 'string' || s.description.sdp.length > 60000)
        throw error('Invalid session description',400);
      this.send(other,{ type:'signal', roomId:r.id, signal:{ description:{ type:s.description.type, sdp:s.description.sdp } } });
    } else if (s.candidate && typeof s.candidate.candidate === 'string' && s.candidate.candidate.length <= 4096) {
      this.send(other,{ type:'signal', roomId:r.id, signal:{ candidate:s.candidate } });
    } else throw error('Invalid ICE candidate',400);
  }
  end(id, reason) {
    const r=this.rooms.get(id); if (!r) return;
    this.rooms.delete(id); if (r.tokenHash) this.tokens.delete(r.tokenHash);
    for (const ws of [r.host,r.guest]) this.send(ws,{ type:'ended', roomId:id, reason });
    if (r.kind === 'screen' && r.guest) { r.guest.roomId=null; r.guest.close(1000,'Sharing ended'); }
    this.onEnd(r);
  }
  disconnect(ws) {
    if (ws.identity && this.agents.get(ws.identity) === ws) this.agents.delete(ws.identity);
    for (const r of [...this.rooms.values()]) {
      if (ws === r.host || (ws === r.guest && r.state !== 'waiting')) this.end(r.id,'disconnected');
      else if (ws === r.guest) { r.guest=null; this.send(r.host,{type:'viewer_left',roomId:r.id}); }
    }
  }
  sweep() { for (const r of [...this.rooms.values()]) if (r.expires <= this.now()) this.end(r.id,'expired'); }
}
export const collaborationHub = new CollaborationHub();

export function attachCollaborationWss(server, hub=collaborationHub) {
  const wss = new WebSocketServer({ noServer:true, maxPayload:70000, perMessageDeflate:false });
  server.on('upgrade',(req,socket,head) => {
    const path=new URL(req.url,'http://localhost').pathname;
    if (!['/ws/collaboration','/ws/share'].includes(path)) return;
    const origins=new Set([config.publicBaseUrl,...config.allowedOrigins].filter(Boolean));
    const agent=path === '/ws/collaboration' ? authenticateUpgrade(req) : null;
    if (!config.collaboration.enabled || !origins.has(req.headers.origin) || wss.clients.size >= 200 ||
      (path === '/ws/collaboration' && (!agent || agent.role === 'viewer'))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req,socket,head,ws => { ws.authRequest=agent ? req : null; ws.isAlive=true;
      if (agent) hub.connect(ws,agent.identity);
      const joinTimer=setTimeout(() => { if (!agent && !ws.roomId) ws.close(1008,'Join timeout'); },10000); joinTimer.unref();
      let bucket=Date.now(), count=0;
      ws.on('message',raw => {
        if (Date.now()-bucket>1000) { bucket=Date.now(); count=0; }
        if (++count>80) return ws.close(1008,'Too many messages');
        if (ws.authRequest) {
          const current=authenticateUpgrade(req);
          if (current?.identity !== ws.identity || current.role === 'viewer') return ws.close(1008,'Session expired');
        }
        try {
          const message=JSON.parse(raw);
          if (message.type === 'join' && !agent) hub.joinGuest(ws,message.token,message.name);
          else hub.handle(ws,message);
        } catch (e) { hub.send(ws,{type:'error',message:e.status ? e.message : 'Invalid message'}); }
      });
      ws.on('pong',() => { ws.isAlive=true; });
      ws.on('error',() => hub.disconnect(ws));
      ws.on('close',() => { clearTimeout(joinTimer); hub.disconnect(ws); });
    });
  });
  const timer=setInterval(() => {
    hub.sweep();
    for (const ws of wss.clients) {
      const agent=ws.authRequest ? authenticateUpgrade(ws.authRequest) : null;
      if (ws.authRequest && (agent?.identity !== ws.identity || agent.role === 'viewer')) { ws.close(1008,'Session expired'); continue; }
      if (!ws.isAlive) ws.terminate(); else { ws.isAlive=false; ws.ping(); }
    }
  },15000); timer.unref();
  return { close() { clearInterval(timer); for (const r of [...hub.rooms.values()]) hub.end(r.id,'server_shutdown'); for (const ws of wss.clients) ws.close(1001,'Server shutdown'); wss.close(); } };
}
