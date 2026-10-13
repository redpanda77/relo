import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { registerContextResourceRoutes, contextResourceInternals } from "./context-resources.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const predecessorId = "55555555-5555-4555-8555-555555555555";
const successorId = "66666666-6666-4666-8666-666666666666";
const relationshipId = "77777777-7777-4777-8777-777777777777";
const decisionId = "88888888-8888-4888-8888-888888888888";
const firstSeenAt = new Date("2026-08-13T10:00:00.000Z");

function application(kind: "principal" | "device", query: ReturnType<typeof vi.fn>) {
  const app = new Hono();
  app.use("*",async (context,next) => {
    context.set("auth",{
      principalId,
      ...(kind === "device" ? { deviceId, deviceCredentialVersion: 1 } : { credentialId: sourceId }),
      scopes: new Set(kind === "device" ? ["inbox:read"] : ["activities:read"]),
      credentialKind: kind,
    });
    await next();
  });
  // First pages snapshot the database clock; answer that here so each test's mock sees only its query.
  const clockAware = async (sql: string, values?: unknown[]) => sql.startsWith("SELECT clock_timestamp()")
    ? { rows: [{ now: new Date() }] }
    : query(sql, values);
  registerContextResourceRoutes(app,{ query: clockAware } as never);
  return app;
}

describe("normalized context resource API",() => {
  test("returns stable safe project identities with persisted palette allocation",async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: projectId,
      display_name: "Relo notifications",
      is_direct: false,
      provenance: "explicit",
      palette_ordinal: 14,
      icon: "folder",
      revision: 1,
      first_seen_at: firstSeenAt,
      last_seen_at: firstSeenAt,
    }] }));
    const response = await application("principal",query).request("/api/resources/projects?limit=20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        id: `prj_${projectId}`,
        name: "Relo notifications",
        isDirect: false,
        provenance: "explicit",
        palette: { slot: 2, generation: 1 },
        icon: "folder",
        revision: 1,
        firstSeenAt: firstSeenAt.toISOString(),
        lastSeenAt: firstSeenAt.toISOString(),
      }],
      cursor: null,
      hasMore: false,
      snapshotAt: expect.any(String),
    });
    const [sql,values] = query.mock.calls[0]!;
    expect(sql).toContain("resource_projects");
    expect(sql).toContain("notification_event_targets");
    expect(values[5]).toBeNull();
  });

  test("binds device visibility to targeted events and activities",async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const response = await application("device",query).request("/api/resources/sources");
    expect(response.status).toBe(200);
    const [sql,values] = query.mock.calls[0]!;
    expect(sql).toContain("target.device_id=$6");
    expect(sql).toContain("$6=ANY(activity.target_device_ids)");
    expect(values[5]).toBe(deviceId);
  });

  test("rejects malformed filters and versioned cursors",async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = application("principal",query);
    expect((await app.request("/api/resources/conversations?sourceId=key_not-public")).status).toBe(400);
    expect((await app.request("/api/resources/projects?cursor=invalid")).status).toBe(410);
    expect(query).not.toHaveBeenCalled();
  });

  test("returns categorical relationship evidence without private correlation fields",async () => {
    const query = vi.fn(async () => ({ rows: [{
      id:relationshipId,kind:"continuation",actor:"cli",reason:"same_origin_generation",
      provenance:"runtime",first_seen_at:firstSeenAt,
      predecessor_id:predecessorId,predecessor_generation:1,predecessor_state:"ended",
      predecessor_conversation_id:null,predecessor_work_item_id:null,
      successor_id:successorId,successor_generation:2,successor_state:"active",
      successor_conversation_id:null,successor_work_item_id:null,
    }] }));
    const response = await application("principal",query).request(
      `/api/resources/activity-relationships?activityId=act_${successorId}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items[0]).toEqual({
      id:`rel_${relationshipId}`,kind:"continuation",
      predecessor:{ activityId:`act_${predecessorId}`,generation:1,state:"ended",conversationId:null,workItemId:null },
      successor:{ activityId:`act_${successorId}`,generation:2,state:"active",conversationId:null,workItemId:null },
      actor:"cli",reason:"same_origin_generation",provenance:"runtime",
      createdAt:firstSeenAt.toISOString(),
    });
    expect(JSON.stringify(body)).not.toMatch(/origin_hash|run_id|credential|context|prompt/iu);
    expect(query.mock.calls[0]![0]).toContain("predecessor.target_device_ids");
  });

  test("hides unbound ambiguity from device credentials",async () => {
    const query = vi.fn(async () => ({ rows: [{
      id:decisionId,activity_id:null,relationship_id:null,outcome:"blocked_ambiguous",
      matched_by:"current",actor:"cli",reason:"multiple_current_candidates",
      provenance:"runtime",first_seen_at:firstSeenAt,generation:null,state:null,
      conversation_id:null,work_item_id:null,
    }] }));
    const response = await application("device",query).request("/api/resources/correlation-decisions");
    expect(response.status).toBe(200);
    const [sql,values] = query.mock.calls[0]!;
    expect(sql).toContain("activity.id IS NOT NULL");
    expect(values[5]).toBe(deviceId);
  });

  test("rejects malformed relationship filters before querying",async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = application("principal",query);
    expect((await app.request("/api/resources/activity-relationships?activityId=act_invalid")).status).toBe(400);
    expect((await app.request("/api/resources/correlation-decisions?conversationId=cnv_invalid")).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  test("round-trips the immutable snapshot cursor",() => {
    const encoded = contextResourceInternals.encodeResourceCursor(
      "2026-08-13T11:00:00.000Z",firstSeenAt.toISOString(),projectId,
    );
    expect(contextResourceInternals.decodeResourceCursor(encoded)).toEqual({
      snapshotAt: "2026-08-13T11:00:00.000Z",
      firstSeenAt: firstSeenAt.toISOString(),
      id: projectId,
    });
  });
});
