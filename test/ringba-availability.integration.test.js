import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import WebSocket from 'ws';
const enabled=!!process.env.VOIP_TEST_DATABASE_URL;
if(enabled)process.env.DATABASE_URL=process.env.VOIP_TEST_DATABASE_URL;
process.env.SESSION_SECRET='ringba-integration-test-secret';process.env.AUTH_REQUIRED='true';
const prefix=randomUUID(),id=name=>`${name}-${prefix}`;
process.env.AGENT_DIRECTORY=JSON.stringify(['alice','bob','viewer'].map(name=>({identity:id(name),email:`${name}@ringba.test`,name,role:name==='viewer'?'viewer':'agent',telnyxCredentialId:name,telnyxSipUsername:`sip-${name}`})));
const {config}=await import('../src/config.js');
const {db}=await import('../src/db.js');
const {phoneRouter}=await import('../src/routes/phone.js');
const {ringbaRouter}=await import('../src/routes/ringba.js');
const {attachAgentWss}=await import('../src/realtime/ws.js');
const {issueSession,cookieName,verifyToken}=await import('../src/auth/session.js');
const {revokeJti}=await import('../src/auth/revocation.js');
const {getAgentAvailability}=await import('../src/services/agent-availability.js');
const {selectTargets}=await import('../src/services/routing.js');
const {collaborationHub}=await import('../src/realtime/collaboration.js');
const integration=(name,fn)=>test(name,{skip:!enabled},fn);
const sessions={},sockets=[];let server,base,wss;
before(async()=>{
  if(!enabled)return;
  config.publicBaseUrl='https://phone.test';config.voiceProvider='telnyx';config.defaultAgentIdentity=id('alice');
  Object.assign(config.telnyx,{apiKey:'synthetic',connectionId:'synthetic',callerId:'+12025550100'});
  config.voice.routing={agents:[id('alice'),id('bob')],strategy:'simultaneous'};
  Object.assign(config.ringba,{enabled:true,token:'ringba-test-only-token-'.repeat(2),campaigns:[{id:'auto',enabled:true,agents:[id('alice'),id('bob')]}]});
  for(const name of ['alice','bob','viewer'])sessions[name]=issueSession({...config.auth.agents.find(a=>a.identity===id(name)),level:'full'}).token;
  const app=express();app.use(express.json());app.use(phoneRouter,ringbaRouter);app.use((err,_q,res,_n)=>res.status(err.status||500).json({error:err.message}));
  server=app.listen(0,'127.0.0.1');wss=attachAgentWss(server);await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  for(const name of ['alice','bob']){const ws=new WebSocket(base.replace('http:','ws:')+'/ws/agent',{headers:{Origin:config.publicBaseUrl,Cookie:`${cookieName}=${sessions[name]}`}});sockets.push(ws);await once(ws,'open');}
});
after(async()=>{if(!enabled)return;for(const ws of sockets)ws.terminate();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(r=>server.close(r));await db.close();});
async function phone(user,path,body){const res=await fetch(base+path,{method:body?'POST':'GET',headers:{Cookie:`${cookieName}=${sessions[user]}; wit_csrf=test`,'X-CSRF-Token':'test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};}
async function ping(){const res=await fetch(base+'/integrations/ringba/availability?campaign=auto',{headers:{Authorization:`Bearer ${config.ringba.token}`}});return{status:res.status,body:await res.json()};}
async function ready(){
  await db.query("UPDATE calls SET ended_at=now(),status='completed' WHERE twilio_call_sid LIKE $1",[`%${prefix}%`]);
  for(const name of ['alice','bob']){
    await phone(name,'/api/phone/presence',{status:'available',registered:true});
    await db.query('UPDATE agent_presence SET reserved_until=NULL,reserved_call_sid=NULL WHERE identity=$1',[id(name)]);
  }
}
integration('status board and Ringba ping count the same registered, reachable green agents',async()=>{
  await ready();const board=await phone('alice','/api/phone/presence/team');assert.equal(board.status,200);assert.equal(board.body.agents.length,2);assert.equal(board.body.agents.filter(a=>a.available).length,2);
  const result=await ping();assert.equal(result.status,200);assert.equal(result.body.response.available,2);assert.equal(result.body.response.accept,true);assert.ok(!JSON.stringify(result.body).includes(id('alice')));
  config.auth.agents.push({...config.auth.agents[0],email:'alias@ringba.test'});
  try { assert.equal((await ping()).body.response.available,2);assert.equal((await phone('alice','/api/phone/presence/team')).body.agents.length,2); }
  finally { config.auth.agents.pop(); }
  await phone('alice','/api/phone/presence',{status:'wrapup',registered:true});assert.equal((await ping()).body.response.available,1);
  await phone('bob','/api/phone/presence',{status:'dnd',registered:true});const none=(await ping()).body.response;assert.equal(none.available,0);assert.equal(none.accept,false);assert.equal(none.status,'yellow');
});
integration('old clients, stale heartbeats and viewer roles cannot advertise green',async()=>{
  await ready();await phone('alice','/api/phone/presence',{status:'available'});assert.equal((await ping()).body.response.available,1);
  await db.query("UPDATE agent_presence SET heartbeat_at=now()-interval '46 seconds' WHERE identity=$1",[id('bob')]);assert.equal((await ping()).body.response.available,0);
  assert.equal((await phone('viewer','/api/phone/presence',{status:'available',registered:true})).status,403);
  assert.equal((await phone('alice','/api/phone/presence',{status:'available',registered:'yes'})).status,400);
});
integration('queued calls, ring offers and internal calls remove capacity before provider answer',async()=>{
  await ready();const root=`test-${prefix}`;
  await db.query("INSERT INTO calls(twilio_call_sid,status,agent_identity) VALUES($1,'queued',$2)",[root,id('alice')]);
  await db.query("UPDATE agent_presence SET reserved_until=now()+interval '30 seconds' WHERE identity=$1",[id('bob')]);
  let statuses=await getAgentAvailability();assert.equal(statuses.find(a=>a.identity===id('alice')).color,'red');assert.equal(statuses.find(a=>a.identity===id('bob')).color,'yellow');assert.equal((await ping()).body.response.available,0);
  await db.query("UPDATE calls SET agent_identity=NULL,route_targets=$2 WHERE twilio_call_sid=$1",[root,JSON.stringify([id('bob')])]);
  statuses=await getAgentAvailability();assert.equal(statuses.find(a=>a.identity===id('bob')).color,'red');
  await ready();const socket=()=>({readyState:1,bufferedAmount:0,send(){},close(){}});collaborationHub.connect(socket(),id('alice'));collaborationHub.connect(socket(),id('bob'));
  const call=collaborationHub.createVoice(id('alice'),id('bob'));assert.equal((await ping()).body.response.available,0);collaborationHub.end(call.id,'test');collaborationHub.agents.clear();
});
integration('inbound routing respects the same readiness rules while Ringba buying availability is enabled',async()=>{
  await ready();await phone('alice','/api/phone/presence',{status:'available',registered:false});
  const route=await selectTargets(`route-${prefix}`,new Date(),{from:'+12025550111'});assert.deepEqual(route.targets,[id('bob')]);
  assert.equal((await ping()).body.response.available,0);
});
integration('revoked sessions stop contributing capacity without waiting for the next browser heartbeat',async()=>{
  await ready();const token=verifyToken(sessions.alice);await revokeJti(token.jti,token.exp);
  assert.equal((await ping()).body.response.available,1);
  const token2=verifyToken(sessions.bob);await revokeJti(token2.jti,token2.exp);assert.equal((await ping()).body.response.available,0);
});
