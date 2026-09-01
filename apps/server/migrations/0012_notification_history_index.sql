CREATE INDEX notification_events_history_idx
  ON notification_events (principal_id, created_at DESC, id DESC)
  INCLUDE (target_mode);
