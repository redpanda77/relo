-- Answering from a linked browser (docs/END-TO-END-ENCRYPTION.md, "Answering from a linked browser"):
-- a browser a trusted phone linked answers a question with its own identity key's signature, like a
-- phone. Its evidence row names the browser instead of a phone; exactly one answerer per row. The
-- server only stores and relays the signature: computers decide whether a browser's answer counts.
ALTER TABLE interactions ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE interactions ADD COLUMN browser_id uuid REFERENCES linked_browsers(id) ON DELETE CASCADE;
ALTER TABLE interactions ADD CONSTRAINT interactions_one_answerer
  CHECK ((device_id IS NULL) <> (browser_id IS NULL));
-- A browser answers; it never records delivery receipts (received, opened) for a phone.
ALTER TABLE interactions ADD CONSTRAINT interactions_browser_answers_only
  CHECK (browser_id IS NULL OR kind IN ('approve','deny','yes','no','choose'));
