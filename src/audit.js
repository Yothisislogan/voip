import { db } from "./db.js";
import { log } from "./logger.js";

/**
 * Append-only audit trail. Records security- and PII-relevant actions to the
 * audit_log table. Best-effort: a DB hiccup logs a warning but never breaks the
 * request. Secrets are never passed in `detail` (callers redact first).
 */

/**
 * writeAudit({ req, action, entityType, entityId, detail })
 * `req` (optional) supplies the actor (req.agent) and correlation (req.reqId, ip).
 */
export async function writeAudit({ req, actor, action, entityType = null, entityId = null, detail = null }) {
  const a = actor || req?.agent || {};
  const ip = req ? clientIp(req) : null;
  const requestId = req?.reqId || null;
  // Always emit a structured log line even when the DB is off.
  log.info("audit", { action, entityType, entityId, actor: a.identity || "system", reqId: requestId });
  if (!db.enabled) return;
  try {
    await db.query(
      `INSERT INTO audit_log
         (actor_identity, actor_email, actor_role, action, entity_type, entity_id, ip, request_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        a.identity || "system",
        a.email || null,
        a.role || null,
        action,
        entityType,
        entityId != null ? String(entityId) : null,
        ip,
        requestId,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (err) {
    log.warn("audit.write_failed", { action, err: err.message });
  }
}

/** Fire-and-forget variant for hot paths where we don't want to await. */
export function audit(opts) {
  writeAudit(opts).catch(() => {});
}

/** List recent audit entries (admin surface). */
export async function listAudit({ limit = 100, actor, action, entityId } = {}) {
  if (!db.enabled) return [];
  const where = [];
  const params = [];
  if (actor) { params.push(actor); where.push(`actor_identity = $${params.length}`); }
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  if (entityId) { params.push(String(entityId)); where.push(`entity_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 100, 500));
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY at DESC LIMIT $${params.length}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

function clientIp(req) {
  // Last XFF entry = appended by our own proxy (unforgeable by the client);
  // the first entry is attacker-controlled and must not be recorded as fact.
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) {
    const chain = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return req.socket?.remoteAddress || req.ip || null;
}
