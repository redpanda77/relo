import { endAllActiveActivities } from "./activity-commands/runtime.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

// Operator command: end every active Live Activity with an end push. Run it (inside the worker
// container) before any manual removal of activity rows; see the operations runbook.
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
try {
  const ended = await endAllActiveActivities(db,config.APNS_MODE);
  console.log(JSON.stringify({ ok: true,ended }));
} catch (error) {
  console.error(JSON.stringify({ ok: false,error: error instanceof Error ? error.message : "end_active_activities_failed" }));
  process.exitCode = 1;
} finally {
  await db.end();
}
