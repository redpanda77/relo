-- A browser asks for approval on the phone (docs/ENCRYPTION-PROTOCOL.md, "Linking (approval on the iPhone)").
-- Declared by the browser; cleared when a phone links or declines it, or when the request is too old to show.
ALTER TABLE linked_browsers ADD COLUMN link_requested_at timestamptz;
