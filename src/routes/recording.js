import { Router } from 'express';
import { db } from '../db.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { callPayload, loadCall, validDuration } from '../services/call-state.js';
import { asyncRoute } from '../util/async-route.js';

export const recordingRouter = Router();
recordingRouter.post('/recording/status', asyncRoute(async (req, res) => {
  const body = req.body;
  const status = body.RecordingStatus || 'completed';
  const call = await loadCall(body.CallSid);
  const callSid = call?.twilio_call_sid || body.CallSid;
  if (!callSid || !body.RecordingSid) return res.status(400).json({ error: 'CallSid and RecordingSid are required' });
  if (!db.enabled) return res.status(503).json({ error: 'Recording storage unavailable' });
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO calls(twilio_call_sid) VALUES($1) ON CONFLICT DO NOTHING`, [callSid]);
    await tx.query(`INSERT INTO call_recordings(recording_sid,call_sid,url,duration_seconds,status,kind)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recording_sid) DO UPDATE SET
      url=coalesce(EXCLUDED.url,call_recordings.url),status=EXCLUDED.status,duration_seconds=EXCLUDED.duration_seconds`,
    [body.RecordingSid, callSid, body.RecordingUrl || null, validDuration(body.RecordingDuration), status, req.query.kind === 'voicemail' ? 'voicemail' : 'call']);
    if (status === 'completed' && body.RecordingUrl) {
      await tx.query(`UPDATE calls SET recording_url=$2,recording_state='stopped',
        is_voicemail=is_voicemail OR $3 WHERE twilio_call_sid=$1`, [callSid, body.RecordingUrl, req.query.kind === 'voicemail']);
      await emitWitnextEvent('call.recording_available', {
        ...(call ? callPayload(call) : { source: 'twilio', call_id: callSid }),
        recording_reference: body.RecordingUrl,
        recording_id: body.RecordingSid,
      }, { connection: tx });
    }
  });
  res.sendStatus(204);
}));
