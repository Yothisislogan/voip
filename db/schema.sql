-- WIT Connect — Postgres CRM schema (operational store for the telephony app).
-- Idempotent: safe to run repeatedly (npm run migrate).

-- ── contacts / leads ────────────────────────────────────────────────
-- One row per person. Phone is the primary match key for calls/SMS.
CREATE TABLE IF NOT EXISTS contacts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_e164      TEXT UNIQUE,
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  company         TEXT,
  title           TEXT,
  lifecycle_stage TEXT NOT NULL DEFAULT 'lead',   -- lead | contact | customer | lost
  source          TEXT,                            -- call_inbound | call_outbound | sms | email | manual
  -- Insurance lead fields (filled by AI extraction).
  policy_type     TEXT,
  carrier         TEXT,
  premium         NUMERIC(12,2),
  policy_number   TEXT,
  effective_date  DATE,
  renewal_date    DATE,
  coverage_status TEXT,
  address         TEXT,
  notes           TEXT,
  last_contacted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (lower(email));

-- ── calls ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  twilio_call_sid  TEXT UNIQUE,
  contact_id       BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  direction        TEXT,                 -- inbound | outbound
  from_e164        TEXT,
  to_e164          TEXT,
  status           TEXT,
  queued_at        TIMESTAMPTZ DEFAULT now(),
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  duration_seconds INT,
  recording_url    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls (contact_id);

-- ── transcript_segments (persistent) ────────────────────────────────
CREATE TABLE IF NOT EXISTS transcript_segments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid    TEXT NOT NULL,
  contact_id  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  seq         INT NOT NULL,
  speaker     TEXT NOT NULL,             -- agent | customer
  text        TEXT NOT NULL,
  spoken_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_sid, seq)
);
CREATE INDEX IF NOT EXISTS idx_segments_call ON transcript_segments (call_sid);

-- ── call_scores ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_scores (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid   TEXT UNIQUE,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  score      INT,                         -- 0..100 lead/quality score
  sentiment  TEXT,                        -- positive | neutral | negative
  outcome    TEXT,
  factors    JSONB NOT NULL DEFAULT '[]', -- [{label, delta}]
  summary    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scores_contact ON call_scores (contact_id);

-- ── surveys (post-call SMS follow-up) ────────────────────────────────
CREATE TABLE IF NOT EXISTS surveys (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid        TEXT,
  contact_id      BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL DEFAULT 'sms',
  conversation_id TEXT,                   -- messaging conversation the survey rides
  question        TEXT,
  status          TEXT NOT NULL DEFAULT 'sent', -- sent | responded | failed
  rating          INT,                    -- 1..5 parsed from the reply
  response_text   TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_surveys_contact ON surveys (contact_id);
CREATE INDEX IF NOT EXISTS idx_surveys_open ON surveys (contact_id, status) WHERE status = 'sent';

-- ── email_intake (parsed inbound emails -> leads) ───────────────────
CREATE TABLE IF NOT EXISTS email_intake (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  TEXT,
  from_email  TEXT,
  from_name   TEXT,
  subject     TEXT,
  body        TEXT,
  phone_e164  TEXT,
  contact_id  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  parsed      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_contact ON email_intake (contact_id);

-- ── updated_at trigger for contacts ─────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON contacts;
CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
