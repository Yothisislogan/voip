-- 0005: Customer-facing case tracker smart links.
-- Public links are signed from the tracker id at runtime. The database stores a
-- random nonce hash for uniqueness/audit hygiene, but not a reusable raw token.

CREATE TABLE IF NOT EXISTS case_tracker_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  public_title TEXT NOT NULL DEFAULT 'Your insurance request',
  status TEXT NOT NULL DEFAULT 'request_received',
  public_note TEXT,
  show_agent_name BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_tracker_contact
  ON case_tracker_links (contact_id, is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_tracker_status
  ON case_tracker_links (status);
CREATE INDEX IF NOT EXISTS idx_case_tracker_active
  ON case_tracker_links (is_active, expires_at);

CREATE TABLE IF NOT EXISTS case_tracker_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracker_id BIGINT NOT NULL REFERENCES case_tracker_links(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  public_note TEXT,
  actor_identity TEXT,
  event_type TEXT NOT NULL DEFAULT 'status_update',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_tracker_events_tracker
  ON case_tracker_events (tracker_id, created_at DESC);
