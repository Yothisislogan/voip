-- Old browser sessions remain ineligible for buying until they report registration.
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS phone_registered BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_calls_pending_agent ON calls(agent_identity)
  WHERE ended_at IS NULL AND status IN ('queued','ringing','in_progress');
