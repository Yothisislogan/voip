import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { verifyTelnyxWebhook } from '../providers/telnyx.js';
import { enqueueJob } from '../jobs/queue.js';
import { asyncRoute } from '../util/async-route.js';

export const telnyxRouter = Router();
telnyxRouter.post('/telnyx/voice', asyncRoute(async (req, res) => {
  if (config.voiceProvider !== 'telnyx') return res.sendStatus(404);
  if (!verifyTelnyxWebhook(req.rawBody, req.headers)) return res.sendStatus(403);
  if (!db.enabled) return res.sendStatus(503);
  const event = req.body?.data;
  if (!event?.id || typeof event.id !== 'string' || event.id.length > 128 || !event.event_type || !event.payload?.call_control_id) return res.sendStatus(400);
  await enqueueJob('telnyxEvent', `telnyx:${event.id}`, event);
  res.sendStatus(200);
}));
