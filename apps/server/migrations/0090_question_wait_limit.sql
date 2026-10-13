-- How long a question may wait for its answer, set by the server admin. A question that outlives
-- its card (8 hours on iOS) keeps waiting in Relo as a quiet notification of the same decision.
ALTER TABLE server_settings ADD COLUMN max_question_seconds integer NOT NULL DEFAULT 604800
  CHECK (max_question_seconds BETWEEN 300 AND 2592000);
