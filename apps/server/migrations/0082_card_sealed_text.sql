-- E5: a sealed card keeps its latest end-to-end envelopes, so updates the server makes itself
-- (an answer settling, expiry, a session ending) still carry the card's text to the phone.
ALTER TABLE live_activities ADD COLUMN sealed jsonb;
