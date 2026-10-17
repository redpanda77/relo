-- A computer's identity key can carry the join code's binding (docs/ENCRYPTION-PROTOCOL.md, "Key binding"):
-- an HMAC the issuing device checks before it approves the computer. The server stores it and never verifies it.
ALTER TABLE client_identity_keys ADD COLUMN binding text CHECK (binding IS NULL OR binding ~ '^[A-Za-z0-9_-]{43}$');
