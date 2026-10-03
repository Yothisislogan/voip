import { db } from '../db.js';
import { config } from '../config.js';
import { enqueueJob } from '../jobs/queue.js';
import { loadCall, isSharedNumber } from './call-state.js';
import * as erpnext from '../crm/erpnext.js';
import { formatRecapNote } from '../ai/recap.js';
import { maybeSendSurvey } from '../realtime/survey.js';

export async function schedulePostCall(call, connection = db) {
  if (!call.ended_at || !call.customer_number || isSharedNumber(call.customer_number)) return;
  if (erpnext.crmEnabled) await enqueueJob('postCall', `erp:${call.twilio_call_sid}`, { callSid: call.twilio_call_sid, kind: 'erp' }, { connection });
  if (config.survey.enabled && call.status === 'completed') await enqueueJob('postCall', `survey:${call.twilio_call_sid}`, { callSid: call.twilio_call_sid, kind: 'survey' }, { connection });
}

export async function runPostCall({ callSid, kind }) {
  const call = await loadCall(callSid);
  if (!call?.ended_at || !call.customer_number || isSharedNumber(call.customer_number)) return;
  if (kind === 'survey' && !config.survey.enabled) throw new Error('Surveys disabled; queued effect remains unsent');
  if (kind === 'erp' && !erpnext.crmEnabled) throw new Error('ERPNext disabled; queued effect remains unsent');
  if (!['survey', 'erp'].includes(kind)) throw new Error('Unknown post-call effect');
  const key = `${kind}:${callSid}`;
  const claimed = await db.query(`INSERT INTO post_call_effects(effect_key,call_sid,kind,state)
    VALUES($1,$2,$3,'attempting') ON CONFLICT DO NOTHING RETURNING effect_key`, [key, callSid, kind]);
  if (!claimed.rows.length) {
    const previous = (await db.query('SELECT state FROM post_call_effects WHERE effect_key=$1', [key])).rows[0];
    if (previous.state === 'done') return;
    throw new Error('External outcome unconfirmed. Inspect provider records; automatic resend is blocked.');
  }
  try {
    if (kind === 'survey') {
      const optedOut = (await db.query('SELECT 1 FROM conversations WHERE customer_phone=$1 AND opted_out LIMIT 1', [call.customer_number])).rows.length;
      if (!optedOut && !await maybeSendSurvey({ callSid, session: { customerNumber: call.customer_number, contactId: call.contact_id } })) throw new Error('Survey send or persistence not confirmed');
    } else {
      const contact = await erpnext.findContactByPhone(call.customer_number);
      const note = formatRecapNote(call.recap, { from: call.customer_number, to: call.to_e164, durationSec: call.duration_seconds });
      if (!note) throw new Error('No recap available for ERPNext');
      if (!await erpnext.writeRecapNote({ contact, ...note })) throw new Error('ERPNext recap write not confirmed');
      if (!await erpnext.logCallActivity({ contact, callSid, from: call.from_e164, to: call.to_e164, durationSec: call.duration_seconds, direction: call.direction })) throw new Error('ERPNext call log not confirmed; recap may already exist');
    }
    await db.query("UPDATE post_call_effects SET state='done',updated_at=now() WHERE effect_key=$1", [key]);
  } catch (error) {
    await db.query("UPDATE post_call_effects SET state='unconfirmed',error=$2,updated_at=now() WHERE effect_key=$1", [key, String(error.message).slice(0, 1000)]);
    throw error;
  }
}
