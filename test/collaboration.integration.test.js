import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
const enabled=!!process.env.VOIP_TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL=process.env.VOIP_TEST_DATABASE_URL;
process.env.SESSION_SECRET='feature-integration-test-only';
const prefix=randomUUID(), id=name=>`${name}-${prefix}`, phone='+12025550333';
process.env.AGENT_DIRECTORY=JSON.stringify(['alice','bob','cara','admin','viewer'].map(name=>({identity:id(name),email:`${name}@feature.test`,name,role:['admin','viewer'].includes(name)?name:'agent',telnyxSipUsername:`sip${name}`,telnyxCredentialId:name})));
const {db}=await import('../src/db.js');
const {config}=await import('../src/config.js');
const {selectTargets,fallbackTargets}=await import('../src/services/routing.js');
const {collaborationHub:hub}=await import('../src/realtime/collaboration.js');
const {collaborationRouter}=await import('../src/routes/collaboration.js');
const {tagRoutingRouter}=await import('../src/routes/tag-routing.js');
const {phoneRouter}=await import('../src/routes/phone.js');
const {voiceRouter}=await import('../src/routes/voice.js');
const {gradeCallExperience}=await import('../src/services/call-experience.js');
const {issueSession,cookieName}=await import('../src/auth/session.js');
const {handleTelnyxEvent,startTelnyxOutbound}=await import('../src/services/telnyx-voice.js');
const {createCall,loadCall}=await import('../src/services/call-state.js');
const integration=(name,fn)=>test(name,{skip:!enabled},fn);
let server,base; const tokens={};
const socket=()=>({readyState:1,bufferedAmount:0,send(){},close(){this.readyState=3;}});
before(async()=>{
  if (!enabled) return;
  config.auth.required=true;config.experience.enabled=true;config.collaboration.enabled=true;config.voice.tagRoutingEnabled=true;
  config.publicBaseUrl='https://phone.test';config.witnext.url='';config.voiceProvider='telnyx';
  config.auth.agents=['alice','bob','cara','admin','viewer'].map(name=>({identity:id(name),email:`${name}@feature.test`,name,role:['admin','viewer'].includes(name)?name:'agent',telnyxSipUsername:`sip${name}`,telnyxCredentialId:name}));
  config.voice.routing={agents:[id('alice'),id('bob'),id('cara')],strategy:'simultaneous'};
  config.defaultAgentIdentity=id('alice');Object.assign(config.telnyx,{apiKey:'test-only',mediaSecret:'x'.repeat(40),connectionId:'test-app',callerId:'+12025550100'});
  for (const a of config.auth.agents) tokens[a.name]=issueSession({...a,level:'full'}).token;
  const app=express();app.use(express.json());app.use(collaborationRouter,tagRoutingRouter,phoneRouter,voiceRouter);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(!enabled)return;for(const r of [...hub.rooms.values()])hub.end(r.id,'test');if(server)await new Promise(r=>server.close(r));await db.close();});
async function request(user,path,method='GET',body,csrf=true){
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:`${cookieName}=${tokens[user]}; wit_csrf=testcsrf`,...(csrf?{'X-CSRF-Token':'testcsrf'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:res.status,data};
}
async function reset(){
  for(const r of [...hub.rooms.values()])hub.end(r.id,'test');hub.agents.clear();
  await db.query("UPDATE calls SET ended_at=now(),status='completed' WHERE twilio_call_sid LIKE $1",[`%${prefix}%`]);
  await db.query('DELETE FROM caller_routing_tags WHERE phone=$1',[phone]);
  await db.query('DELETE FROM tag_routing_rules WHERE updated_by=$1',[prefix]);
  for(const name of ['alice','bob','cara'])await db.query(`INSERT INTO agent_presence(identity,status) VALUES($1,'available') ON CONFLICT(identity) DO UPDATE SET status='available',heartbeat_at=now(),reserved_until=NULL,reserved_call_sid=NULL`,[id(name)]);
}
async function rules(){
  await db.query('INSERT INTO caller_routing_tags(phone,tags,updated_by) VALUES($1,$2,$3)',[phone,['Auto','VIP'],prefix]);
  for(const [tag,agent,priority] of [['auto','alice',10],['vip','bob',1]])await db.query('INSERT INTO tag_routing_rules(tag,label,preferred_agent,priority,ring_seconds,updated_by) VALUES($1,$1,$2,$3,12,$4)',[`${tag}-${prefix}`,id(agent),priority,prefix]);
  await db.query('UPDATE caller_routing_tags SET tags=$2 WHERE phone=$1',[phone,[`auto-${prefix}`,`vip-${prefix}`]]);
}
integration('tag preference, busy-user skip, fallback reservations and duplicate handling persist',async()=>{
  await reset();await rules();const root=id('route');
  const first=await selectTargets(root,new Date(),{from:phone});assert.deepEqual(first.targets,[id('bob')]);assert.equal(first.timeout,12);
  assert.deepEqual((await selectTargets(root,new Date(),{from:phone})).targets,first.targets);
  const fallback=await db.transaction(tx=>fallbackTargets(root,tx));assert.deepEqual(fallback.targets,[id('alice'),id('cara')]);
  assert.equal(await db.transaction(tx=>fallbackTargets(root,tx)),null);
  assert.equal((await db.query('SELECT reserved_call_sid FROM agent_presence WHERE identity=$1',[id('bob')])).rows[0].reserved_call_sid,null);
  await reset();await rules();await db.query("UPDATE agent_presence SET status='busy' WHERE identity=$1",[id('bob')]);
  assert.deepEqual((await selectTargets(id('busy'),new Date(),{from:phone})).targets,[id('alice')]);
});
integration('concurrent tagged calls cannot reserve the same preferred user',async()=>{
  await reset();await rules();config.voice.routing.agents=[id('bob')];
  await db.query("UPDATE agent_presence SET status='away' WHERE identity<>$1 AND identity=ANY($2::text[])",[id('bob'),[id('alice'),id('cara')]]);
  const routes=await Promise.all([1,2].map(n=>selectTargets(id(`concurrent${n}`),new Date(),{from:phone})));
  assert.equal(routes.filter(r=>r.targets.includes(id('bob'))).length,1);
  config.voice.routing.agents=[id('alice'),id('bob'),id('cara')];
});
integration('routing admin API supports multiple caller tags, optimistic edits and role/CSRF gates',async()=>{
  await reset();const path='/api/tag-routing/rule',body={tag:`API ${prefix.slice(0,8)}`,preferredAgent:id('alice'),priority:5,ringSeconds:15,enabled:true,version:0};
  assert.equal((await request('alice',path,'PUT',body)).status,403);assert.equal((await request('admin',path,'PUT',body,false)).status,403);
  const created=await request('admin',path,'PUT',body);assert.equal(created.status,200);
  assert.equal((await request('admin',path,'PUT',body)).status,409);
  assert.equal((await request('admin',path,'PUT',{...body,version:created.data.rule.version,preferredAgent:id('bob')})).status,200);
  const tags=await request('admin','/api/tag-routing/caller','PUT',{phone,tags:['Auto','VIP','auto'],version:0});assert.equal(tags.status,200);assert.deepEqual(tags.data.caller.tags,['Auto','VIP']);
  assert.equal((await request('admin','/api/tag-routing/caller','PUT',{phone,tags:[],version:0})).status,409);
  const cleared=await request('admin','/api/tag-routing/caller','PUT',{phone,tags:[],version:tags.data.caller.version});assert.deepEqual(cleared.data.caller.tags,[]);
});
integration('private messages enforce pair access, idempotency, CSRF and read receipts',async()=>{
  await reset();const path=`/api/office/messages/${id('bob')}`,body={body:'Private test message',clientId:randomUUID()};
  assert.equal((await request('viewer',path,'POST',body)).status,403);assert.equal((await request('alice',path,'POST',body,false)).status,403);
  const first=await request('alice',path,'POST',body),retry=await request('alice',path,'POST',body);assert.equal(first.status,201);assert.equal(retry.data.message.id,first.data.message.id);
  assert.equal((await request('alice',path,'POST',{...body,body:'Changed message'})).status,409);
  assert.equal((await request('cara',path)).data.messages.length,0);assert.equal((await request('admin',path)).data.messages.length,0);
  const inbox=await request('bob',`/api/office/messages/${id('alice')}`);assert.equal(inbox.data.messages.length,1);
  await request('bob',`/api/office/messages/${id('alice')}/read`,'POST',{throughId:first.data.message.id});
  assert.ok((await request('alice',path)).data.messages[0].read_at);
});
integration('internal calls reject busy recipients, reserve both users against PSTN and release on end',async()=>{
  await reset();for(const name of ['alice','bob','cara'])hub.connect(socket(),id(name));
  await db.query("UPDATE agent_presence SET status='dnd' WHERE identity=$1",[id('bob')]);
  assert.equal((await request('alice','/api/office/call','POST',{peer:id('bob')})).status,409);
  // The initiating browser marks itself busy while requesting its microphone.
  await db.query("UPDATE agent_presence SET status=CASE WHEN identity=$1 THEN 'busy' ELSE 'available' END WHERE identity=ANY($2::text[])",[id('alice'),[id('alice'),id('bob')]]);
  const started=await request('alice','/api/office/call','POST',{peer:id('bob')});assert.equal(started.status,201);
  assert.deepEqual((await selectTargets(id('during-office'),new Date(),{from:phone})).targets,[id('cara')]);
  await assert.rejects(startTelnyxOutbound(id('bob'),phone,randomUUID()),/internal call/);
  hub.handle(hub.agents.get(id('bob')),{type:'end',roomId:started.data.id});assert.equal(hub.busy(id('alice')),false);
});
integration('Twilio preferred fallback is replayable and a second failed stage reaches voicemail',async()=>{
  await reset();await rules();const root=id('twilio');await selectTargets(root,new Date(),{from:phone});
  await createCall({callSid:root,direction:'inbound',from:phone,to:'+12025550100'});
  const body={CallSid:root,DialCallStatus:'no-answer'};
  const first=await request('admin','/voice/dial-status','POST',body),repeat=await request('admin','/voice/dial-status','POST',body);
  assert.equal(first.status,200);assert.match(first.data,/<Dial/);assert.equal(repeat.data,first.data);assert.equal((await loadCall(root)).is_voicemail,false);
  assert.match((await request('admin','/voice/dial-status?stage=fallback','POST',body)).data,/<Record/);
});
integration('Telnyx preferred agent times out, fallback rings once, and late preferred answer cannot win',async()=>{
  await reset();await rules();const original=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{
    if(!String(url).startsWith('https://api.telnyx.com/'))return original(url,options);
    const body=JSON.parse(options.body||'{}'),data=String(url).endsWith('/v2/calls')?{call_control_id:`v3:${randomUUID()}`,call_leg_id:randomUUID()}:{};
    requests.push({url,body,data});return new globalThis.Response(JSON.stringify({data}),{status:200});
  };
  try {
    const session=id('telnyx-session'),customer=`v3:${randomUUID()}`,root=`tn_${session}`;
    const event=async(control,type,extra={})=>{
      const leg=(await db.query('SELECT * FROM call_legs WHERE control_id=$1',[control])).rows[0];
      await handleTelnyxEvent({id:randomUUID(),event_type:type,payload:{call_control_id:control,call_leg_id:leg?.sid,connection_id:'test-app',...extra}});
    };
    await handleTelnyxEvent({id:randomUUID(),event_type:'call.initiated',payload:{call_control_id:customer,call_leg_id:randomUUID(),call_session_id:session,connection_id:'test-app',direction:'incoming',from:phone,to:config.telnyx.callerId}});
    await event(customer,'call.answered');const speak=requests.find(r=>r.url.endsWith('/speak'));await event(customer,'call.speak.ended',{client_state:speak.body.client_state});
    const preferred=(await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent'",[root])).rows[0];assert.equal(preferred.agent_identity,id('bob'));
    await event(preferred.control_id,'call.hangup');const count=requests.filter(r=>r.url.endsWith('/v2/calls')).length;assert.equal(count,3);
    await event(preferred.control_id,'call.hangup');assert.equal(requests.filter(r=>r.url.endsWith('/v2/calls')).length,count);
    await event(preferred.control_id,'call.answered');assert.notEqual((await loadCall(root)).agent_identity,id('bob'));
    const fallback=(await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND generation=1 AND purpose='agent' ORDER BY agent_identity",[root])).rows;
    await event(fallback[0].control_id,'call.answered');await event(customer,'call.bridged');assert.equal((await loadCall(root)).agent_identity,fallback[0].agent_identity);
    await event(customer,'call.hangup');
  } finally {globalThis.fetch=original;}
});
integration('call experience persists, deduplicates unchanged transcripts, recomputes late text and restricts access',async()=>{
  await reset();const root=id('score');await createCall({callSid:root,direction:'inbound',from:phone,to:'+12025550100',identity:id('alice')});
  await db.query("UPDATE calls SET ended_at=now(),status='completed',transcription_state='interrupted' WHERE twilio_call_sid=$1",[root]);
  await db.query("INSERT INTO transcript_segments(call_sid,seq,speaker,text) VALUES($1,1,'agent','I have corrected your policy.'),($1,2,'customer','You solved everything today and I will recommend you to my friends.')",[root]);
  let runs=0;const complete=async()=>{runs++;return{csat:5,recommendation:10,confidence:'high',reason:'Customer endorses the resolution.',evidence:['I will recommend you to my friends']};};
  await gradeCallExperience({callSid:root},{complete});await gradeCallExperience({callSid:root},{complete});assert.equal(runs,1);
  const detail=await request('alice',`/api/phone/calls/${root}`);assert.equal(detail.data.experience.confidence,'low');assert.equal(detail.data.experience.csat,5);
  assert.equal((await request('bob',`/api/phone/calls/${root}`)).status,404);assert.equal((await request('alice','/api/phone/experience-summary')).status,403);
  await db.query("INSERT INTO transcript_segments(call_sid,seq,speaker,text) VALUES($1,3,'customer','I appreciate the help you provided today.')",[root]);
  await gradeCallExperience({callSid:root},{complete});assert.equal(runs,2);
  const summary=await request('admin','/api/phone/experience-summary');assert.equal(summary.status,200);assert.equal(summary.data.projectedNps,100);assert.equal(summary.data.predicted,true);
  assert.equal((await request('bob',`/api/phone/calls/${root}/experience`,'POST',{})).status,404);
  assert.equal((await request('alice',`/api/phone/calls/${root}/experience`,'POST',{})).status,202);
});
