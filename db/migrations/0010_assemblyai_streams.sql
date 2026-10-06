ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_provider text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_state text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_error text;
