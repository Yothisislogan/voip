import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { callerPhone, chooseTagRule, validateTagRule } from '../src/services/tag-routing.js';
test('tag routing selects the highest priority available matching user and ignores disabled rules', () => {
  const rules=[{tag:'auto',preferred_agent:'alice',priority:5,enabled:true},{tag:'home',preferred_agent:'bob',priority:1,enabled:true},{tag:'vip',preferred_agent:'cara',priority:0,enabled:false}];
  assert.equal(chooseTagRule(['Auto','HOME','VIP'],rules,['alice','bob','cara']).preferred_agent,'bob');
  assert.equal(chooseTagRule(['Auto','HOME'],rules,['alice']).preferred_agent,'alice');
  assert.equal(chooseTagRule(['Unknown'],rules,['alice']),null);
});
test('routing validation rejects unknown users, shared caller numbers and invalid ring times', () => {
  const before=config.auth.agents; config.auth.agents=[{identity:'alice',role:'agent'},{identity:'viewer',role:'viewer'}];
  try { const body={tag:' Commercial Auto ',preferredAgent:'alice',priority:1,ringSeconds:15,enabled:true,version:0};
    assert.equal(validateTagRule(body).tag,'commercial auto');
    assert.throws(()=>validateTagRule({...body,preferredAgent:'viewer'}),/active/);
    assert.throws(()=>validateTagRule({...body,ringSeconds:99}),/Ring/);
    assert.throws(()=>callerPhone(config.voice.sharedSourceNumbers[0]),/customer number/);
    assert.equal(callerPhone('(202) 555-0100'),'+12025550100');
  } finally {config.auth.agents=before;}
});
