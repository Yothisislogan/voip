import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, PRESENCE_MAX_AGE_MS } from '../src/services/agent-availability.js';
import { trackWorkspace, workspaceOnline } from '../src/realtime/workspace-presence.js';
const now=Date.now();
const ready={connected:true,callingEnabled:true,now,presence:{status:'available',phone_registered:true,heartbeat_at:new Date(now).toISOString()}};
test('only registered, reachable, fresh and idle agents are green',()=>{
  assert.equal(agentStatus(ready).color,'green');
  for(const override of [{connected:false},{callingEnabled:false},{activeCall:true},{internalCall:true},{presence:null},
    {presence:{...ready.presence,phone_registered:false}},
    {presence:{...ready.presence,heartbeat_at:new Date(now-PRESENCE_MAX_AGE_MS).toISOString()}},
    {presence:{...ready.presence,heartbeat_at:'invalid'}},
    {presence:{...ready.presence,status:'unknown'}},
    ...['busy','dnd','offline'].map(status=>({presence:{...ready.presence,status}}))]) {
    const actual=agentStatus({...ready,...override});assert.equal(actual.color,'red');assert.equal(actual.available,false);
  }
});
test('yellow excludes away, after-call work and offers from buying; expired offers can become green',()=>{
  for(const presence of [{...ready.presence,status:'away'},{...ready.presence,status:'wrapup'},
    {...ready.presence,reserved_until:new Date(now+15000).toISOString()}]) {
    const result=agentStatus({...ready,presence});assert.equal(result.color,'yellow');assert.equal(result.available,false);
  }
  assert.equal(agentStatus({...ready,presence:{...ready.presence,reserved_until:new Date(now-1).toISOString()}}).available,true);
});
test('workspace connection tracking tolerates multiple tabs but excludes revoked, closed or stale sockets',()=>{
  const id='test-presence',a={readyState:1},b={readyState:1};let authorized=true;
  const first=trackWorkspace(id,a,()=>authorized),second=trackWorkspace(id,b);
  try {assert.equal(workspaceOnline(id),true);second.close();assert.equal(workspaceOnline(id),true);
    authorized=false;assert.equal(workspaceOnline(id),false);authorized=true;
    assert.equal(workspaceOnline(id,Date.now()+45001),false);first.touch();assert.equal(workspaceOnline(id),true);
    a.readyState=3;assert.equal(workspaceOnline(id),false);
  }finally{first.close();second.close();}
  assert.equal(workspaceOnline(id),false);
});
