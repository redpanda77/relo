-- GET /api/now read each card's newest event with a per-card scan of the account's events (EXPLAIN: 164 cards x a
-- sequential pass, plus JIT on the inflated cost). The loader now reads the visible cards' newest events in one pass;
-- this index serves that pass (and every other lookup of a card's events) in card order, whatever the table's size.
-- 0050's index is partial on current commands and so cannot serve it.
CREATE INDEX notification_events_card_events_idx ON notification_events (
  principal_id,
  (payload#>>'{liveActivity,activityId}'),
  created_at DESC,id DESC
) WHERE kind='live_activity';

-- "Opened" interactions answer a question's opened_at and a card's seen_at; no other kind is read there.
CREATE INDEX interactions_opened_idx ON interactions (principal_id,created_at DESC) WHERE kind='opened';
CREATE INDEX interactions_opened_request_idx ON interactions (interaction_request_id) WHERE kind='opened';
