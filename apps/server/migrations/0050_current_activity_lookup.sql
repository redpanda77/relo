-- Current summaries bind a native card to its exact generation and sequence.
-- EXPLAIN on 50 active cards plus 11,000 unrelated events previously scanned
-- the account's event history once per card. Keep this lookup proportional to
-- the visible current commands, without changing immutable delivery evidence.
CREATE INDEX notification_events_current_activity_idx ON notification_events (
  principal_id,
  (payload#>>'{liveActivity,activityId}'),
  (payload#>>'{liveActivity,generation}'),
  (payload#>>'{liveActivity,sequence}'),
  created_at DESC,id DESC
) WHERE kind='live_activity' AND state='active' AND withdrawn_at IS NULL;
