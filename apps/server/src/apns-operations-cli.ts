import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import {
  ApnsOperationError,
  quarantineApnsBacklogForCutover,
  quarantineApnsBacklogForRollback,
  recountApnsBacklog,
} from "./apns-operations.js";

const config = loadConfig();
const command = process.argv[2];
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const cutoverValue = option("--cutover-at") ?? config.APNS_CUTOVER_AT;
const cutoverAt = cutoverValue ? new Date(cutoverValue) : undefined;
const generation = option("--generation") ?? config.APNS_CONFIGURATION_GENERATION;
const db = createDatabase(config.DATABASE_URL);

try {
  if (command === "recount") {
    console.log(JSON.stringify({ ok: true,report: await recountApnsBacklog(db,cutoverAt) }));
  } else if (command === "cutover" || command === "rollback") {
    if (config.APNS_MODE !== "disabled") throw new ApnsOperationError("apns_must_be_disabled");
    if (!cutoverAt) throw new ApnsOperationError("cutover_at_required");
    if (!generation) throw new ApnsOperationError("configuration_generation_required");
    const result = command === "cutover"
      ? await quarantineApnsBacklogForCutover(db,cutoverAt,generation)
      : await quarantineApnsBacklogForRollback(db,cutoverAt,generation);
    console.log(JSON.stringify({ ok: true,result }));
  } else {
    throw new ApnsOperationError("usage_recount_cutover_or_rollback");
  }
} catch (error) {
  const code = error instanceof ApnsOperationError ? error.code : "operation_failed";
  console.error(JSON.stringify({ ok: false,error: code }));
  process.exitCode = 1;
} finally {
  await db.end();
}
