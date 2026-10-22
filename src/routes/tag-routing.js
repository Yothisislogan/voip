import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { csrfProtect } from '../middleware/csrf.js';
import { asyncRoute } from '../util/async-route.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { callerPhone, validateTagRule } from '../services/tag-routing.js';
import { normalizeTags } from '../services/call-organization.js';
import { config } from '../config.js';

export const tagRoutingRouter = Router();
tagRoutingRouter.use('/api/tag-routing', requireAuth, csrfProtect, requireRole('admin'), (_req,res,next) => {
  res.set('Cache-Control','no-store');
  if (!db.enabled) return res.sendStatus(503);
  next();
});
tagRoutingRouter.get('/api/tag-routing', asyncRoute(async (_req,res) => {
  res.json({ enabled: config.voice.tagRoutingEnabled, rules: (await db.query('SELECT * FROM tag_routing_rules ORDER BY priority,tag')).rows,
    agents: config.auth.agents.filter(a => a.role !== 'viewer').map(a => ({ identity: a.identity, name: a.name || a.identity })) });
}));
tagRoutingRouter.put('/api/tag-routing/rule', asyncRoute(async (req,res) => {
  const r = validateTagRule(req.body);
  const row = (await db.query(`INSERT INTO tag_routing_rules(tag,label,preferred_agent,priority,ring_seconds,enabled,updated_by)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $8=0
    ON CONFLICT(tag) DO NOTHING RETURNING *`, [r.tag,r.label,r.preferredAgent,r.priority,r.ringSeconds,r.enabled,req.agent.identity,r.version])).rows[0]
    || (await db.query(`UPDATE tag_routing_rules SET label=$2,preferred_agent=$3,priority=$4,ring_seconds=$5,enabled=$6,
      updated_by=$7,version=version+1,updated_at=now() WHERE tag=$1 AND version=$8 AND $8>0 RETURNING *`,
    [r.tag,r.label,r.preferredAgent,r.priority,r.ringSeconds,r.enabled,req.agent.identity,r.version])).rows[0];
  if (!row) return res.status(409).json({ error: 'This rule changed. Reload before saving.' });
  audit({ req, action: 'routing.rule_saved', entityType: 'tag', entityId: r.tag });
  res.json({ rule: row });
}));
tagRoutingRouter.get('/api/tag-routing/caller', asyncRoute(async (req,res) => {
  const phone = callerPhone(req.query.phone);
  const row = (await db.query('SELECT * FROM caller_routing_tags WHERE phone=$1', [phone])).rows[0];
  res.json({ caller: row || { phone, tags: [], version: 0 } });
}));
tagRoutingRouter.put('/api/tag-routing/caller', asyncRoute(async (req,res) => {
  const phone = callerPhone(req.body.phone), tags = normalizeTags(req.body.tags), version = req.body.version;
  if (!Number.isInteger(version) || version < 0) return res.status(400).json({ error: 'Load the caller before saving' });
  const row = (await db.query(`INSERT INTO caller_routing_tags(phone,tags,updated_by) SELECT $1,$2,$3 WHERE $4=0
    ON CONFLICT(phone) DO NOTHING RETURNING *`, [phone,tags,req.agent.identity,version])).rows[0]
    || (await db.query(`UPDATE caller_routing_tags SET tags=$2,updated_by=$3,version=version+1,updated_at=now()
      WHERE phone=$1 AND version=$4 AND $4>0 RETURNING *`, [phone,tags,req.agent.identity,version])).rows[0];
  if (!row) return res.status(409).json({ error: 'Caller tags changed. Reload before saving.' });
  audit({ req, action: 'routing.caller_tags_saved', entityType: 'caller', entityId: phone });
  res.json({ caller: row });
}));
