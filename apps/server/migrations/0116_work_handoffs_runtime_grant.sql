-- 0115 created work_handoffs without the runtime grant, so handoffs failed in production with
-- "permission denied for table work_handoffs". runtime-table-grants.test.ts now checks every table.
GRANT SELECT,INSERT,UPDATE,DELETE ON work_handoffs TO relo_runtime;
