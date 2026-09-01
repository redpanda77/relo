import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuthIdentity } from "./auth.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";

const resourceCursorSchema = z.tuple([
  z.literal("context-resources-v1"),
  z.iso.datetime(),
  z.iso.datetime(),
  z.uuid(),
]);

type ResourceCursor = {
  snapshotAt: string;
  firstSeenAt: string;
  id: string;
};

function resourceId(prefix: "src" | "prj" | "cnv" | "wrk" | "gen" | "rel" | "cor", id: string): string {
  return `${prefix}_${id}`;
}

function internalResourceId(prefix: "src" | "prj" | "cnv" | "wrk", value: string | undefined): string | null {
  if (!value?.startsWith(`${prefix}_`)) return null;
  const parsed = z.uuid().safeParse(value.slice(4));
  return parsed.success ? parsed.data : null;
}

function encodeResourceCursor(snapshotAt: string, firstSeenAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify(["context-resources-v1",snapshotAt,firstSeenAt,id]),
    "utf8",
  ).toString("base64url");
}

function decodeResourceCursor(value: string | undefined): ResourceCursor | null {
  if (!value) return null;
  try {
    const parsed = resourceCursorSchema.safeParse(
      JSON.parse(Buffer.from(value,"base64url").toString("utf8")),
    );
    return parsed.success
      ? { snapshotAt: parsed.data[1], firstSeenAt: parsed.data[2], id: parsed.data[3] }
      : null;
  } catch {
    return null;
  }
}

function resourceLimit(context: Context): number | null {
  const raw = context.req.query("limit");
  if (raw === undefined) return 50;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function resourceReadGuard(): MiddlewareHandler {
  return async (context,next) => {
    const auth = context.get("auth") as AuthIdentity;
    const allowed = auth.credentialKind === "principal"
      ? auth.scopes.has("activities:read")
      : auth.scopes.has("inbox:read");
    if (!allowed) return context.json({ error: "forbidden" },403);
    await next();
  };
}

function pageBoundary(context: Context): {
  limit: number;
  snapshotAt: string;
  firstSeenAt: string | null;
  id: string | null;
} | Response {
  const limit = resourceLimit(context);
  if (limit === null) return context.json({ error: "invalid_limit" },400);
  const suppliedCursor = context.req.query("cursor");
  const cursor = decodeResourceCursor(suppliedCursor);
  if (suppliedCursor !== undefined && cursor === null) {
    return context.json({ error: "cursor_expired" },410);
  }
  return {
    limit,
    snapshotAt: cursor?.snapshotAt ?? new Date().toISOString(),
    firstSeenAt: cursor?.firstSeenAt ?? null,
    id: cursor?.id ?? null,
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function pageResult(
  rows: Record<string, any>[],
  page: { limit: number; snapshotAt: string },
  map: (row: Record<string, any>) => unknown,
) {
  const hasMore = rows.length > page.limit;
  const visible = rows.slice(0,page.limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    cursor: hasMore && last
      ? encodeResourceCursor(page.snapshotAt,iso(last.first_seen_at),String(last.id))
      : null,
    hasMore,
    snapshotAt: page.snapshotAt,
  };
}

const visibleNotificationSql = (resourceColumn: string, alias: string) => `EXISTS (
  SELECT 1 FROM notification_events event
  WHERE event.principal_id=$1 AND event.${resourceColumn}=${alias}.id
    AND ($6::uuid IS NULL OR event.target_mode='broadcast' OR EXISTS (
      SELECT 1 FROM notification_event_targets target
      WHERE target.notification_event_id=event.id AND target.device_id=$6
    ))
)`;

const visibleActivitySql = (resourceColumn: string, alias: string) => `EXISTS (
  SELECT 1 FROM live_activities activity
  WHERE activity.principal_id=$1 AND activity.${resourceColumn}=${alias}.id
    AND ($6::uuid IS NULL OR activity.target_device_ids IS NULL OR $6=ANY(activity.target_device_ids))
)`;

function pageValues(
  auth: AuthIdentity,
  page: { snapshotAt: string; firstSeenAt: string | null; id: string | null; limit: number },
): unknown[] {
  return [auth.principalId,page.snapshotAt,page.firstSeenAt,page.id,page.limit+1,auth.deviceId ?? null];
}

export function registerContextResourceRoutes(app: Hono, db: Database): void {
  const guard = resourceReadGuard();

  app.get("/api/resources/sources",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const auth = context.get("auth");
    const result = await db.query<any>(
      `SELECT source.* FROM resource_sources source
       WHERE source.principal_id=$1 AND source.deleted_at IS NULL
         AND source.first_seen_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (source.first_seen_at,source.id)<($3::timestamptz,$4::uuid))
         AND (${visibleNotificationSql("source_resource_id","source")}
           OR ${visibleActivitySql("source_resource_id","source")})
       ORDER BY source.first_seen_at DESC,source.id DESC LIMIT $5`,
      pageValues(auth,page),
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("src",row.id),
      kind: row.kind,
      name: row.display_name,
      provenance: row.provenance,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    })));
  });

  app.get("/api/resources/projects",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const auth = context.get("auth");
    const result = await db.query<any>(
      `SELECT project.* FROM resource_projects project
       WHERE project.principal_id=$1 AND project.deleted_at IS NULL
         AND project.merged_into_project_id IS NULL
         AND project.first_seen_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (project.first_seen_at,project.id)<($3::timestamptz,$4::uuid))
         AND (${visibleNotificationSql("project_resource_id","project")}
           OR ${visibleActivitySql("project_resource_id","project")})
       ORDER BY project.first_seen_at DESC,project.id DESC LIMIT $5`,
      pageValues(auth,page),
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("prj",row.id),
      name: row.display_name,
      isDirect: Boolean(row.is_direct),
      provenance: row.provenance,
      palette: {
        slot: Number(row.palette_ordinal)%12,
        generation: Math.floor(Number(row.palette_ordinal)/12),
      },
      icon: row.icon,
      revision: Number(row.revision),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    })));
  });

  app.get("/api/resources/conversations",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const sourceIdParam = context.req.query("sourceId");
    const projectIdParam = context.req.query("projectId");
    const sourceId = sourceIdParam === undefined ? null : internalResourceId("src",sourceIdParam);
    const projectId = projectIdParam === undefined ? null : internalResourceId("prj",projectIdParam);
    if ((sourceIdParam !== undefined && !sourceId) || (projectIdParam !== undefined && !projectId)) {
      return context.json({ error: "invalid_resource_filter" },400);
    }
    const auth = context.get("auth");
    const values = [...pageValues(auth,page),sourceId,projectId];
    const result = await db.query<any>(
      `SELECT conversation.* FROM activity_conversations conversation
       WHERE conversation.principal_id=$1
         AND conversation.first_seen_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (conversation.first_seen_at,conversation.id)<($3::timestamptz,$4::uuid))
         AND ($7::uuid IS NULL OR conversation.source_resource_id=$7)
         AND ($8::uuid IS NULL OR conversation.project_resource_id=$8)
         AND (${visibleNotificationSql("conversation_id","conversation")}
           OR ${visibleActivitySql("conversation_id","conversation")})
       ORDER BY conversation.first_seen_at DESC,conversation.id DESC LIMIT $5`,
      values,
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("cnv",row.id),
      sourceId: row.source_resource_id ? resourceId("src",row.source_resource_id) : null,
      projectId: row.project_resource_id ? resourceId("prj",row.project_resource_id) : null,
      name: row.display_name ?? null,
      producerKind: row.producer_kind,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    })));
  });

  app.get("/api/resources/work-items",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const conversationIdParam = context.req.query("conversationId");
    const conversationId = conversationIdParam === undefined
      ? null
      : internalResourceId("cnv",conversationIdParam);
    if (conversationIdParam !== undefined && !conversationId) {
      return context.json({ error: "invalid_resource_filter" },400);
    }
    const auth = context.get("auth");
    const values = [...pageValues(auth,page),conversationId];
    const result = await db.query<any>(
      `SELECT work.* FROM activity_work_items work
       WHERE work.principal_id=$1
         AND work.first_seen_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (work.first_seen_at,work.id)<($3::timestamptz,$4::uuid))
         AND ($7::uuid IS NULL OR work.conversation_id=$7)
         AND (${visibleNotificationSql("work_item_id","work")}
           OR ${visibleActivitySql("work_item_id","work")})
       ORDER BY work.first_seen_at DESC,work.id DESC LIMIT $5`,
      values,
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("wrk",row.id),
      conversationId: resourceId("cnv",row.conversation_id),
      title: row.title ?? null,
      lifecycle: row.lifecycle_provider && row.lifecycle_run_id
        ? { provider: row.lifecycle_provider, runId: row.lifecycle_run_id }
        : null,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    })));
  });

  app.get("/api/resources/generations",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const conversationIdParam = context.req.query("conversationId");
    const workItemIdParam = context.req.query("workItemId");
    const conversationId = conversationIdParam === undefined ? null : internalResourceId("cnv",conversationIdParam);
    const workItemId = workItemIdParam === undefined ? null : internalResourceId("wrk",workItemIdParam);
    if ((conversationIdParam !== undefined && !conversationId) || (workItemIdParam !== undefined && !workItemId)) {
      return context.json({ error: "invalid_resource_filter" },400);
    }
    const auth = context.get("auth");
    const values = [...pageValues(auth,page),conversationId,workItemId];
    const result = await db.query<any>(
      `SELECT activity.id,activity.conversation_id,activity.work_item_id,activity.generation,
          activity.sequence,activity.state,activity.created_at AS first_seen_at,activity.updated_at,
          activity.ended_at
       FROM live_activities activity
       WHERE activity.principal_id=$1 AND activity.created_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (activity.created_at,activity.id)<($3::timestamptz,$4::uuid))
         AND ($7::uuid IS NULL OR activity.conversation_id=$7)
         AND ($8::uuid IS NULL OR activity.work_item_id=$8)
         AND ($6::uuid IS NULL OR activity.target_device_ids IS NULL OR $6=ANY(activity.target_device_ids))
       ORDER BY activity.created_at DESC,activity.id DESC LIMIT $5`,
      values,
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("gen",row.id),
      activityId: resourceId("gen",row.id).replace(/^gen_/,"act_"),
      conversationId: row.conversation_id ? resourceId("cnv",row.conversation_id) : null,
      workItemId: row.work_item_id ? resourceId("wrk",row.work_item_id) : null,
      generation: Number(row.generation),
      sequence: Number(row.sequence),
      state: row.state,
      createdAt: iso(row.first_seen_at),
      updatedAt: iso(row.updated_at),
      endedAt: row.ended_at ? iso(row.ended_at) : null,
    })));
  });

  app.get("/api/resources/activity-relationships",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const activityIdParam = context.req.query("activityId");
    const conversationIdParam = context.req.query("conversationId");
    const activityId = activityIdParam === undefined ? null : internalId("act",activityIdParam);
    const conversationId = conversationIdParam === undefined
      ? null
      : internalResourceId("cnv",conversationIdParam);
    if ((activityIdParam !== undefined && !activityId)
      || (conversationIdParam !== undefined && !conversationId)) {
      return context.json({ error: "invalid_resource_filter" },400);
    }
    const auth = context.get("auth");
    const values = [...pageValues(auth,page),activityId,conversationId];
    const result = await db.query<any>(
      `SELECT relationship.id,relationship.kind,relationship.actor,relationship.reason,
          relationship.provenance,relationship.created_at AS first_seen_at,
          predecessor.id predecessor_id,predecessor.generation predecessor_generation,
          predecessor.state predecessor_state,predecessor.conversation_id predecessor_conversation_id,
          predecessor.work_item_id predecessor_work_item_id,
          successor.id successor_id,successor.generation successor_generation,
          successor.state successor_state,successor.conversation_id successor_conversation_id,
          successor.work_item_id successor_work_item_id
       FROM activity_relationships relationship
       JOIN live_activities predecessor ON predecessor.id=relationship.predecessor_activity_id
         AND predecessor.principal_id=relationship.principal_id
       JOIN live_activities successor ON successor.id=relationship.successor_activity_id
         AND successor.principal_id=relationship.principal_id
       WHERE relationship.principal_id=$1 AND relationship.created_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (relationship.created_at,relationship.id)<($3::timestamptz,$4::uuid))
         AND ($7::uuid IS NULL OR predecessor.id=$7 OR successor.id=$7)
         AND ($8::uuid IS NULL OR predecessor.conversation_id=$8 OR successor.conversation_id=$8)
         AND ($6::uuid IS NULL OR (
           (predecessor.target_device_ids IS NULL OR $6=ANY(predecessor.target_device_ids))
           AND (successor.target_device_ids IS NULL OR $6=ANY(successor.target_device_ids))
         ))
       ORDER BY relationship.created_at DESC,relationship.id DESC LIMIT $5`,
      values,
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("rel",row.id),
      kind: row.kind,
      predecessor: {
        activityId: publicId("act",row.predecessor_id),
        generation: Number(row.predecessor_generation),
        state: row.predecessor_state,
        conversationId: row.predecessor_conversation_id
          ? resourceId("cnv",row.predecessor_conversation_id) : null,
        workItemId: row.predecessor_work_item_id
          ? resourceId("wrk",row.predecessor_work_item_id) : null,
      },
      successor: {
        activityId: publicId("act",row.successor_id),
        generation: Number(row.successor_generation),
        state: row.successor_state,
        conversationId: row.successor_conversation_id
          ? resourceId("cnv",row.successor_conversation_id) : null,
        workItemId: row.successor_work_item_id
          ? resourceId("wrk",row.successor_work_item_id) : null,
      },
      actor: row.actor,
      reason: row.reason,
      provenance: row.provenance,
      createdAt: iso(row.first_seen_at),
    })));
  });

  app.get("/api/resources/correlation-decisions",guard,async (context) => {
    const page = pageBoundary(context);
    if (page instanceof Response) return page;
    const activityIdParam = context.req.query("activityId");
    const conversationIdParam = context.req.query("conversationId");
    const activityId = activityIdParam === undefined ? null : internalId("act",activityIdParam);
    const conversationId = conversationIdParam === undefined
      ? null
      : internalResourceId("cnv",conversationIdParam);
    if ((activityIdParam !== undefined && !activityId)
      || (conversationIdParam !== undefined && !conversationId)) {
      return context.json({ error: "invalid_resource_filter" },400);
    }
    const auth = context.get("auth");
    const values = [...pageValues(auth,page),activityId,conversationId];
    const result = await db.query<any>(
      `SELECT decision.id,decision.activity_id,decision.relationship_id,decision.outcome,
          decision.matched_by,decision.actor,decision.reason,decision.provenance,
          decision.created_at AS first_seen_at,activity.generation,activity.state,
          activity.conversation_id,activity.work_item_id
       FROM activity_correlation_decisions decision
       LEFT JOIN live_activities activity ON activity.id=decision.activity_id
         AND activity.principal_id=decision.principal_id
       WHERE decision.principal_id=$1 AND decision.created_at<=$2::timestamptz
         AND ($3::timestamptz IS NULL OR (decision.created_at,decision.id)<($3::timestamptz,$4::uuid))
         AND ($7::uuid IS NULL OR activity.id=$7)
         AND ($8::uuid IS NULL OR activity.conversation_id=$8)
         AND ($6::uuid IS NULL OR (activity.id IS NOT NULL
           AND (activity.target_device_ids IS NULL OR $6=ANY(activity.target_device_ids))))
       ORDER BY decision.created_at DESC,decision.id DESC LIMIT $5`,
      values,
    );
    return context.json(pageResult(result.rows,page,(row) => ({
      id: resourceId("cor",row.id),
      activity: row.activity_id ? {
        activityId: publicId("act",row.activity_id),
        generation: Number(row.generation),
        state: row.state,
        conversationId: row.conversation_id ? resourceId("cnv",row.conversation_id) : null,
        workItemId: row.work_item_id ? resourceId("wrk",row.work_item_id) : null,
      } : null,
      relationshipId: row.relationship_id ? resourceId("rel",row.relationship_id) : null,
      outcome: row.outcome,
      matchedBy: row.matched_by,
      actor: row.actor,
      reason: row.reason,
      provenance: row.provenance,
      createdAt: iso(row.first_seen_at),
    })));
  });
}

export const contextResourceInternals = {
  decodeResourceCursor,
  encodeResourceCursor,
  internalResourceId,
};
