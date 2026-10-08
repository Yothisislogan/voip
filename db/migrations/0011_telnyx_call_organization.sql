-- Keep the historical twilio_call_sid column as the stable application key:
-- existing URLs, transcripts and CRM references must continue to resolve.
ALTER TABLE calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio';
ALTER TABLE calls ADD COLUMN provider_session_id TEXT;
ALTER TABLE calls ADD COLUMN provider_state JSONB NOT NULL DEFAULT '{}';
ALTER TABLE calls ADD COLUMN assigned_to TEXT;
ALTER TABLE calls ADD COLUMN assignment_explicit BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE calls ADD COLUMN organization_version INTEGER NOT NULL DEFAULT 0;
UPDATE calls SET assigned_to=agent_identity;
CREATE INDEX idx_calls_assigned ON calls(assigned_to,created_at DESC);
CREATE INDEX idx_calls_tags ON calls USING gin(tags);
CREATE UNIQUE INDEX idx_calls_provider_session ON calls(provider,provider_session_id) WHERE provider_session_id IS NOT NULL;
ALTER TABLE call_legs ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio';
ALTER TABLE call_legs ADD COLUMN control_id TEXT;
ALTER TABLE call_legs ADD COLUMN purpose TEXT;
ALTER TABLE call_legs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_call_legs_control ON call_legs(control_id) WHERE control_id IS NOT NULL;
ALTER TABLE call_recordings ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio';
CREATE TABLE telnyx_commands (
  command_key TEXT PRIMARY KEY,
  command_id UUID NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attempting','accepted','uncertain')),
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
