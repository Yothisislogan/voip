CREATE TABLE IF NOT EXISTS conversations (
  provider_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  customer_ref TEXT,
  customer_phone TEXT,
  agent_identity TEXT NOT NULL,
  contact JSONB,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(provider_id),
  event_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  provider_sid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(conversation_id,created_at);
