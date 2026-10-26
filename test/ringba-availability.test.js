import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { ringbaAvailability, validateRingba } from '../src/services/ringba-availability.js';
const before={ringba:config.ringba,agents:config.auth.agents,routing:config.voice.routing};
function configure(){config.ringba={enabled:true,token:'x'.repeat(32),requestsPerMinute:600,campaigns:[{id:'commercial-auto',enabled:true,agents:['alice','bob']}]};config.auth.agents=['alice','bob','cara'].map(identity=>({identity,role:'agent'}));config.voice.routing={agents:['alice','bob'],strategy:'simultaneous'};}
function restore(){config.ringba=before.ringba;config.auth.agents=before.agents;config.voice.routing=before.routing;}
test('Ringba response contains only aggregated green capacity from the matching routing pool',async()=>{
  configure();try{
    const data=await ringbaAvailability('commercial-auto',{read:async({identities})=>{assert.deepEqual(identities,['alice','bob']);return[{identity:'alice',color:'green',available:true,reason:'available'},{identity:'bob',color:'yellow',available:false,reason:'wrapup'}];}});
    assert.deepEqual(data.response,{available:1,active:2,accept:true,status:'green'});assert.equal(data.snapshotOnly,true);
    assert.ok(!JSON.stringify(data).includes('alice'));assert.ok(!JSON.stringify(data).includes(config.ringba.token));
  }finally{restore();}
});
test('paused, disabled, unknown, closed or invalid Ringba pools never read or advertise capacity',async()=>{
  configure();try{
    const read=async()=>{throw new Error('must not read');};
    config.ringba.enabled=false;assert.equal((await ringbaAvailability('commercial-auto',{read})).reason,'disabled');config.ringba.enabled=true;
    assert.equal((await ringbaAvailability('unknown',{read})).response.accept,false);
    config.ringba.campaigns[0].enabled=false;assert.equal((await ringbaAvailability('commercial-auto',{read})).reason,'campaign_paused');config.ringba.campaigns[0].enabled=true;
    config.ringba.campaigns[0].hours={};assert.equal((await ringbaAvailability('commercial-auto',{read})).reason,'closed');delete config.ringba.campaigns[0].hours;
    config.voice.routing.hours={};assert.equal((await ringbaAvailability('commercial-auto',{read})).reason,'closed');delete config.voice.routing.hours;
    config.ringba.campaigns[0].agents=['unknown'];assert.ok(validateRingba().length);assert.equal((await ringbaAvailability('commercial-auto',{read})).reason,'invalid_configuration');
  }finally{restore();}
});
test('only configured normal routing agents count, and all-yellow status still rejects call buying',async()=>{
  configure();try{
    config.ringba.campaigns[0].agents=['alice','cara'];
    const data=await ringbaAvailability('commercial-auto',{read:async({identities})=>{assert.deepEqual(identities,['alice']);return[{color:'yellow',available:false,reason:'reserved'}];}});
    assert.equal(data.response.available,0);assert.equal(data.response.status,'yellow');assert.equal(data.response.accept,false);
  }finally{restore();}
});
