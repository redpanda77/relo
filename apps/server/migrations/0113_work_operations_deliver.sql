-- Deliver (the working layer): a round's close is an idempotent session write like finish.
ALTER TABLE work_operations DROP CONSTRAINT IF EXISTS work_operations_operation_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_operation_check
  CHECK (operation IN ('update','pause','resume','finish','deliver','heartbeat','question','notice'));
