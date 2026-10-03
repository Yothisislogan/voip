import { db } from '../db.js';

function shape(row) {
  return row ? { conversationId: row.provider_id, channel: row.channel, customerRef: row.customer_ref,
    customerPhone: row.customer_phone, agentIdentity: row.agent_identity, contact: row.contact,
    optedOut: row.opted_out, messages: row.messages || [], lastAt: new Date(row.updated_at).getTime() } : null;
}
export async function persistInbound(msg, identity) {
  return db.transaction(async tx => {
    await tx.query(`INSERT INTO conversations(provider_id,channel,customer_ref,customer_phone,agent_identity)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id) DO NOTHING`,
    [msg.conversationId, msg.channel, msg.customerRef, msg.customerPhone, identity]);
    const { rows } = await tx.query(`INSERT INTO conversation_messages(conversation_id,event_key,direction,body,provider_sid)
      VALUES($1,$2,'customer',$3,$2) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
    [msg.conversationId, msg.messageSid, msg.text]);
    if (rows.length) await tx.query(`UPDATE conversations SET updated_at=now(),
      opted_out=CASE WHEN $2 ~* '^(stop|unsubscribe|cancel|end|quit|stopall)$' THEN true
                     WHEN $2 ~* '^(start|unstop)$' THEN false ELSE opted_out END WHERE provider_id=$1`, [msg.conversationId, msg.text.trim()]);
    return rows.length > 0;
  });
}
export async function getConversation(id) {
  return shape((await db.query('SELECT * FROM conversations WHERE provider_id=$1', [id])).rows[0]);
}
export async function listConversations(identity) {
  const { rows } = await db.query(`SELECT c.*,coalesce((SELECT jsonb_agg(m ORDER BY m.at) FROM (
    SELECT direction AS "from",body AS text,status,created_at AS at FROM conversation_messages
    WHERE conversation_id=c.provider_id ORDER BY created_at DESC LIMIT 200) m),'[]') AS messages
    FROM conversations c WHERE agent_identity=$1 ORDER BY updated_at DESC LIMIT 50`, [identity]);
  return rows.map(shape);
}
