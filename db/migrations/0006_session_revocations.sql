-- 0006: session revocation registry.
-- Two revocation kinds, both keyed by a text value:
--   'jti'      key = a specific token id  -> that one session is dead (logout)
--   'identity' key = an agent identity    -> every session issued to that
--                                             identity BEFORE `not_before` is dead
--                                             (log out everywhere / compromise / offboarding)
-- Rows can be pruned once `expires_at` passes (the underlying JWTs have expired).
CREATE TABLE IF NOT EXISTS session_revocations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('jti','identity')),
  key         TEXT NOT NULL,
  not_before  TIMESTAMPTZ,                    -- for 'identity': revoke tokens issued before this
  expires_at  TIMESTAMPTZ,                    -- safe to prune after this
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_session_revocations_expiry ON session_revocations (expires_at);
