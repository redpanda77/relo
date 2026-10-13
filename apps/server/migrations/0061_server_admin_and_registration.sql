-- ADR 0004: one installation hosts several isolated accounts. The server admin manages accounts
-- (approval, access, deletion) without access to their data; registration is closed, approval or open.
ALTER TABLE account_identities
  ADD COLUMN server_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_at timestamptz;

-- Everyone who can sign in today is approved; the earliest owner identity administers the server.
UPDATE account_identities SET approved_at=created_at;
UPDATE account_identities SET server_admin=true
WHERE id=(SELECT id FROM account_identities WHERE role='owner' ORDER BY created_at,id LIMIT 1);

CREATE UNIQUE INDEX account_identities_one_server_admin_idx
  ON account_identities((true)) WHERE server_admin;

CREATE TABLE server_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  registration_mode text NOT NULL DEFAULT 'closed' CHECK (registration_mode IN ('closed','approval','open')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO server_settings DEFAULT VALUES;

GRANT SELECT,UPDATE ON server_settings TO relo_runtime;
REVOKE INSERT,DELETE,TRUNCATE ON server_settings FROM relo_runtime;

-- Account requests reach the admin as ordinary Relo approvals, sent by a built-in service on the
-- admin's account. The admin answers on the phone, in the app or in the Dashboard.
ALTER TABLE webhook_services ADD COLUMN system_purpose text CHECK (system_purpose IN ('account_requests'));
CREATE UNIQUE INDEX webhook_services_one_system_purpose_idx
  ON webhook_services(principal_id,system_purpose) WHERE system_purpose IS NOT NULL AND revoked_at IS NULL;

-- One decision can appear in several places (a notification that waits, a card that asks now).
-- Answering any member cancels the others in the same transaction.
ALTER TABLE interaction_requests ADD COLUMN decision_group_id uuid;
CREATE INDEX interaction_requests_decision_group_idx
  ON interaction_requests(decision_group_id) WHERE decision_group_id IS NOT NULL;

CREATE TABLE account_requests (
  subject text PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  decision_group_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Whichever surface records the answer (notification, app, card), the account follows it in the
-- same transaction: approve lets the person sign in, deny turns the account's access off.
CREATE FUNCTION apply_account_request_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text;
BEGIN
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('approved','denied') OR NEW.decision_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT subject INTO requester FROM account_requests WHERE decision_group_id=NEW.decision_group_id;
  IF requester IS NULL THEN RETURN NEW; END IF;
  IF NEW.state = 'approved' THEN
    UPDATE account_identities SET approved_at=coalesce(approved_at,now())
    WHERE subject=requester AND disabled_at IS NULL;
  ELSE
    UPDATE account_identities SET disabled_at=coalesce(disabled_at,now()) WHERE subject=requester;
    UPDATE owner_principals SET disabled_at=coalesce(disabled_at,now())
    WHERE id=(SELECT principal_id FROM account_identities WHERE subject=requester);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interaction_requests_account_request_decision
AFTER UPDATE OF state ON interaction_requests
FOR EACH ROW EXECUTE FUNCTION apply_account_request_decision();

GRANT SELECT,INSERT,UPDATE,DELETE ON account_requests TO relo_runtime;
