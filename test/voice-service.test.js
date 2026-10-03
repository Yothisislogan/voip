import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStatus, validDuration, transcriptionEventKey, callPayload } from '../src/services/call-state.js';
import { chooseLead } from '../src/services/lead-matching.js';
import { config } from '../src/config.js';
import { isOpen, orderAgents } from '../src/services/routing.js';
import { normalizeBridgePayload } from '../src/integrations/witnext.js';
import { normalizeDialpadEvents, formatDialpadTranscript } from '../src/routes/dialpad.js';
import { canAccessCall } from '../src/auth/call-access.js';
import { parseInboundEmail, smartFinancialFields, extractPhone } from '../src/intake/email.js';
import { validDestination } from '../src/routes/voice.js';

test('late ringing/answer callbacks cannot reopen completed, missed or failed calls', () => {
  for (const terminal of ['completed','missed','failed','abandoned']) {
    for (const late of ['queued','ringing','in-progress','completed']) assert.equal(nextStatus(terminal, late), terminal);
  }
  assert.equal(nextStatus('in_progress','ringing'), 'in_progress');
  assert.equal(nextStatus('ringing','in-progress'), 'in_progress');
  assert.equal(nextStatus('ringing','no-answer'), 'missed');
  assert.equal(validDuration('0'), 0); assert.equal(validDuration('-1'), null); assert.equal(validDuration('foo'), null);
});
test('duplicate transcript identity uses provider sequence, not text', () => {
  const body = { TranscriptionSid: 'GTtest', SequenceId: '3', TranscriptionData: 'hello' };
  assert.equal(transcriptionEventKey(body), transcriptionEventKey({ ...body }));
  assert.notEqual(transcriptionEventKey(body), transcriptionEventKey({ ...body, SequenceId: '4' }));
});
test('SmartFinancial shared line is not a customer number in WiTnext payload', () => {
  const payload = normalizeBridgePayload(callPayload({ twilio_call_sid:'CA1', direction:'inbound', from_e164:'+16692793623', source_number:'+16692793623', customer_number:null }));
  assert.equal(payload.source_number, '+16692793623');
  assert.equal('external_number' in payload, false); assert.equal('from' in payload, false);
});
test('recent emails suggest one customer, reject overlaps and preserve exact correlation', () => {
  const call = { twilio_call_sid:'CA1', to_e164:'+12025550100', created_at:'2026-10-02T18:00:00Z' };
  const lead = { id:1, source:'smartfinancial', received_at:'2026-10-02T17:59:00Z', customer_phone:'+12025550101' };
  assert.equal(chooseLead(call,[lead]).state,'suggested');
  assert.equal(chooseLead(call,[lead,{...lead,id:2}]).state,'ambiguous');
  assert.equal(chooseLead(call,[{...lead,provider_call_id:'CA1'}]).state,'matched');
  assert.equal(chooseLead(call,[{...lead,claimed_call_sid:'CAother'}]).state,'awaiting_lead');
  assert.equal(chooseLead(call,[{...lead,destination_number:'+12025550199'}]).state,'awaiting_lead');
  assert.equal(chooseLead(call,[{...lead,received_at:'2026-10-01T18:00:00Z'}]).state,'awaiting_lead');
});
test('business hours respect New York daylight saving and holidays', () => {
  const route={ timezone:'America/New_York', hours:{1:[['09:00','17:00']]}, holidays:['2026-10-12'] };
  assert.equal(isOpen(route,new Date('2026-10-05T12:59:00Z')),false);
  assert.equal(isOpen(route,new Date('2026-10-05T13:00:00Z')),true);
  assert.equal(isOpen(route,new Date('2026-10-05T21:00:00Z')),false);
  assert.equal(isOpen(route,new Date('2026-11-02T14:00:00Z')),true);
  assert.equal(isOpen(route,new Date('2026-10-12T14:00:00Z')),false);
});
test('round robin and longest idle use their distinct clocks', () => {
  const agents=[{identity:'a',last_offered_at:1,idle_since:3},{identity:'b',last_offered_at:2,idle_since:1}];
  assert.equal(orderAgents(agents,'round_robin')[0].identity,'a');
  assert.equal(orderAgents(agents,'longest_idle')[0].identity,'b');
});
test('recap updates do not clear separately delivered action items', () => {
  assert.deepEqual(normalizeBridgePayload({recap:{summary:'Summary'}}).recap,{summary:'Summary'});
  assert.deepEqual(normalizeBridgePayload({recap:{nextSteps:['Call tomorrow']}}).recap.action_items,['Call tomorrow']);
});
test('Dialpad callback can carry completion, recap, transcript and recording together', () => {
  const events=normalizeDialpadEvents({call_id:123,state:'hangup',date_started:1790964000000,duration:0,
    direction:'inbound',external_number:'+12025550101',internal_number:'+12025550100',
    target:{type:'user',email:'agent@example.test',id:42},recap_summary:'Summary',recap_action_items:['Send quote'],
    transcript:'Customer: Hello',recording_url:'https://example.test/recording'});
  assert.deepEqual(events.map(e=>e.type),['call.completed','call.recap_available','call.transcript_available','call.recording_available']);
  assert.equal(events[0].payload.duration_seconds,0);
  assert.equal(events[0].payload.agent_identity,'agent@example.test');
  assert.equal(typeof events[0].payload.started_at,'string');
  assert.equal(normalizeDialpadEvents({call_id:123,state:'connected'}).length,0);
  assert.equal(normalizeDialpadEvents({call_id:123,state:'call_transcription'})[0].type,'hydrate');
});
test('Dialpad transcript preserves speakers and excludes AI moments', () => {
  assert.equal(formatDialpadTranscript({lines:[{type:'transcript',user_id:42,content:'Hello'},{type:'transcript',contact_id:'1',content:'Hi'},{type:'moment',content:'do not include'}]}),'Agent: Hello\nCustomer: Hi');
});
test('call authorization isolates agents and preserves an admin view', () => {
  const call={agent_identity:'alice',route_targets:['alice','bob']};
  assert.equal(canAccessCall({identity:'bob',role:'agent'},call),false);
  assert.equal(canAccessCall({identity:'alice',role:'agent'},call),true);
  assert.equal(canAccessCall({identity:'manager',role:'admin'},call),true);
  assert.equal(canAccessCall({identity:'bob',role:'agent'},{...call,agent_identity:null}),true);
});
test('email matching excludes vendor transfer phone and uses customer fields', () => {
  const email=parseInboundEmail({from:'Calls <leads@pro.smartfinancial.com>',text:'Transfer: 669-279-3623\nCustomer Name: Alex Example\nPhone: 202-555-0123\nEmail: alex@example.test\nCompany: Example Shop\nLead ID: lead-123'});
  assert.equal(smartFinancialFields(email).name,'Alex Example');
  assert.equal(smartFinancialFields(email).phone,'+12025550123');
  assert.equal(extractPhone(email.body),'+12025550123');
  assert.equal(email.messageId,parseInboundEmail({from:'Calls <leads@pro.smartfinancial.com>',text:email.body}).messageId);
});
test('outbound input cannot dial SIP/client targets, shortcodes or unapproved countries', () => {
  assert.equal(validDestination('(202) 555-0123'),'+12025550123');
  for(const number of ['911','client:agent','sip:a@b.test','+442071234567','+12025550100<script>']) assert.equal(validDestination(number),null);
  assert.deepEqual(config.voice.allowedPrefixes,['+1']);
});
