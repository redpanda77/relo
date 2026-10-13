-- End-to-end encryption is on by default: an account that has not chosen (NULL) requires sealed
-- content from CLI keys as soon as one of its phones has published encryption keys. true/false are
-- explicit choices; turning it off is the owner's decision at a terminal.
ALTER TABLE owner_principals ALTER COLUMN require_end_to_end DROP NOT NULL;
ALTER TABLE owner_principals ALTER COLUMN require_end_to_end SET DEFAULT NULL;
UPDATE owner_principals SET require_end_to_end=NULL WHERE require_end_to_end=false;
