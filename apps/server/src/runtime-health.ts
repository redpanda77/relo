import type { Hono } from "hono";
import type { Database } from "./db.js";

const CURRENT_SCHEMA = "0083_require_end_to_end.sql";
const WORKER_STALE_AFTER_MS = 30_000;

type ApnsMode = "disabled" | "production" | "sandbox";

type RuntimeComponentRow = {
  release_identity: string | null;
  started_at: Date;
  last_heartbeat_at: Date;
  details: Record<string,unknown>;
};

export async function recordWorkerHeartbeat(
  db: Database,
  input: { releaseIdentity?: string | undefined; mode: ApnsMode; configured: boolean; pollMs: number },
): Promise<void> {
  await db.query(
    `INSERT INTO runtime_components(component,release_identity,details)
     VALUES ('worker',$1,$2)
     ON CONFLICT (component) DO UPDATE SET
       release_identity=EXCLUDED.release_identity,
       last_heartbeat_at=now(),
       details=EXCLUDED.details
     WHERE runtime_components.last_heartbeat_at <= now()-interval '10 seconds'
       OR runtime_components.release_identity IS DISTINCT FROM EXCLUDED.release_identity
       OR runtime_components.details IS DISTINCT FROM EXCLUDED.details`,
    [input.releaseIdentity ?? null, {
      mode: input.mode,
      configured: input.configured,
      pollMs: input.pollMs,
    }],
  );
}

export async function readDoctorSnapshot(
  db: Database,
  input: { principalId: string; apnsMode: ApnsMode; now?: Date; releaseIdentity?: string | undefined },
) {
  const [migration,worker,devices] = await Promise.all([
    db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ),
    db.query<RuntimeComponentRow>(
      "SELECT release_identity,started_at,last_heartbeat_at,details FROM runtime_components WHERE component='worker'",
    ),
    db.query<{ active: string; notifications: string; live_activities: string }>(
      `SELECT count(*)::text AS active,
         count(*) FILTER (WHERE notification_authorization='authorized')::text AS notifications,
         count(*) FILTER (WHERE live_activity_authorization='authorized')::text AS live_activities
       FROM devices WHERE principal_id=$1 AND revoked_at IS NULL`,
      [input.principalId],
    ),
  ]);
  const latestMigration = migration.rows[0]?.version ?? null;
  const workerRow = worker.rows[0];
  const heartbeatAt = workerRow?.last_heartbeat_at ? new Date(workerRow.last_heartbeat_at) : null;
  const heartbeatAgeMs = heartbeatAt
    ? Math.max(0,(input.now ?? new Date()).getTime()-heartbeatAt.getTime())
    : null;
  const heartbeatState = heartbeatAgeMs === null
    ? "missing"
    : heartbeatAgeMs > WORKER_STALE_AFTER_MS ? "stale" : "ready";
  const releaseMatches = (workerRow?.release_identity ?? null) === (input.releaseIdentity ?? null);
  const workerState = heartbeatState === "ready" && !releaseMatches ? "version_mismatch" : heartbeatState;
  const activeDevices = Number(devices.rows[0]?.active ?? 0);
  const notificationDevices = Number(devices.rows[0]?.notifications ?? 0);
  const liveActivityDevices = Number(devices.rows[0]?.live_activities ?? 0);
  const workerDetails = workerRow?.details ?? {};
  const apnsState = input.apnsMode === "disabled"
    ? "disabled"
    : workerState === "ready" && workerDetails.configured === true
      && workerDetails.mode === input.apnsMode
      ? "configured" : "invalid";
  const checks = {
    database: {
      ok: latestMigration === CURRENT_SCHEMA,
      currentMigration: latestMigration,
      expectedMigration: CURRENT_SCHEMA,
    },
    worker: {
      ok: workerState === "ready",
      state: workerState,
      releaseIdentity: workerRow?.release_identity ?? null,
      lastHeartbeatAt: heartbeatAt?.toISOString() ?? null,
      heartbeatAgeMs,
    },
    apns: {
      ok: apnsState !== "invalid",
      state: apnsState,
      mode: input.apnsMode,
    },
    devices: {
      ok: activeDevices > 0 && notificationDevices > 0,
      active: activeDevices,
      notificationAuthorized: notificationDevices,
      liveActivityAuthorized: liveActivityDevices,
    },
  };
  return {
    version: 1,
    ok: Object.values(checks).every((check) => check.ok),
    releaseIdentity: input.releaseIdentity ?? null,
    checks,
  };
}

export function registerDoctorRoutes(app: Hono,db: Database,apnsMode: ApnsMode): void {
  app.get("/api/doctor", async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    return context.json(await readDoctorSnapshot(db,{
      principalId: auth.principalId,
      apnsMode,
      releaseIdentity: process.env.RELO_RELEASE_IDENTITY,
    }));
  });
}
