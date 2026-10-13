import type { Hono } from "hono";
import { unclaimedLoginsVisible } from "../server-accounts.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
deliveryReconciliationActions,
DeliveryReconciliationError,
reconcileDeliveryJob,
} from "../delivery-reconciliation.js";
import { listAgentSessions } from "../agent-sessions.js";
import { internalId,publicId } from "../ids.js";
import { withdrawNotification } from "../notifications/commands.js";
import { getOwnerAccount } from "./owner-account.js";
import type { WebRouteContext } from "./route-context.js";

/** Dashboard inbox actions: reconcile deliveries, the live snapshot, read state and withdrawal. */
export function registerInboxActionRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,dashboardMutationAccount,accountMutationAccount } = shared;
  app.post("/api/dashboard/deliveries/:deliveryId/reconcile", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const deliveryJobId = internalId("job",context.req.param("deliveryId") ?? "");
    if (!deliveryJobId) return context.json({ error: "delivery_not_found" },404);
    const parsed = z.object({ action: z.enum(deliveryReconciliationActions) }).strict()
      .safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_reconciliation_action" },400);
    try {
      return context.json(await reconcileDeliveryJob(db,{
        principalId: account.principalId,deliveryJobId,action: parsed.data.action,
        actor: { kind: "dashboard" },
      }));
    } catch (error) {
      if (error instanceof DeliveryReconciliationError) {
        return context.json({ error: error.code },error.status);
      }
      throw error;
    }
  });

  app.get("/api/dashboard/snapshot", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const params = new URL(context.req.url).searchParams;
    const requestedIds = (name: string,prefix: "dev" | "key") => {
      const values = params.getAll(name);
      if (values.length > 50) return null;
      const ids = values.map((value) => internalId(prefix,value));
      return ids.some((value) => !value) ? null : ids as string[];
    };
    const deviceIds = requestedIds("deviceId","dev");
    const clientIds = requestedIds("clientId","key");
    if (!deviceIds || !clientIds) return context.json({ error: "invalid_snapshot_selection" },400);
    const [counts,devices,clients,sessions] = await Promise.all([
      db.query<any>(`SELECT
        (SELECT count(*)::int FROM notification_events WHERE principal_id=$1) AS notifications,
        (SELECT count(*)::int FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
          WHERE e.principal_id=$1) AS deliveries,
        (SELECT count(*)::int FROM device_authorizations WHERE status='pending' AND expires_at>now()
          AND ${unclaimedLoginsVisible}) AS approvals,
        (SELECT count(*)::int FROM devices WHERE principal_id=$1 AND revoked_at IS NULL) AS devices`,
      [account.principalId]),
      deviceIds.length ? db.query<any>(
        `SELECT id,last_seen_at FROM devices WHERE principal_id=$1 AND revoked_at IS NULL AND id=ANY($2::uuid[])`,
        [account.principalId,deviceIds],
      ) : Promise.resolve({ rows: [] }),
      clientIds.length ? db.query<any>(
        `SELECT id,last_used_at FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>now()) AND id=ANY($2::uuid[])`,
        [account.principalId,clientIds],
      ) : Promise.resolve({ rows: [] }),
      listAgentSessions(db,account.principalId),
    ]);
    context.header("cache-control","private, no-store");
    return context.json({
      revision: Date.now(), counts: counts.rows[0] ?? { notifications: 0,deliveries: 0,approvals: 0,devices: 0 },
      devices: devices.rows.map((row: any) => ({ id: publicId("dev",row.id),lastSeenAt: row.last_seen_at })),
      clients: clients.rows.map((row: any) => ({ id: publicId("key",row.id),lastUsedAt: row.last_used_at })),
      sessions,
    });
  });

  app.post("/api/dashboard/notifications/:notificationId/read", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const notificationId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!notificationId) return context.json({ error: "notification_not_found" },404);
    const result = await db.query<any>(
      `WITH target AS (
         SELECT id,read_at FROM notification_events WHERE id=$1 AND principal_id=$2
       ), updated AS (
         UPDATE notification_events SET read_at=now(),updated_at=updated_at
         WHERE id IN (SELECT id FROM target) AND read_at IS NULL RETURNING read_at
       )
       SELECT EXISTS(SELECT 1 FROM target) AS found,EXISTS(SELECT 1 FROM updated) AS changed,
         COALESCE((SELECT read_at FROM updated),(SELECT read_at FROM target)) AS read_at`,
      [notificationId,account.principalId],
    );
    if (!result.rows[0]?.found) return context.json({ error: "notification_not_found" },404);
    return context.json({ changed: Boolean(result.rows[0].changed),readAt: result.rows[0].read_at });
  });

  app.post("/api/dashboard/inbox/read", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const result = await db.query<any>(
      `WITH watermark AS (
         SELECT created_at,id FROM notification_events WHERE principal_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 1
       ), updated AS (
         UPDATE notification_events SET read_at=now(),updated_at=updated_at
         WHERE principal_id=$1 AND read_at IS NULL AND withdrawn_at IS NULL
           AND (NOT EXISTS (SELECT 1 FROM watermark)
             OR (created_at,id)<=(SELECT created_at,id FROM watermark))
         RETURNING id
       ) SELECT count(*)::int AS changed FROM updated`,
      [account.principalId],
    );
    return context.json({ changed: Number(result.rows[0]?.changed ?? 0) });
  });

  const withdrawAccountNotification = async (context: any) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const notificationId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!notificationId) return context.json({ error: "notification_not_found" },404);
    const result = await withdrawNotification(db,{ kind: "owner",principalId: account.principalId },{
      eventId: notificationId,idempotencyKey: `dashboard:${randomUUID()}`,
    });
    if (result.kind === "not_found") return context.json({ error: "notification_not_found" },404);
    return context.json({ state: "withdrawn",withdrawnAt: result.withdrawnAt,
      ...(!result.replayed ? { canceledDeliveries: result.canceledDeliveries } : {}),replayed: result.replayed });
  };
  app.post("/api/account/notifications/:notificationId/withdraw", withdrawAccountNotification);
}
