-- An owner overview device (docs/CHOICE-QUESTIONS.md, "Device capabilities"): a Relo app that reads the
-- whole account's Now (the Mac's notch). It is never a delivery target; visibility for it is
-- account-level, like the Dashboard's.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_capabilities_check;
ALTER TABLE devices ADD CONSTRAINT devices_capabilities_check
  CHECK (capabilities <@ ARRAY['choice_questions','owner_overview']::text[]);
