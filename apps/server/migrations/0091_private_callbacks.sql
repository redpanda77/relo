-- Answer callbacks may reach private addresses (Relo is private-network first, ADR 0003) when the
-- server admin allows it: nobody, the admin's own account (default), or every account.
ALTER TABLE server_settings ADD COLUMN private_callbacks text NOT NULL DEFAULT 'admin'
  CHECK (private_callbacks IN ('none','admin','everyone'));
