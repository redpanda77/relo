-- E6.1: an account can require end-to-end encryption. With it on, the server refuses readable
-- notices, questions and card text from CLI keys; webhooks and server-made messages are unaffected
-- and stay labelled on the phone.
ALTER TABLE owner_principals ADD COLUMN require_end_to_end boolean NOT NULL DEFAULT false;
