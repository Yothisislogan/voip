import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
async function workspace(t){
  const dom=new JSDOM(await readFile(new URL('../public/phone.html',import.meta.url),'utf8'),{url:'https://phone.test/phone.html',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,$=id=>w.document.getElementById(id),sockets=[],requests=[],errors=[];let device,presence={status:'offline',registered:false},fail=false;
  Object.defineProperty(w,'isSecureContext',{value:true});Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),enumerateDevices:async()=>[]}});
  w.WebSocket=class{constructor(){sockets.push(this);}close(){}};
  w.TelnyxPhone=class{constructor(){device=this;this.events={};}on(type,fn){this.events[type]=fn;}async register(){this.events.registered();}destroy(){}};
  w.addEventListener('error',e=>errors.push(e.message));
  w.fetch=async(path,options={})=>{
    requests.push({path,options});let data={};
    if(path==='/api/phone/config')data={identity:'alice',role:'agent',provider:'telnyx',calling:true,agentStatusEnabled:true,dispositions:[],agents:[{identity:'alice',name:'Alice'}]};
    else if(path==='/token')data={token:'synthetic'};
    else if(path==='/api/phone/presence')presence=JSON.parse(options.body);
    else if(path==='/api/phone/presence/team'){
      if(fail)throw new Error('network lost');
      const color=!presence.registered||['offline','dnd','busy'].includes(presence.status)?'red':presence.status==='available'?'green':'yellow';
      data={agents:[{identity:'alice',name:'Alice',color,label:color==='green'?'Ready':presence.status,available:color==='green'}],generatedAt:new Date().toISOString()};
    }else if(path.startsWith('/api/phone/calls?'))data={calls:[]};
    else if(path==='/api/phone/calls/call1')data={call:{twilio_call_sid:'call1',direction:'inbound',status:'in_progress',tags:[]},segments:[],recordings:[]};
    return{ok:true,status:200,json:async()=>data};
  };
  w.eval(await readFile(new URL('../public/phone.js',import.meta.url),'utf8'));await settle();sockets[0].onopen();await settle();
  return{w,$,sockets,requests,errors,get device(){return device;},get presence(){return presence;},fail:value=>{fail=value;}};
}
test('agent UI reports phone registration and displays green, yellow and red with text labels',async t=>{
  const ui=await workspace(t),{$,w}=ui;assert.equal($('agentStatusPanel').hidden,false);assert.match($('ownAvailability').className,/status-red/);
  $('enable').click();await settle();assert.equal(ui.presence.registered,true);assert.match($('ownAvailability').textContent,/Green.*Ready/);
  $('presence').value='away';$('presence').dispatchEvent(new w.Event('change'));await settle();assert.match($('ownAvailability').className,/status-yellow/);assert.equal(ui.presence.status,'away');
  $('presence').value='dnd';$('presence').dispatchEvent(new w.Event('change'));await settle();assert.match($('ownAvailability').className,/status-red/);
  assert.deepEqual(ui.errors,[]);
});
test('a connected customer call automatically moves to yellow wrap-up until the agent chooses Ready',async t=>{
  const ui=await workspace(t),{$,w}=ui;$('enable').click();await settle();
  const events={},call={parameters:{CallSid:'call1',From:'+12025550111'},on:(event,fn)=>{events[event]=fn;},status:()=> 'open',accept:()=>events.accept(),reject(){},disconnect:()=>events.disconnect()};
  await ui.device.events.incoming(call);await settle();assert.equal(ui.presence.status,'busy');
  $('accept').click();ui.sockets[0].onmessage({data:JSON.stringify({type:'call_status',callSid:'call1',status:'in_progress'})});await settle();
  $('end').click();await settle();assert.equal($('presence').value,'wrapup');assert.equal(ui.presence.status,'wrapup');assert.match($('ownAvailability').className,/status-yellow/);
  $('presence').value='available';$('presence').dispatchEvent(new w.Event('change'));await settle();assert.match($('ownAvailability').className,/status-green/);assert.deepEqual(ui.errors,[]);
});
test('failed status reads clear old green indicators and phone errors report unregistered',async t=>{
  const ui=await workspace(t),{$}=ui;$('enable').click();await settle();assert.match($('ownAvailability').className,/status-green/);
  ui.fail(true);$('refreshAgentStatus').click();await settle();assert.match($('ownAvailability').className,/status-red/);assert.equal($('agentStatusList').children.length,0);assert.match($('agentStatusMessage').textContent,/could not be verified/);
  ui.fail(false);ui.device.events.error({message:'SDK disconnected'});await settle();assert.equal(ui.presence.registered,false);assert.match($('ownAvailability').className,/status-red/);assert.deepEqual(ui.errors,[]);
  $('enable').click();await settle();assert.equal(ui.presence.registered,true);
  ui.w.navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Microphone denied');};
  $('enable').click();await settle();assert.equal(ui.presence.registered,false);assert.match($('ownAvailability').className,/status-red/);
});
