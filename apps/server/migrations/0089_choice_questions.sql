-- Choice questions (docs/CHOICE-QUESTIONS.md): 2-4 labeled options, answered with one.
ALTER TYPE interaction_request_kind ADD VALUE IF NOT EXISTS 'choice';
ALTER TYPE interaction_kind ADD VALUE IF NOT EXISTS 'choose';

ALTER TABLE interaction_requests ADD COLUMN options jsonb
  CHECK (options IS NULL OR (jsonb_typeof(options)='array' AND jsonb_array_length(options) BETWEEN 2 AND 4));

-- What a phone's Relo build can show. Builds that predate this send nothing and never receive a
-- choice question, which they cannot decode.
ALTER TABLE devices ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
  CHECK (capabilities <@ ARRAY['choice_questions']::text[]);
