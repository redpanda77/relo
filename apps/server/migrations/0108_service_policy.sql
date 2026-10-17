-- Webhook services become first-class producers (plan 10 A3, A4, B2).
-- readable_allowed: services cannot seal, so on an account that requires end-to-end encryption a service may send
--   readable content only when the owner allows it for that service. Existing services are allowed (nothing that
--   works today stops on deploy); new services start without it.
-- scopes: what the service may do (the hooks:* family of packages/contracts/src/scopes.ts). Existing and new
--   services get all four until the owner narrows them; scope-registry.test.ts compares this list with the registry.
-- last_used_at: written only by credentials/ (debounced), so unused services surface.
ALTER TABLE webhook_services ADD COLUMN readable_allowed boolean NOT NULL DEFAULT false;
UPDATE webhook_services SET readable_allowed=true;
ALTER TABLE webhook_services ADD COLUMN scopes text[] NOT NULL
  DEFAULT ARRAY['hooks:notify','hooks:cards','hooks:works','hooks:read']::text[]
  CHECK (scopes <@ ARRAY['hooks:notify','hooks:cards','hooks:works','hooks:read']::text[]);
ALTER TABLE webhook_services ADD COLUMN last_used_at timestamptz;
