import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { ringbaAvailability, deniedAvailability } from '../services/ringba-availability.js';

// Ringba calls this buyer-owned endpoint on demand. This is not a Ringba admin API.
export function createRingbaRouter({ read = ringbaAvailability } = {}) {
  const router = Router();
  const rejectedAuth = rateLimit('ringba-auth', 30, { windowMs: 60000 });
  const authenticated = rateLimit('ringba-availability', config.ringba.requestsPerMinute,
    { windowMs: 60000, key: () => 'integration', denied: () => deniedAvailability(null, 'rate_limited') });
  router.use('/integrations/ringba', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const provided = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '')?.[1] || '', expected = config.ringba.token;
    const valid = expected.length >= 32 && provided.length === expected.length
      && Buffer.byteLength(provided) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) return rejectedAuth(req, res, () => res.status(401).json(deniedAvailability(null, 'unauthorized')));
    authenticated(req, res, next);
  });
  const availability = async (req, res) => {
    const campaign = req.method === 'POST' ? req.body?.campaign : req.query.campaign;
    if (typeof campaign !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(campaign))
      return res.status(400).json(deniedAvailability(null, 'campaign_required'));
    try { return res.json(await read(campaign)); }
    catch { return res.status(503).json(deniedAvailability(campaign, 'availability_unavailable')); }
  };
  router.get('/integrations/ringba/availability', availability);
  router.post('/integrations/ringba/availability', availability);
  return router;
}
export const ringbaRouter = createRingbaRouter();
