import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CollaborationHub, rtcConfiguration } from '../src/realtime/collaboration.js';
import { config } from '../src/config.js';
const ws = () => ({ readyState:1, bufferedAmount:0, messages:[], send(s) { this.messages.push(JSON.parse(s)); }, close() { this.readyState=3; } });
function room() { const hub=new CollaborationHub(), alice=ws(), bob=ws(); hub.connect(alice,'alice'); hub.connect(bob,'bob'); return {hub,alice,bob}; }
test('screen share requires host approval, rejects outsiders and consumes its secret on admission', () => {
  const {hub,alice,bob}=room(), guest=ws(), other=ws(); const link=hub.createScreen('alice');
  assert.ok(!JSON.stringify([...hub.rooms.values()]).includes(link.token));
  hub.joinGuest(guest,link.token,'Customer');
  assert.throws(() => hub.joinGuest(other,link.token,'Intruder'), /unavailable/);
  assert.throws(() => hub.handle(guest,{type:'signal',roomId:link.id,signal:{description:{type:'offer',sdp:'x'}}}), /accepted/);
  assert.throws(() => hub.handle(bob,{type:'accept',roomId:link.id}), /unavailable/);
  assert.throws(() => hub.handle(guest,{type:'accept',roomId:link.id}), /Cannot accept/);
  hub.handle(alice,{type:'accept',roomId:link.id});
  assert.equal(hub.tokens.size,0);
  hub.handle(alice,{type:'signal',roomId:link.id,signal:{description:{type:'offer',sdp:'example'}}});
  assert.equal(guest.messages.at(-1).signal.description.sdp,'example');
  assert.throws(() => hub.handle(guest,{type:'signal',roomId:link.id,signal:{description:{type:'offer',sdp:'x'}}}), /Invalid/);
  hub.end(link.id,'ended'); assert.equal(hub.rooms.size,0); assert.equal(guest.readyState,3);
  assert.throws(() => hub.joinGuest(other,link.token,'Intruder'), /unavailable/);
});
test('decline and pending viewer departure preserve host share; host disconnect invalidates link', () => {
  const {hub,alice}=room(), guest=ws(), next=ws(); const link=hub.createScreen('alice');
  hub.joinGuest(guest,link.token,'One'); hub.handle(alice,{type:'decline_viewer',roomId:link.id});
  hub.joinGuest(next,link.token,'Two'); hub.disconnect(next); assert.equal(hub.rooms.get(link.id).guest,null);
  hub.disconnect(alice); assert.equal(hub.tokens.size,0); assert.equal(hub.rooms.size,0);
});
test('internal calls reserve both users, accept only from callee and release on expiry', () => {
  let now=0; const hub=new CollaborationHub({now:()=>now}), a=ws(), b=ws(), c=ws();
  hub.connect(a,'alice');hub.connect(b,'bob');hub.connect(c,'cara');
  const call=hub.createVoice('alice','bob'); assert.equal(hub.busy('alice'),true); assert.equal(hub.busy('bob'),true);
  assert.throws(() => hub.createVoice('cara','bob'), /already/);
  assert.throws(() => hub.handle(a,{type:'accept',roomId:call.id}), /Cannot accept/);
  assert.throws(() => hub.handle(c,{type:'end',roomId:call.id}), /unavailable/);
  now=30001; hub.sweep(); assert.equal(hub.busy('bob'),false);
  const next=hub.createVoice('alice','bob'); hub.handle(b,{type:'accept',roomId:next.id});
  now+=3600001; hub.sweep(); assert.equal(hub.rooms.size,0);
});
test('share links expire and moving workspace to another tab ends all previous sessions', () => {
  let now=0;const hub=new CollaborationHub({now:()=>now}), a=ws();hub.connect(a,'alice'); const link=hub.createScreen('alice');
  now=1800001; assert.throws(()=>hub.joinGuest(ws(),link.token,'Late'), /unavailable/);hub.sweep();assert.equal(hub.tokens.size,0);
  hub.createScreen('alice');hub.connect(ws(),'alice');assert.equal(hub.rooms.size,0);assert.equal(a.readyState,3);
});
test('TURN credentials are temporary HMAC credentials and never disclose the shared secret', () => {
  const before={...config.collaboration};
  try { Object.assign(config.collaboration,{stunUrls:['stun:relay.test:3478'],turnUrls:['turn:relay.test:3478'],turnSecret:'test-only-secret',relayOnly:true});
    const result=rtcConfiguration(1000000), server=result.iceServers[1];
    assert.match(server.username,/^4900:/); assert.equal(server.credential,createHmac('sha1','test-only-secret').update(server.username).digest('base64'));
    assert.equal(result.iceTransportPolicy,'relay'); assert.ok(!JSON.stringify(result).includes('test-only-secret'));
  } finally { Object.assign(config.collaboration,before); }
});
