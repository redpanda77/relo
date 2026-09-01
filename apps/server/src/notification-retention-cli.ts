import { createDatabase } from "./db.js";
import {
  executeNotificationRetentionBatch,
  executeContextResourceRetention,
  previewContextResourceRetention,
  previewNotificationRetention,
  type NotificationRetentionPolicy,
} from "./notification-retention.js";

const command = process.argv[2];
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const integerOption = (name: string, fallback: number): number => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_${name.slice(2).replaceAll("-","_")}`);
  return Number(raw);
};

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
const releaseIdentity = process.env.RELO_RELEASE_IDENTITY;
if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required for retention");
if (!releaseIdentity) throw new Error("RELO_RELEASE_IDENTITY is required for retention");

const ageDays = integerOption("--age-days",30);
const policy: NotificationRetentionPolicy = {
  cutoff: new Date(Date.now()-ageDays*86_400_000),
  maximumEventsPerPrincipal: integerOption("--maximum-events",250),
  batchSize: integerOption("--batch-size",500),
  tombstoneDays: integerOption("--tombstone-days",90),
  releaseIdentity,
};
const resourcePolicy = {
  cutoff: new Date(Date.now()-integerOption("--resource-tombstone-days",90)*86_400_000),
  batchSize: policy.batchSize,
  releaseIdentity,
};
const db = createDatabase(databaseUrl);

try {
  if (command === "preview") {
    console.log(JSON.stringify({
      ok: true,policy,resourcePolicy,
      preview: await previewNotificationRetention(db,policy),
      resourcePreview: await previewContextResourceRetention(db,resourcePolicy),
    }));
  } else if (command === "execute") {
    const batches = [];
    for (let index = 0; index < 10_000; index += 1) {
      const batch = await executeNotificationRetentionBatch(db,policy);
      batches.push(batch);
      if (batch.eventsPruned<policy.batchSize) break;
      if (index === 9_999) throw new Error("notification_retention_batch_limit_exceeded");
    }
    const resourceBatches = [];
    for (let index = 0; index < 10_000; index += 1) {
      const batch = await executeContextResourceRetention(db,resourcePolicy);
      resourceBatches.push(batch);
      if (batch.projectsPruned<resourcePolicy.batchSize) break;
      if (index === 9_999) throw new Error("context_resource_retention_batch_limit_exceeded");
    }
    console.log(JSON.stringify({
      ok: true,policy,
      result: {
        batches: batches.length,
        eventsPruned: batches.reduce((total,batch) => total+batch.eventsPruned,0),
        tombstonesExpired: batches.reduce((total,batch) => total+batch.tombstonesExpired,0),
        runIds: batches.map((batch) => batch.runId),
        resourceBatches: resourceBatches.length,
        projectAliasesPruned: resourceBatches.reduce((total,batch) => total+batch.aliasesPruned,0),
        projectsPruned: resourceBatches.reduce((total,batch) => total+batch.projectsPruned,0),
        resourceRunIds: resourceBatches.map((batch) => batch.runId),
      },
    }));
  } else {
    throw new Error("usage_preview_or_execute");
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,error: error instanceof Error ? error.message : "notification_retention_failed",
  }));
  process.exitCode = 1;
} finally {
  await db.end();
}
