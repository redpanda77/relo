-- Answers on another copy of the same question (docs/END-TO-END-ENCRYPTION.md, "Answers on another
-- copy"). A question folded onto a card has one copy per phone, and a long one continues as a
-- notification of the same decision; the asker follows one copy. When another copy is answered,
-- every copy takes the decision, and this names the copy that was actually answered: its evidence
-- row says which phone answered, and the phone's signature covers that copy's ids. The server only
-- records it; the asking computer accepts it only for a sealed question, bound to the context it chose.
ALTER TABLE interaction_requests
  ADD COLUMN answered_on_request_id uuid REFERENCES interaction_requests(id) ON DELETE SET NULL;
ALTER TABLE interaction_requests ADD CONSTRAINT interaction_requests_answered_elsewhere
  CHECK (answered_on_request_id IS NULL OR answered_on_request_id <> id);
CREATE INDEX interaction_requests_answered_on_idx ON interaction_requests(answered_on_request_id)
  WHERE answered_on_request_id IS NOT NULL;
