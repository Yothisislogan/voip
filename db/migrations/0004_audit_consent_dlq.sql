-- 0004: audit log, consent/recording state, and a dead-letter queue.
-- Production-hardening tables + columns. Idempotent (IF NOT EXISTS throughout).

-- ── audit_log ───────────────────────────────────────────────────────
-- Who did what, when, from where. Append-only; never updated in place.
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_identity TEXT,                 -- session identity (or "system")
  actor_email    TEXT,
  actor_role     TEXT,
  action         TEXT NOT NULL,        -- e.g. auth.login, contact.update, message.send, contact.view
  entity_type    TEXT,                 -- contact | call | message | survey | ...
  entity_id      TEXT,
  ip             TEXT,
  request_id     TEXT,
  detail         JSONB                 -- action-specific context (redacted of secrets)
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_identity);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);

-- ── consent / recording state on calls ──────────────────────────────
-- recording_state:  none | recording | stopped | deleted
-- consent_state:    unknown | disclosed | granted | declined
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_state   TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_at      TIMESTAMPTZ;

-- Full history of consent/recording transitions (audit trail for two-party states).
CREATE TABLE IF NOT EXISTS consent_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  call_sid    TEXT,
  contact_id  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,           -- disclosure | consent | recording | deletion
  state       TEXT NOT NULL,           -- disclosed | granted | declined | recording | stopped | deleted
  method      TEXT,                    -- ivr_disclosure | verbal | dtmf | api
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS idx_consent_call ON consent_events (call_sid);
CREATE INDEX IF NOT EXISTS idx_consent_contact ON consent_events (contact_id);

-- ── failed_jobs (dead-letter queue) ─────────────────────────────────
-- Async AI/webhook work that threw. Retryable via scripts/retry-jobs.js.
CREATE TABLE IF NOT EXISTS failed_jobs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL,         -- onUtterance | onCallComplete | handleInbound | screenPop | ...
  payload       JSONB NOT NULL,        -- enough to re-run the job
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 1,
  max_attempts  INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ            -- set when a retry succeeds (or manually cleared)
);
CREATE INDEX IF NOT EXISTS idx_failed_pending
  ON failed_jobs (next_retry_at)
  WHERE resolved_at IS NULL;
