import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { csrfProtect } from "../middleware/csrf.js";
import { audit, listAudit } from "../audit.js";
import { queueStats, listFailedJobs, resolveJob } from "../jobs/deadletter.js";
import { revokeIdentity } from "../auth/revocation.js";

/**
 * Admin console API — system status, the dead-letter queue, and the audit log.
 * Everything here is admin-only. Read routes are GET; the single mutation
 * (resolve a failed job) is CSRF-protected.
 */
export const adminRouter = Router();

adminRouter.use("/api/admin", requireAuth, requireRole("admin"), csrfProtect);

// ── System status ──
adminRouter.get("/api/admin/status", async (req, res) => {
  const twilioMissing = ["accountSid", "apiKeySid", "apiKeySecret", "twimlAppSid", "callerId"]
    .filter((k) => !config.twilio[k]);

  let dbUp = false;
  if (db.enabled) {
    try {
      await db.query("SELECT 1");
      dbUp = true;
    } catch {
      dbUp = false;
    }
  }

  const queue = await queueStats();
  const auditLast24h = await audit24h();
  const backups = latestBackup();

  res.json({
    now: new Date().toISOString(),
    publicBaseUrl: config.publicBaseUrl || null,
    auth: { required: config.auth.required, twoFactor: config.auth.twoFactor.enabled, devLogin: config.auth.devLoginEnabled },
    db: { enabled: db.enabled, up: dbUp },
    twilio: {
      configured: twilioMissing.length === 0,
      missing: twilioMissing,
      authTokenSet: Boolean(process.env.TWILIO_AUTH_TOKEN),
      callerId: config.twilio.callerId || null,
    },
    messaging: {
      enabled: config.messaging.enabled,
      provider: config.messaging.provider,
      configured: Boolean(config.messaging.conversationsServiceSid),
    },
    erpnext: { configured: Boolean(config.erpnext.baseUrl && config.erpnext.apiKey) },
    email: { enabled: config.emailIntake.enabled, tokenProtected: Boolean(config.emailIntake.token) },
    ai: {
      coachingBackend: config.llm.coachingBackend,
      recapBackend: config.llm.recapBackend,
      automationBackend: config.llm.automationBackend,
      groqConfigured: Boolean(config.llm.groq.apiKey),
    },
    queue,
    retention: config.retention,
    backups,
    audit: { last24h: auditLast24h },
  });
});

// ── Dead-letter queue ──
adminRouter.get("/api/admin/failed-jobs", async (req, res) => {
  const jobs = await listFailedJobs({ limit: req.query.limit, status: req.query.status || "pending" });
  res.json({ jobs });
});

adminRouter.post("/api/admin/failed-jobs/:id/resolve", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
  await resolveJob(id);
  audit({ req, action: "job.resolve", entityType: "failed_job", entityId: id });
  res.json({ ok: true });
});

// ── Session revocation (log an agent out everywhere) ──
// Offboarding / compromise response: kills every session issued to an identity
// so far. Combine with removing them from AGENT_DIRECTORY for a permanent block.
adminRouter.post("/api/admin/revoke-sessions", async (req, res) => {
  const identity = String(req.body?.identity || "").trim();
  if (!identity) return res.status(400).json({ error: "identity is required" });
  await revokeIdentity(identity, req.agent?.identity);
  audit({ req, action: "sessions.revoke", entityType: "identity", entityId: identity });
  res.json({ ok: true, identity });
});

// ── Audit log ──
adminRouter.get("/api/admin/audit", async (req, res) => {
  const entries = await listAudit({
    limit: req.query.limit,
    actor: req.query.actor,
    action: req.query.action,
    entityId: req.query.entityId,
  });
  res.json({ entries });
});

// ── helpers ──
async function audit24h() {
  if (!db.enabled) return null;
  try {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE at > now() - interval '24 hours'");
    return rows[0].n;
  } catch {
    return null;
  }
}

// The app can't see the cron scheduler, but it can inspect the backup directory
// to report the newest dump — a real signal that backups are actually running.
function latestBackup() {
  const dir = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^wit_.*\.sql\.gz$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, at: st.mtime.toISOString(), sizeBytes: st.size };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return { dir, count: files.length, latest: files[0] || null };
  } catch {
    return { dir, count: 0, latest: null };
  }
}
