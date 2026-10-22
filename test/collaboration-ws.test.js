import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
process.env.SESSION_SECRET='test-ws-feature-secret';process.env.AUTH_REQUIRED='true';
const {config}=await import('../src/config.js');
const {CollaborationHub,attachCollaborationWss}=await import('../src/realtime/collaboration.js');
const {attachAgentWss}=await import('../src/realtime/ws.js');
const {issueSession,cookieName,verifyToken}=await import('../src/auth/session.js');
const {revokeJti}=await import('../src/auth/revocation.js');
async function setup(t){
  config.collaboration.enabled=true;config.publicBaseUrl='https://phone.test';config.auth.agents=[];
  const server=http.createServer(),hub=new CollaborationHub();attachAgentWss(server);const control=attachCollaborationWss(server,hub);
  server.listen(0,'127.0.0.1');await once(server,'listening');const sockets=[];
  t.after(async()=>{for(const ws of sockets)ws.terminate();control.close();await new Promise(r=>server.close(r));});
  const open=(path,headers)=>{const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`,{headers});sockets.push(ws);return ws;};
  return {hub,open};
}
test('collaboration upgrades require matching origin, agent role and a valid full session',async t=>{
  const {open}=await setup(t);
  const token=role=>issueSession({email:'a@test',identity:'alice',role,level:'full'}).token;
  for(const headers of [{Origin:'https://phone.test'},{Origin:'https://evil.test',Cookie:`${cookieName}=${token('agent')}`},{Origin:'https://phone.test',Cookie:`${cookieName}=${token('viewer')}`}]){
    const ws=open('/ws/collaboration',headers);const [err]=await once(ws,'error');assert.match(err.message,/403/);
  }
  const ws=open('/ws/collaboration',{Origin:'https://phone.test',Cookie:`${cookieName}=${token('agent')}`});await once(ws,'open');assert.equal(ws.readyState,1);
});
test('guest joins through shared HTTP server without login, cannot send media before approval, and revoked host is disconnected',async t=>{
  const {hub,open}=await setup(t),{token}=issueSession({email:'a@test',identity:'alice',role:'agent',level:'full'});
  const host=open('/ws/collaboration',{Origin:'https://phone.test',Cookie:`${cookieName}=${token}`});await once(host,'open');
  const share=hub.createScreen('alice'),guest=open('/ws/share',{Origin:'https://phone.test'});await once(guest,'open');
  let next=once(guest,'message');guest.send(JSON.stringify({type:'join',token:share.token,name:'Visitor'}));assert.equal(JSON.parse((await next)[0]).type,'waiting');
  next=once(guest,'message');guest.send(JSON.stringify({type:'signal',roomId:share.id,signal:{description:{type:'offer',sdp:'no'}}}));assert.match(JSON.parse((await next)[0]).message,/accepted/);
  const payload=verifyToken(token);await revokeJti(payload.jti,payload.exp);
  const closed=once(host,'close');host.send(JSON.stringify({type:'accept',roomId:share.id}));const [code]=await closed;assert.equal(code,1008);
  await new Promise(r=>setTimeout(r,10));assert.equal(hub.rooms.size,0);
});
