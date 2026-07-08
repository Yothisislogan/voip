import { db } from "../db.js";
import { log } from "../logger.js";

/**
 * Session revocation registry. Stateless JWT sessions can't be "deleted", so we
 * keep a small revocation set that every full-session check consults:
 *
 *   - revoke a single token (logout)          → jti denylist
 *   - revoke ALL of an identity's sessions     → identity "not-before" cutoff
 *     (offboarding, role change, compromise)
 *
 * State is held IN MEMORY for a zero-latency, DB-free check on the hot auth path
 * (mirrors the rate limiter). Postgres is the durable backstop: revocations are
 * persisted and reloaded at startup so a restart doesn't resurrect dead
 * sessions. Everything degrades gracefully when the DB is off (in-memory only).
 */

const revokedJtis = new Map(); // jti -> expiry epoch seconds (for pruning)
const identityNotBefore = new Map(); // identity -> epoch seconds; tokens iat < this are dead

/** True if this session payload has been revoked. Sync + allocation-free. */
export function isRevoked(payload) {
  if (!payload) return true;
  if (payload.jti && revokedJtis.has(payload.jti)) return true;
  const nb = identityNotBefore.get(payload.identity);
  if (nb && (payload.iat || 0) < nb) return true;
  return false;
}

/** Revoke one session (logout). exp is the token's expiry (epoch seconds). */
export async function revokeJti(jti, exp) {
  if (!jti) return;
  revokedJtis.set(jti, exp || nowSec() + 24 * 3600);
  await persist("jti", jti, { expiresAt: exp ? new Date(exp * 1000) : null });
}

/** Revoke every session issued to an identity up to now (log out everywhere). */
export async function revokeIdentity(identity, createdBy) {
  if (!identity) return;
  // +1s so a token issued in the SAME second as the revoke (iat === now) is
  // still killed (iat < cutoff); a fresh login next second survives.
  const cutoff = nowSec() + 1;
  identityNotBefore.set(identity, Math.max(cutoff, identityNotBefore.get(identity) || 0));
  await persist("identity", identity, {
    notBefore: new Date(cutoff * 1000),
    // Keep the row until the longest-lived token issued before now would expire.
    expiresAt: new Date((cutoff + sessionTtlSec()) * 1000),
    createdBy,
    upsertNotBefore: true,
  });
}

/** Load persisted revocations at startup so a restart honors them. */
export async function loadRevocations() {
  if (!db.enabled) return;
  try {
    const { rows } = await db.query(
      "SELECT kind, key, not_before, expires_at FROM session_revocations WHERE expires_at IS NULL OR expires_at > now()"
    );
    for (const r of rows) {
      if (r.kind === "jti") revokedJtis.set(r.key, secOf(r.expires_at) || nowSec() + 24 * 3600);
      else if (r.kind === "identity" && r.not_before) identityNotBefore.set(r.key, secOf(r.not_before));
    }
    log.info("revocations.loaded", { jtis: revokedJtis.size, identities: identityNotBefore.size });
  } catch (err) {
    log.warn("revocations.load_failed", { err: err.message });
  }
}

// Periodically evict expired in-memory entries so the maps stay bounded.
const sweep = setInterval(() => {
  const now = nowSec();
  for (const [jti, exp] of revokedJtis) if (exp <= now) revokedJtis.delete(jti);
}, 60_000);
if (typeof sweep.unref === "function") sweep.unref();

async function persist(kind, key, { notBefore = null, expiresAt = null, createdBy = null, upsertNotBefore = false } = {}) {
  if (!db.enabled) return;
  try {
    await db.query(
      `INSERT INTO session_revocations (kind, key, not_before, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (kind, key) DO UPDATE SET
         not_before = ${upsertNotBefore ? "GREATEST(session_revocations.not_before, EXCLUDED.not_before)" : "session_revocations.not_before"},
         expires_at = EXCLUDED.expires_at`,
      [kind, key, notBefore, expiresAt, createdBy]
    );
  } catch (err) {
    log.warn("revocation.persist_failed", { kind, err: err.message });
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function secOf(ts) {
  return ts ? Math.floor(new Date(ts).getTime() / 1000) : 0;
}
function sessionTtlSec() {
  // Avoid a config import cycle; default to 8h if unset.
  return Number(process.env.SESSION_TTL_SEC) || 8 * 60 * 60;
}
