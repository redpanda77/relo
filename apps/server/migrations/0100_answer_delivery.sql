-- 2.12 / 2.19: answer callbacks retry for about three days and may target private http:// hosts.
-- The private-callback policy lives in code (callback-destinations.ts); the row only needs a scheme.
ALTER TABLE interaction_callbacks DROP CONSTRAINT IF EXISTS interaction_callbacks_url_check;
ALTER TABLE interaction_callbacks ADD CONSTRAINT interaction_callbacks_url_check
  CHECK (char_length(url) <= 2048 AND url ~ '^https?://');
ALTER TABLE interaction_callbacks DROP CONSTRAINT IF EXISTS interaction_callbacks_attempts_check;
ALTER TABLE interaction_callbacks
  ADD CONSTRAINT interaction_callbacks_attempts_check CHECK (attempts BETWEEN 0 AND 10),
  ADD COLUMN give_up_at timestamptz,
  ADD COLUMN redelivered_count integer NOT NULL DEFAULT 0 CHECK (redelivered_count >= 0),
  ADD COLUMN redelivered_today integer NOT NULL DEFAULT 0 CHECK (redelivered_today >= 0),
  ADD COLUMN redeliver_window_start timestamptz;
