-- Persist the structured recap on the call for the call-detail view.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recap JSONB;
