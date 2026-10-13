import { expect, test } from "vitest";
import { readdirSync } from "node:fs";
import { readDoctorSnapshot, recordWorkerHeartbeat } from "./runtime-health.js";

// Use the actual packaged migration set so a new migration cannot leave both
// this fixture and the doctor's expected identity stale while tests stay green.
const latestMigration = readdirSync(new URL("../migrations/",import.meta.url))
  .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort().at(-1)!;

test("doctor keeps server, worker, APNs, and phone facts distinct", async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const db = {
    query: async (sql: string) => {
      if (sql.includes("schema_migrations")) return { rows: [{ version: latestMigration }] };
      if (sql.includes("runtime_components")) return { rows: [{
        release_identity: "0.7.23-test",
        started_at: new Date(now.getTime()-60_000),
        last_heartbeat_at: new Date(now.getTime()-5_000),
        details: { mode: "sandbox",configured: true,pollMs: 2_000 },
      }] };
      return { rows: [{ active: "1",notifications: "1",live_activities: "0" }] };
    },
  } as any;
  const snapshot = await readDoctorSnapshot(db,{
    principalId: "principal",apnsMode: "sandbox",now,releaseIdentity: "0.7.23-test",
  });
  expect(snapshot.ok).toBe(true);
  expect(snapshot.checks.database.expectedMigration).toBe(latestMigration);
  expect(snapshot.checks.apns.state).toBe("configured");
  expect(snapshot.checks.devices.notificationAuthorized).toBe(1);
  expect(snapshot.checks.devices.liveActivityAuthorized).toBe(0);
});

test("doctor reports a stale worker and missing phone independently", async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const db = {
    query: async (sql: string) => {
      if (sql.includes("schema_migrations")) return { rows: [{ version: latestMigration }] };
      if (sql.includes("runtime_components")) return { rows: [{
        release_identity: "old",started_at: now,
        last_heartbeat_at: new Date(now.getTime()-31_000),details: { configured: true },
      }] };
      return { rows: [{ active: "0",notifications: "0",live_activities: "0" }] };
    },
  } as any;
  const snapshot = await readDoctorSnapshot(db,{ principalId: "principal",apnsMode: "sandbox",now });
  expect(snapshot.ok).toBe(false);
  expect(snapshot.checks.worker.state).toBe("stale");
  expect(snapshot.checks.apns.state).toBe("invalid");
  expect(snapshot.checks.devices.ok).toBe(false);
});

test("doctor rejects a worker from another release or APNs mode", async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const db = {
    query: async (sql: string) => {
      if (sql.includes("schema_migrations")) return { rows: [{ version: latestMigration }] };
      if (sql.includes("runtime_components")) return { rows: [{
        release_identity: "0.7.19",started_at: now,last_heartbeat_at: now,
        details: { mode: "production",configured: true },
      }] };
      return { rows: [{ active: "1",notifications: "1",live_activities: "1" }] };
    },
  } as any;
  const snapshot = await readDoctorSnapshot(db,{
    principalId: "principal",apnsMode: "sandbox",now,releaseIdentity: "0.7.23",
  });
  expect(snapshot.ok).toBe(false);
  expect(snapshot.checks.worker.state).toBe("version_mismatch");
  expect(snapshot.checks.apns.state).toBe("invalid");
});

test("worker heartbeat stores only operational state", async () => {
  let values: unknown[] | undefined;
  const db = { query: async (_sql: string,input: unknown[]) => { values = input; } } as any;
  await recordWorkerHeartbeat(db,{
    releaseIdentity: "0.7.23-test",mode: "disabled",configured: false,pollMs: 2_000,
  });
  expect(values).toEqual(["0.7.23-test",{ mode: "disabled",configured: false,pollMs: 2_000 }]);
});

test("doctor fails clearly when the schema is behind",async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const db = {
    query: async (sql: string) => {
      if (sql.includes("schema_migrations")) return { rows: [{ version: "0000_old" }] };
      if (sql.includes("runtime_components")) return { rows: [{
        release_identity: "0.7.24",started_at: now,last_heartbeat_at: now,
        details: { mode: "sandbox",configured: true,pollMs: 2_000 },
      }] };
      return { rows: [{ active: "1",notifications: "1",live_activities: "1" }] };
    },
  } as any;
  const snapshot = await readDoctorSnapshot(db,{
    principalId: "principal",apnsMode: "sandbox",now,releaseIdentity: "0.7.24",
  });
  expect(snapshot.ok).toBe(false);
  expect(snapshot.checks.database).toMatchObject({ ok: false,currentMigration: "0000_old" });
});
