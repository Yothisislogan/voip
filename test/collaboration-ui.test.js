import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
async function page(t,name){
  const dom=new JSDOM(await readFile(new URL(`../public/${name}.html`,import.meta.url),'utf8'),{url:`https://phone.test/${name}.html#${'x'.repeat(43)}`,runScripts:'outside-only'});
  t.after(()=>{w.WitFeatures?.close();dom.window.close();});const w=dom.window,sockets=[],errors=[];
  w.addEventListener('error',e=>errors.push(e.message));
  w.WebSocket=class{constructor(){this.readyState=1;this.sent=[];sockets.push(this);}send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;}};
  const rtc=[];w.WitRTC=class{constructor(args){this.args=args;rtc.push(this);}receive(){}close(){this.closed=true;}};
  let stopped=0,screenRequests=0,audioRequests=0;
  const track={enabled:true,readyState:'live',stop(){stopped++;},addEventListener(){}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[track]};
  Object.defineProperty(w.navigator,'mediaDevices',{value:{getDisplayMedia:async options=>{assert.equal(options.audio,false);screenRequests++;return stream;},getUserMedia:async()=>{audioRequests++;return stream;}}});
  const $=id=>w.document.getElementById(id);
  return {w,$,sockets,rtc,errors,stream,get stopped(){return stopped;},get screenRequests(){return screenRequests;},get audioRequests(){return audioRequests;}};
}
async function phone(t){
  const ui=await page(t,'phone'),{w}=ui,calls=[],busy=[];let fail=false;
  const api=async(path,body)=>{
    calls.push({path,body});
    if(path==='/api/office/team')return{teammates:[{identity:'bob',name:'Bob',online:true}],relayConfigured:true};
    if(path.endsWith('/read'))return{};
    if(path.startsWith('/api/office/messages/')){if(body){if(fail)throw new Error('network lost');return{message:{id:'1'}};}return{messages:[]};}
    if(path==='/api/office/screen')return{id:'screen-1',url:`https://phone.test/share.html#${'t'.repeat(43)}`,expiresAt:Date.now()+1800000};
    if(path==='/api/office/call'){ui.sockets[0].onmessage({data:JSON.stringify({type:'outgoing',roomId:'voice-1'})});return{id:'voice-1'};}
    return{};
  };
  w.eval(await readFile(new URL('../public/phone-features.js',import.meta.url),'utf8'));
  await w.WitFeatures.init({me:{identity:'alice',role:'agent',collaborationEnabled:true,experienceEnabled:true},api,post:api,toast(){},isPhoneBusy:()=>false,setInternalBusy:value=>busy.push(value)});
  ui.sockets[0].onopen();await settle();
  return {...ui,calls,busy,metrics:ui,fail:value=>{fail=value;},message:m=>ui.sockets[0].onmessage({data:JSON.stringify(m)})};
}
test('screen sharing captures only on click, waits for approval and stops capture when ended',async t=>{
  const {w,$,sockets,rtc,message,metrics}=await phone(t);assert.equal(metrics.screenRequests,0);
  $('startShare').click();await settle();assert.equal(metrics.screenRequests,1);assert.match($('shareLink').value,/#t/);
  message({type:'viewer_waiting',roomId:'screen-1',name:'<script>visitor</script>'});assert.equal($('viewerApproval').hidden,false);assert.equal($('viewerName').querySelector('script'),null);assert.equal(rtc.length,0);
  $('approveViewer').click();assert.equal(sockets[0].sent.at(-1).type,'accept');
  message({type:'ready',roomId:'screen-1',kind:'screen',offerer:true,rtc:{}});assert.equal(rtc.length,1);
  $('stopShare').click();assert.equal(rtc[0].closed,true);assert.equal(metrics.stopped,1);assert.equal($('shareLink').value,'');assert.equal(w.WitFeatures.busy(),false);
});
test('internal call answer asks for microphone and releases phone busy state on hangup',async t=>{
  const {$,message,metrics,busy,sockets}=await phone(t);
  message({type:'incoming',roomId:'voice-1',from:'bob'});assert.equal(metrics.audioRequests,0);assert.equal(busy.at(-1),true);assert.equal($('officeIncoming').hidden,false);
  $('officeAnswer').click();await settle();assert.equal(metrics.audioRequests,1);assert.equal(sockets[0].sent.at(-1).type,'accept');
  message({type:'ready',roomId:'voice-1',kind:'voice',offerer:false,rtc:{}});$('officeMute').click();assert.equal(metrics.stream.getAudioTracks()[0].enabled,false);
  $('officeEnd').click();assert.equal(busy.at(-1),false);assert.equal(metrics.stopped,1);
});
test('private message retries keep a stable client ID and render an AI estimate as text',async t=>{
  const {w,$,calls,fail}=await phone(t);$('officePeer').value='bob';$('officePeer').dispatchEvent(new w.Event('change'));await settle();
  $('officeText').value='Hello teammate';fail(true);$('officeMessageForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
  fail(false);$('officeMessageForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
  const posts=calls.filter(x=>x.path.endsWith('/bob')&&x.body);assert.equal(posts.length,2);assert.equal(posts[0].body.clientId,posts[1].body.clientId);assert.equal($('officeText').value,'');
  w.WitFeatures.render({call:{twilio_call_sid:'call',ended_at:'now'},experience:{state:'ready',csat:4,recommendation:null,confidence:'low',reason:'<img src=x onerror=alert(1)>',evidence:['Customer evidence'],backend:'ollama',rubric_version:'v1'}});
  assert.match($('experienceResult').textContent,/4 \/ 5/);assert.match($('experienceResult').textContent,/Not enough evidence/);assert.equal($('experienceResult').querySelector('img'),null);
});
test('anonymous viewer clears secret from URL and never requests screen, camera or microphone',async t=>{
  const ui=await page(t,'share'),{w,$,sockets,rtc}=ui;
  w.eval(await readFile(new URL('../public/share.js',import.meta.url),'utf8'));assert.equal(w.location.hash,'');assert.equal(sockets.length,0);
  $('visitorName').value='Customer';$('joinForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
  // The supported-browser check precedes opening the socket.
  assert.equal(sockets.length,0);w.RTCPeerConnection=class{};
  $('joinForm').dispatchEvent(new w.Event('submit',{cancelable:true}));sockets[0].onopen();assert.equal(sockets[0].sent[0].token,'x'.repeat(43));
  sockets[0].onmessage({data:JSON.stringify({type:'waiting',roomId:'screen-1'})});assert.equal(rtc.length,0);
  sockets[0].onmessage({data:JSON.stringify({type:'ready',roomId:'screen-1',rtc:{}})});assert.equal(rtc.length,1);assert.equal(rtc[0].args.offerer,false);assert.equal(rtc[0].args.stream,undefined);
  assert.equal(ui.screenRequests,0);assert.equal(ui.audioRequests,0);$('leave').click();assert.equal(rtc[0].closed,true);
});
test('WebRTC queues early candidates until remote SDP and produces the answer in order',async t=>{
  const {w}=await page(t,'share'),events=[],sent=[];
  w.RTCPeerConnection=class{constructor(){this.connectionState='new';}async addIceCandidate(){events.push('candidate');}async setRemoteDescription(d){this.remoteDescription=d;events.push('remote');}async createAnswer(){return{type:'answer',sdp:'answer'};}async setLocalDescription(d){this.localDescription=d;events.push('local');}close(){events.push('closed');}};
  w.eval(await readFile(new URL('../public/rtc-session.js',import.meta.url),'utf8'));
  const rtc=new w.WitRTC({rtc:{},offerer:false,send:m=>sent.push(m),onTrack(){},onState(){},onError:e=>{throw e;}});t.after(()=>rtc.close());
  await rtc.receive({candidate:{candidate:'test'}});assert.deepEqual(events,[]);
  await rtc.receive({description:{type:'offer',sdp:'offer'}});assert.deepEqual(events,['remote','candidate','local']);assert.equal(sent[0].description.type,'answer');
});
