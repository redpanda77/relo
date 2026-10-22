-- Add a computer: the owner can ask for Relo for Mac (the notch app) on the new computer too. Redeeming such a code
-- also hands the computer a one-time sign-in code for the Mac app (mobile_sign_in_codes), so it opens signed in.
ALTER TABLE computer_invites ADD COLUMN setup_mac_app boolean NOT NULL DEFAULT false;
