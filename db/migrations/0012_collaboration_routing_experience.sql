-- Additive pilot features. Existing voice configuration and survey scores stay intact.
CREATE TABLE IF NOT EXISTS office_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  client_id UUID NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sender, client_id),
  CHECK (sender <> recipient)
);
CREATE INDEX IF NOT EXISTS idx_office_messages_pair ON office_messages(sender, recipient, id DESC);
CREATE INDEX IF NOT EXISTS idx_office_messages_inbox ON office_messages(recipient, id DESC);

CREATE TABLE IF NOT EXISTS caller_routing_tags (
  phone TEXT PRIMARY KEY,
  tags TEXT[] NOT NULL DEFAULT '{}',
  version INT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tag_routing_rules (
  tag TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  preferred_agent TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  ring_seconds INT NOT NULL DEFAULT 15 CHECK (ring_seconds BETWEEN 5 AND 45),
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS routing_plan JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS call_experience (
  call_sid TEXT PRIMARY KEY REFERENCES calls(twilio_call_sid) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('ready','insufficient','unavailable','disabled')),
  csat SMALLINT CHECK (csat BETWEEN 1 AND 5),
  recommendation SMALLINT CHECK (recommendation BETWEEN 0 AND 10),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  backend TEXT NOT NULL,
  model TEXT,
  rubric_version TEXT NOT NULL,
  transcript_fingerprint TEXT NOT NULL,
  partial_transcript BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state='ready' OR (csat IS NULL AND recommendation IS NULL))
);
