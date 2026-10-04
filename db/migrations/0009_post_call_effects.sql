-- An external non-idempotent effect gets one automatic attempt. A crash or
-- timeout remains visible as unknown, rather than blindly sending twice.
CREATE TABLE IF NOT EXISTS post_call_effects (
  effect_key TEXT PRIMARY KEY,
  call_sid TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attempting','done','unconfirmed')),
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
