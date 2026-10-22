import type { Hono } from "hono";
import { FACTS,isPublicOrigin } from "@relo/notification-contracts";
import { contentPolicy } from "./content-policy.js";
import type { Database } from "./db.js";

const CURRENT_SCHEMA = "0130_computer_invite_mac_app.sql";
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
  input: {
    releaseIdentity?: string | undefined; mode: ApnsMode; configured: boolean; pollMs: number;
    /** The content window this worker deletes by (RELO_CONTENT_RETENTION_HOURS); null keeps content. Read by the content policy. */
    retentionHours: number | null;
  },
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
      retentionHours: input.retentionHours,
    }],
  );
}

export async function readDoctorSnapshot(
  db: Database,
  input: { principalId: string; apnsMode: ApnsMode; now?: Date; releaseIdentity?: string | undefined; appUrl?: string | undefined },
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
  const [policy,unused] = await Promise.all([
    contentPolicy(db,input.principalId),
    unusedCredentials(db,input.principalId),
  ]);
  return {
    version: 1,
    ok: Object.values(checks).every((check) => check.ok),
    releaseIdentity: input.releaseIdentity ?? null,
    checks,
    /** The account's privacy promise as it stands (content-policy.ts): informational, never fails doctor. */
    content: {
      encryption: policy.encryption.mode,
      encryptionRequired: policy.encryption.required,
      retentionHours: policy.retentionHours,
      retentionKnown: policy.retentionKnown,
      /** Whether this server's own address is public (the shared origin rule): the CLI's strict default follows it. */
      publicOrigin: input.appUrl ? isPublicOrigin(input.appUrl) : null,
    },
    /** Credentials nobody used for FACTS.credentials.unusedDays (plan 10 B2): candidates to revoke. */
    unusedCredentials: unused,
  };
}

export function registerDoctorRoutes(app: Hono,db: Database,apnsMode: ApnsMode,appUrl?: string): void {
  app.get("/api/doctor", async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    return context.json(await readDoctorSnapshot(db,{
      principalId: auth.principalId,
      apnsMode,
      releaseIdentity: process.env.RELO_RELEASE_IDENTITY,
      appUrl,
    }));
  });
}

/** Logins, computers' hook credentials and services unused (or never used) for the facts' window, oldest first. */
async function unusedCredentials(db: Database,principalId: string) {
  const result = await db.query<{ kind: string; name: string; last_used_at: Date | null; created_at: Date }>(
    `SELECT kind,name,last_used_at,created_at FROM (
       SELECT 'login' AS kind,COALESCE(comp.display_name,k.label) AS name,k.last_used_at,k.created_at FROM principal_api_keys k
         LEFT JOIN computers comp ON comp.login_key_id=k.id
         WHERE k.principal_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
       UNION ALL SELECT 'harness',name,last_used_at,created_at FROM harness_credentials WHERE principal_id=$1 AND revoked_at IS NULL
       UNION ALL SELECT 'service',title,last_used_at,created_at FROM webhook_services
         WHERE principal_id=$1 AND revoked_at IS NULL AND system_purpose IS NULL
     ) c WHERE COALESCE(last_used_at,created_at) < now()-make_interval(days=>$2)
     ORDER BY COALESCE(last_used_at,created_at) LIMIT 50`,
    [principalId,FACTS.credentials.unusedDays],
  );
  return result.rows.map((row) => ({
    kind: row.kind,name: row.name,lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}
