-- Durable call context, provider legs, work queue, routing and source identity.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_identity TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS customer_number TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS source_number TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS identity_state TEXT NOT NULL DEFAULT 'unmatched';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS identity_evidence JSONB NOT NULL DEFAULT '{}';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recap_state TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recap_fingerprint TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_stopped_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_voicemail BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS route_targets JSONB NOT NULL DEFAULT '[]';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS routing_decided_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS call_legs (
  sid TEXT PRIMARY KEY,
  call_sid TEXT NOT NULL,
  agent_identity TEXT,
  status TEXT,
  sequence_number INT NOT NULL DEFAULT -1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_legs_root ON call_legs(call_sid);

ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS provider_event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_provider_event
  ON transcript_segments(call_sid, provider_event_key) WHERE provider_event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  job_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_jobs_due ON service_jobs(run_after) WHERE state IN ('pending','running');

CREATE TABLE IF NOT EXISTS agent_presence (
  identity TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('available','busy','away','dnd','offline','wrapup')),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_until TIMESTAMPTZ,
  reserved_call_sid TEXT,
  last_offered_at TIMESTAMPTZ
);
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS idle_since TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS lead_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  customer_name TEXT,
  business_name TEXT,
  destination_number TEXT,
  agent_identity TEXT,
  provider_call_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  claimed_call_sid TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_signals_recent ON lead_signals(source, received_at DESC);

CREATE TABLE IF NOT EXISTS call_recordings (
  recording_sid TEXT PRIMARY KEY,
  call_sid TEXT NOT NULL,
  url TEXT,
  duration_seconds INT,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'call',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_call ON call_recordings(call_sid);

CREATE TABLE IF NOT EXISTS service_receipts (
  receipt_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
