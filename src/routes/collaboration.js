import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { csrfProtect } from '../middleware/csrf.js';
import { asyncRoute } from '../util/async-route.js';
import { collaborationHub as hub } from '../realtime/collaboration.js';
import { audit } from '../audit.js';

export const collaborationRouter=Router();
collaborationRouter.use('/api/office',requireAuth,csrfProtect,requireRole('agent'),(_req,res,next) => {
  res.set('Cache-Control','no-store');
  if (!config.collaboration.enabled || !db.enabled) return res.status(503).json({ error:'Team communication is not enabled yet' });
  next();
});
function teammate(identity, me) {
  if (identity === me || !config.auth.agents.some(a => a.identity === identity && a.role !== 'viewer'))
    throw Object.assign(new Error('Choose an active teammate'),{status:400});
  return identity;
}
collaborationRouter.get('/api/office/team',asyncRoute(async (req,res) => {
  const unread=(await db.query('SELECT sender,count(*)::int AS unread FROM office_messages WHERE recipient=$1 AND read_at IS NULL GROUP BY sender',[req.agent.identity])).rows;
  const presence=(await db.query("SELECT identity,status FROM agent_presence WHERE heartbeat_at>now()-interval '75 seconds'")).rows;
  res.json({ teammates:config.auth.agents.filter(a => a.role !== 'viewer' && a.identity !== req.agent.identity).map(a => ({
    identity:a.identity,name:a.name || a.identity,online:hub.agents.has(a.identity),busy:hub.busy(a.identity),
    presence:presence.find(p => p.identity === a.identity)?.status || 'offline',
    unread:unread.find(r => r.sender === a.identity)?.unread || 0,
  })), relayConfigured:!!(config.collaboration.turnUrls.length && config.collaboration.turnSecret) });
}));
collaborationRouter.get('/api/office/messages/:peer',asyncRoute(async (req,res) => {
  const peer=teammate(req.params.peer,req.agent.identity);
  const before=typeof req.query.before === 'string' && /^\d{1,18}$/.test(req.query.before) ? req.query.before : null;
  const messages=(await db.query(`SELECT * FROM (SELECT * FROM office_messages
    WHERE ((sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)) AND ($3::bigint IS NULL OR id<$3)
    ORDER BY id DESC LIMIT 100) page ORDER BY id`,[req.agent.identity,peer,before])).rows;
  res.json({messages});
}));
collaborationRouter.post('/api/office/messages/:peer',asyncRoute(async (req,res) => {
  const peer=teammate(req.params.peer,req.agent.identity), body=req.body.body, clientId=req.body.clientId;
  if (typeof body !== 'string' || !body.trim() || body.length>4000 || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(clientId || ''))
    return res.status(400).json({error:'Message (1–4000 characters) and client ID required'});
  const message=await db.transaction(async tx => {
    const saved=(await tx.query(`INSERT INTO office_messages(sender,recipient,body,client_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(sender,client_id) DO NOTHING RETURNING *`,[req.agent.identity,peer,body.trim(),clientId])).rows[0];
    const row=saved || (await tx.query('SELECT * FROM office_messages WHERE sender=$1 AND client_id=$2',[req.agent.identity,clientId])).rows[0];
    if (row.recipient !== peer || row.body !== body.trim()) throw Object.assign(new Error('Message ID already used for a different message'),{status:409});
    return row;
  });
  for (const id of [peer,req.agent.identity]) hub.send(hub.agents.get(id),{type:'office_message',sender:message.sender,recipient:message.recipient});
  res.status(201).json({message});
}));
collaborationRouter.post('/api/office/messages/:peer/read',asyncRoute(async (req,res) => {
  const peer=teammate(req.params.peer,req.agent.identity);
  if (!/^\d{1,18}$/.test(String(req.body.throughId))) return res.sendStatus(400);
  await db.query('UPDATE office_messages SET read_at=coalesce(read_at,now()) WHERE sender=$1 AND recipient=$2 AND id<=$3',[peer,req.agent.identity,req.body.throughId]);
  res.json({ok:true});
}));
collaborationRouter.post('/api/office/screen',asyncRoute(async (req,res) => {
  const share=hub.createScreen(req.agent.identity);
  audit({req,action:'screen.created',entityType:'screen',entityId:share.id});
  res.status(201).json({...share,token:undefined,url:`${config.publicBaseUrl}/share.html#${share.token}`});
}));
collaborationRouter.post('/api/office/call',asyncRoute(async (req,res) => {
  const peer=teammate(req.body.peer,req.agent.identity);
  const room=await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(7170701)');
    const identities=[peer,req.agent.identity];
    const active=(await tx.query(`SELECT 1 FROM calls WHERE agent_identity=ANY($1::text[]) AND ended_at IS NULL
      AND status IN ('queued','ringing','in_progress') AND created_at>now()-interval '4 hours' LIMIT 1`,[identities])).rows.length;
    const reserved=(await tx.query("SELECT 1 FROM agent_presence WHERE identity=ANY($1::text[]) AND (reserved_until>now() OR (identity=$2 AND heartbeat_at>now()-interval '75 seconds' AND status IN ('busy','away','dnd','wrapup')))",[identities,peer])).rows.length;
    if (active || reserved) throw Object.assign(new Error('A teammate is busy or unavailable'),{status:409});
    return hub.createVoice(req.agent.identity,peer);
  });
  audit({req,action:'office.call_started',entityType:'office_call',entityId:room.id});
  res.status(201).json(room);
}));
