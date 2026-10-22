import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessExperience, experienceInput, EXPERIENCE_PROMPT } from '../src/services/call-experience.js';
import { validExperience, recommendationBand } from '../src/ai/experience-schema.js';
import { backendForSchema, recapBackend } from '../src/ai/client.js';
const segments=[{speaker:'agent',text:'Your claim is now resolved and the policy is corrected.'}, {speaker:'customer',text:'You fixed everything today. I am very happy with how you handled this and will recommend you to my friends.'}];
const result={csat:5,recommendation:10,confidence:'high',reason:'Customer explicitly describes resolution and referral intent.',evidence:['I am very happy with how you handled this','will recommend you to my friends']};
test('experience uses recap LLM and reports bounded independent predictions with customer evidence', async () => {
  const assessment=await assessExperience(segments,{complete:async args => {assert.equal(args.schemaName,'call_experience');assert.match(args.system,/untrusted/);return result;}});
  assert.equal(assessment.state,'ready');assert.equal(assessment.csat,5);assert.equal(assessment.recommendation,10);
  assert.equal(backendForSchema('call_experience'),recapBackend);assert.match(EXPERIENCE_PROMPT,/demographic/);
  assert.equal((await assessExperience(segments,{complete:async()=>({...result,recommendation:null})})).state,'ready');
});
test('agent quotations, invented evidence and invalid LLM outputs never become customer scores', async () => {
  for (const evidence of [['Your claim is now resolved'],['Nobody actually said this']]) {
    const x=await assessExperience(segments,{complete:async()=>({...result,evidence})});assert.equal(x.state,'insufficient');assert.equal(x.csat,null);
  }
  for (const value of [null,{}, {...result,csat:6},{...result,recommendation:11},{...result,csat:2.5}]) {
    assert.equal(validExperience(value),false);assert.equal((await assessExperience(segments,{complete:async()=>value})).state,'unavailable');
  }
});
test('short conversations skip the model, uncertain recommendation stays null, incomplete transcript lowers confidence', async () => {
  const x=await assessExperience([{speaker:'customer',text:'Thank you'}],{complete:async()=>{throw new Error('must not call LLM');}});assert.equal(x.state,'insufficient');
  const unknown=await assessExperience(segments,{complete:async()=>({...result,csat:null,recommendation:null,evidence:[]})});assert.equal(unknown.state,'insufficient');
  assert.equal((await assessExperience(segments,{partial:true,complete:async()=>result})).confidence,'low');
  assert.equal((await assessExperience([...segments,{speaker:'agent',text:'x'.repeat(17000)}],{complete:async()=>result})).confidence,'low');
  assert.notEqual(experienceInput(segments).fingerprint,experienceInput([...segments,{speaker:'customer',text:'New statement'}]).fingerprint);
});
test('individual recommendation bands use standard NPS boundaries',()=>{
  assert.deepEqual([0,6,7,8,9,10,null,11].map(recommendationBand),['detractor','detractor','passive','passive','promoter','promoter',null,null]);
});
