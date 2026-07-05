-- Richer insurance extraction fields on contacts.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dob            DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vin            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS drivers        JSONB NOT NULL DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vehicles       JSONB NOT NULL DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_name  TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_type  TEXT;
