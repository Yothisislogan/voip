import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Explicit opt-in: never mutate a developer's normal DATABASE_URL database.
const enabled = !!process.env.VOIP_TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.VOIP_TEST_DATABASE_URL;
const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { createCall, applyStatus, loadCall, persistUtterance } = await import('../src/services/call-state.js');
const { enqueueJob, claimJob, finishJob } = await import('../src/jobs/queue.js');
const { upsertLeadSignal, matchCallLead } = await import('../src/services/lead-matching.js');
const { onCallComplete } = await import('../src/realtime/orchestrator.js');
const { endSession } = await import('../src/realtime/sessions.js');
const { selectTargets } = await import('../src/services/routing.js');
const { persistInbound, listConversations } = await import('../src/messaging/store.js');
const prefix = `test-${randomUUID()}`;
const sid = n => `CA${prefix}-${n}`;
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
before(() => {
  if (!enabled) return;
  config.witnext.url='https://witnext.example.test'; config.witnext.secret='test-only'; config.witnext.integrationId='test-only';
});
after(async () => {
  if (!enabled) return;
  await db.query("UPDATE service_jobs SET state='done',payload='{}' WHERE job_key LIKE $1 OR payload::text LIKE $1", [`%${prefix}%`]);
  await db.close();
});

integration('parent call survives child no-answer and terminal webhook does not depend on AI', async () => {
  const id = sid('legs');
  await createCall({callSid:id,direction:'inbound',from:'+12025550101',to:'+12025550100',targets:['alice','bob']});
  await applyStatus({CallSid:`${id}-alice`,ParentCallSid:id,CallStatus:'no-answer',SequenceNumber:'2'},{agentIdentity:'alice'});
  await applyStatus({CallSid:`${id}-alice`,ParentCallSid:id,CallStatus:'in-progress',SequenceNumber:'1'},{agentIdentity:'alice'});
  assert.equal((await loadCall(id)).status,'queued');
  await applyStatus({CallSid:`${id}-bob`,ParentCallSid:id,CallStatus:'in-progress',SequenceNumber:'1'},{agentIdentity:'bob'});
  assert.equal((await loadCall(id)).agent_identity,'bob');
  await applyStatus({CallSid:id,CallStatus:'completed',CallDuration:'0'});
  await applyStatus({CallSid:id,CallStatus:'ringing'});
  const call=await loadCall(id);
  assert.equal(call.status,'completed'); assert.equal(call.duration_seconds,0);
  assert.equal(call.recap,null);
  const jobs=(await db.query("SELECT * FROM service_jobs WHERE kind='witnextEvent' AND payload->'payload'->>'call_id'=$1",[id])).rows;
  assert.equal(jobs.length,1); assert.equal(jobs[0].payload.eventType,'call.completed');
});

integration('early status then voice setup fills call context without reopening it', async () => {
  const id=sid('early'); await applyStatus({CallSid:id,CallStatus:'completed'});
  await createCall({callSid:id,direction:'inbound',from:'+12025550102',to:'+12025550100',identity:'alice',targets:['alice']});
  const call=await loadCall(id); assert.equal(call.status,'completed'); assert.equal(call.direction,'inbound'); assert.equal(call.customer_number,'+12025550102');
});

integration('concurrent duplicate transcripts persist once and late text regenerates recap after restart', async () => {
  const id=sid('transcript'); await createCall({callSid:id,direction:'inbound',from:'+12025550103',to:'+12025550100',identity:'alice'});
  const body={CallSid:id,TranscriptionSid:'GT1',SequenceId:'1',Timestamp:'2026-10-02T18:00:00Z'};
  await Promise.all(Array.from({length:8},()=>persistUtterance(body,'customer','I need an auto insurance quote.')));
  assert.equal((await db.query('SELECT * FROM transcript_segments WHERE call_sid=$1',[id])).rows.length,1);
  await applyStatus({CallSid:id,CallStatus:'completed',CallDuration:'30'}, { terminal: true });
  endSession(id); // no live process state remains
  await onCallComplete(id);
  const original=await loadCall(id); assert.equal(original.recap_state,'ready'); assert.ok(original.recap.summary);
  await persistUtterance({...body,SequenceId:'2',Timestamp:'2026-10-02T18:00:02Z'},'customer','Please call me tomorrow about the quote.');
  await onCallComplete(id);
  const updated=await loadCall(id); assert.notEqual(updated.recap_fingerprint,original.recap_fingerprint);
  assert.equal(updated.status,'completed');
});

integration('shared vendor phone never creates a contact; exact late email links once', async () => {
  const id=sid('lead'); await createCall({callSid:id,direction:'inbound',from:'+16692793623',to:'+12025550100'});
  assert.equal((await loadCall(id)).customer_number,null);
  const signal=await upsertLeadSignal({source:'smartfinancial',source_id:`${prefix}-lead`,provider_call_id:id,customer_phone:'+12025550104',customer_name:'Alex Example'});
  const result=await matchCallLead(id); assert.equal(result.state,'matched');
  const call=await loadCall(id); assert.equal(call.customer_number,'+12025550104'); assert.equal(call.source_number,'+16692793623'); assert.ok(call.contact_id);
  assert.equal((await db.query('SELECT claimed_call_sid FROM lead_signals WHERE id=$1',[signal.id])).rows[0].claimed_call_sid,id);
  const second=sid('lead2'); await createCall({callSid:second,direction:'inbound',from:'+16692793623',to:'+12025550100'});
  await assert.rejects(()=>matchCallLead(second,{signalId:signal.id,actor:'alice'}),/already linked/);
});

integration('route reservation is atomic and callback retries reuse the same target', async () => {
  config.auth.agents=[{identity:`${prefix}-a`,role:'agent'},{identity:`${prefix}-b`,role:'agent'}];
  const identities=config.auth.agents.map(a=>a.identity);
  config.voice.routing={agents:identities,strategy:'round_robin'};
  for(const identity of identities) await db.query("INSERT INTO agent_presence(identity,status) VALUES($1,'available')",[identity]);
  const [one,two]=await Promise.all([selectTargets(sid('route1')),selectTargets(sid('route2'))]);
  assert.equal(one.targets.length,1); assert.equal(two.targets.length,1); assert.notEqual(one.targets[0],two.targets[0]);
  assert.deepEqual((await selectTargets(sid('route1'))).targets,one.targets);
  config.voice.routing=null;
});

integration('worker leases are exclusive and stale workers cannot complete reclaimed work', async () => {
  // Isolate claim test from preceding jobs without deleting their evidence.
  await db.query("UPDATE service_jobs SET run_after=now()+interval '1 day' WHERE state='pending'");
  await enqueueJob('test',`${prefix}:lease`,{v:1});
  const claims=await Promise.all([claimJob(),claimJob()]);
  const job=claims.find(Boolean); assert.equal(claims.filter(Boolean).length,1);
  await db.query("UPDATE service_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  const reclaimed=await claimJob(); assert.notEqual(job.lease_token,reclaimed.lease_token);
  await finishJob(job); assert.equal((await db.query('SELECT state FROM service_jobs WHERE id=$1',[job.id])).rows[0].state,'running');
  await enqueueJob('test',`${prefix}:lease`,{v:2},{refresh:true});
  await finishJob(reclaimed);
  assert.equal((await db.query('SELECT state FROM service_jobs WHERE id=$1',[job.id])).rows[0].state,'pending');
});

integration('SMS duplicate webhook is persisted once and opt-out survives a fresh DB read', async () => {
  const msg={conversationId:`CH${prefix}`,messageSid:`IM${prefix}`,channel:'sms',customerRef:'+12025550105',customerPhone:'+12025550105',text:'STOP'};
  const results=await Promise.all([persistInbound(msg,'alice'),persistInbound(msg,'alice')]);
  assert.equal(results.filter(Boolean).length,1);
  const rows=await listConversations('alice'); const conversation=rows.find(c=>c.conversationId===msg.conversationId);
  assert.equal(conversation.optedOut,true); assert.equal(conversation.messages.length,1);
});

integration('root greeting is not agent answer; reordered answer corrects terminal state without child duration overwrite', async () => {
  const id=sid('parent-answer');
  await createCall({callSid:id,direction:'inbound',from:'+12025550107',to:'+12025550100',targets:['alice']});
  await applyStatus({CallSid:id,CallStatus:'in-progress'});
  assert.equal((await loadCall(id)).answered_at,null);
  await applyStatus({CallSid:id,CallStatus:'completed',CallDuration:'75'});
  assert.equal((await loadCall(id)).status,'abandoned');
  await applyStatus({CallSid:`${id}-child`,ParentCallSid:id,CallStatus:'in-progress',SequenceNumber:'1'},{agentIdentity:'alice'});
  assert.equal((await loadCall(id)).status,'completed');
  await applyStatus({CallSid:`${id}-child`,ParentCallSid:id,CallStatus:'completed',CallDuration:'25',SequenceNumber:'2'},{agentIdentity:'alice'});
  assert.equal((await loadCall(id)).duration_seconds,75);
});

integration('email webhook replay creates one intake even under concurrent delivery', async () => {
  const { parseInboundEmail,handleInboundEmail } = await import('../src/intake/email.js');
  const parsed=parseInboundEmail({from:'Leads <leads@smartfinancial.com>',message_id:`${prefix}-email`,subject:'Example lead',text:'Customer Name: Alex Example\nCustomer Phone: 202-555-0108\nCustomer Email: alex@example.com'});
  const [one,two]=await Promise.all([handleInboundEmail(parsed),handleInboundEmail(parsed)]);
  assert.equal(one.emailIntakeId,two.emailIntakeId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM email_intake WHERE message_id=$1',[parsed.messageId])).rows[0].n,1);
  assert.equal(one.phone,'+12025550108');
});

integration('uncertain external post-call side effect cannot be blindly resent by a worker retry', async () => {
  const { runPostCall } = await import('../src/services/post-call.js');
  const id=sid('survey');
  await createCall({callSid:id,direction:'outbound',from:'+12025550100',to:'+12025550109',identity:'alice'});
  await applyStatus({CallSid:id,CallStatus:'completed'});
  config.survey.enabled=true;
  try {
    await db.query("INSERT INTO post_call_effects(effect_key,call_sid,kind,state) VALUES($1,$2,'survey','attempting')",[`survey:${id}`,id]);
    await assert.rejects(()=>runPostCall({callSid:id,kind:'survey'}),/automatic resend is blocked/);
    assert.equal((await db.query('SELECT state FROM post_call_effects WHERE effect_key=$1',[`survey:${id}`])).rows[0].state,'attempting');
  } finally { config.survey.enabled=false; }
});

integration('AssemblyAI final turns persist once per track and an interruption survives stream stop', async () => {
  const { saveAssemblyTurn, setTranscriptionState, recoverInterruptedStreams } = await import('../src/realtime/transcription.js');
  const id = sid('assemblyai');
  await createCall({ callSid: id, direction: 'outbound', from: '+12025550100', to: '+12025550110', identity: 'alice' });
  const utterance = { callSid: id, streamSid: `MZ${prefix}`, track: 'inbound',
    turn: { turn_order: 0, transcript: 'I can help with that quote.' }, timestamp: Date.now() };
  await saveAssemblyTurn(utterance);
  await saveAssemblyTurn(utterance);
  await saveAssemblyTurn({ ...utterance, track: 'outbound', turn: { turn_order: 0, transcript: 'Please call tomorrow.' } });
  const segments = (await db.query('SELECT speaker,text FROM transcript_segments WHERE call_sid=$1 ORDER BY seq', [id])).rows;
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(s => s.speaker), ['agent', 'customer']);
  await setTranscriptionState(id, 'streaming');
  await setTranscriptionState(id, 'error', 'assemblyai_disconnected');
  await setTranscriptionState(id, 'stopped');
  const call = await loadCall(id);
  assert.equal(call.transcription_state, 'error');
  assert.equal(call.transcription_error, 'assemblyai_disconnected');
  assert.ok(call.transcript_stopped_at);
  assert.equal(call.status, 'queued'); // A transcript failure cannot hang up a call.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM service_jobs WHERE job_key=$1", [`recap:${id}`])).rows[0].n, 1);
  const interrupted = sid('assemblyai-crash');
  await createCall({ callSid: interrupted, direction: 'inbound', from: '+12025550111', to: '+12025550100', identity: 'alice' });
  await setTranscriptionState(interrupted, 'streaming');
  await recoverInterruptedStreams();
  assert.equal((await loadCall(interrupted)).transcription_error, 'server_restart');
});
