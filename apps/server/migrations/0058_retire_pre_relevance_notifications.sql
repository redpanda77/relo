-- Every ordinary notification is admitted with a notification_relevance row. Rows written before
-- relevance admission existed are retired here so current-state reads need no metadata-free
-- fallback. Their old bounded windows (at most 15 minutes) have long elapsed; this only makes
-- that terminal state explicit. Live Activity events never carry relevance and are untouched.
WITH retired AS (
  SELECT e.id FROM notification_events e
  WHERE e.kind<>'live_activity'
    AND NOT EXISTS (SELECT 1 FROM notification_relevance nr WHERE nr.notification_event_id=e.id)
)
UPDATE interaction_requests r SET state='expired',responded_at=COALESCE(r.responded_at,clock_timestamp())
FROM retired WHERE r.notification_event_id=retired.id AND r.state='pending';

UPDATE notification_events e SET state='expired'
WHERE e.kind<>'live_activity' AND e.state='active'
  AND NOT EXISTS (SELECT 1 FROM notification_relevance nr WHERE nr.notification_event_id=e.id);
