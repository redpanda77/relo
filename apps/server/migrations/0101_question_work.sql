-- Questions reference work, never own it (spec 7, 2.13): a question asked in an agent session
-- attaches to the session's open work by work id, whether or not a phone holds the work's card.
ALTER TABLE interaction_requests ADD COLUMN work_id uuid REFERENCES works(id) ON DELETE SET NULL;
CREATE INDEX interaction_requests_work_idx ON interaction_requests (work_id, created_at DESC) WHERE work_id IS NOT NULL;
