import { describe,expect,test } from "vitest";
import {
  activityPresentationScopeKey,
  activityRelevanceScore,
  syncActivityPresentationLease,
} from "./activity-presentation-leases.js";

describe("activity presentation relevance",() => {
  test("scopes presentation first by thread, then project, then durable identity",() => {
    expect(activityPresentationScopeKey({
      id: "activity-1",context: { project: " Relo ",threadName: " Release Audit " },
    })).toBe("thread:relo:release audit");
    expect(activityPresentationScopeKey({
      id: "activity-2",context: { project: " Relo " },
    })).toBe("project:relo");
    expect(activityPresentationScopeKey({
      id: "activity-3",conversation_id: "conversation-3",
    })).toBe("conversation:conversation-3");
    expect(activityPresentationScopeKey({ id: "activity-4" })).toBe("activity:activity-4");
  });

  test("relevance is the derived owner state's table relevance, never status text",() => {
    expect(activityRelevanceScore({ state: "active",owner: { state: "needs_you" } },"update")).toBe(1);
    expect(activityRelevanceScore({ state: "active",owner: { state: "failed" } },"update")).toBe(0.9);
    expect(activityRelevanceScore({ state: "active",owner: { state: "working_quietly" } },"update")).toBe(0.5);
    expect(activityRelevanceScore({ state: "active",owner: { state: "stale" },status: "Needs attention" },"update")).toBe(0.3);
    expect(activityRelevanceScore({ state: "active",owner: { state: "paused" } },"update")).toBe(0);
    // Without an attached owner state: a question card is needs_you, anything else moving.
    expect(activityRelevanceScore({ state: "active",presentation: { behavior: { type: "approval" } } },"start")).toBe(1);
    expect(activityRelevanceScore({ state: "active",symbol: "warning",status: "Failed" },"update")).toBe(0.7);
  });

  test("terminal commands have no foreground relevance",() => {
    expect(activityRelevanceScore({ state: "ended",progress: 0.9 },"end")).toBe(0);
  });

  test("reports an active update as pending until its exact generation token exists",async () => {
    const calls: Array<{ text: string;values?: unknown[] }> = [];
    const query = async (text: string,values?: unknown[]) => {
      calls.push({ text,values });
      if (text.includes("SELECT state FROM live_activity_presentation_leases")) {
        return { rows: [{ state: "pending_token" }] };
      }
      if (text.includes("count(*)::int AS count")) return { rows: [{ count: 0 }] };
      return { rows: [] };
    };
    await expect(syncActivityPresentationLease({ query } as never,{
      principalId: "principal-1",deviceId: "device-1",operation: "update",
      activity: { id: "activity-1",generation: 4,sequence: 7,state: "active",progress: 0.4 },
    })).resolves.toMatchObject({ state: "pending_token",relevanceScore: 0.7 });
    expect(calls.find(({ text }) => text.includes("live_activity_update_tokens"))?.values)
      .toEqual(["activity-1","device-1",4]);
    expect(calls.some(({ text }) => text.includes("l.state NOT IN ('pending_token'"))).toBe(true);
  });

  test("selects one foreground activity per thread or project scope",async () => {
    const calls: Array<{ text: string;values?: unknown[] }> = [];
    const query = async (text: string,values?: unknown[]) => {
      calls.push({ text,values });
      if (text.includes("live_activity_update_tokens")) return { rows: [{ exists: 1 }] };
      if (text.includes("SELECT state FROM live_activity_presentation_leases")) {
        return { rows: [{ state: "foreground" }] };
      }
      if (text.includes("count(*)::int AS count")) return { rows: [{ count: 2 }] };
      return { rows: [] };
    };

    await expect(syncActivityPresentationLease({ query } as never,{
      principalId: "principal-1",deviceId: "device-1",operation: "update",
      activity: { id: "activity-1",generation: 4,sequence: 8,state: "active",progress: 0.4 },
    })).resolves.toMatchObject({ state: "foreground",otherActiveCount: 2 });

    const arbitration = calls.find(({ text }) => text.includes("ROW_NUMBER() OVER"))?.text ?? "";
    expect(arbitration).toContain("PARTITION BY l.scope_key");
    expect(arbitration).toContain("scope_rank=1");
    expect(arbitration).toContain("scope_relevance_policy");
    expect(arbitration).not.toContain("LIMIT 1");
  });

  test("marks an update for push-to-start recovery after a device dismissal",async () => {
    let stateReads = 0;
    const calls: Array<{ text: string;values?: unknown[] }> = [];
    const query = async (text: string,values?: unknown[]) => {
      calls.push({ text,values });
      if (text.includes("SELECT state FROM live_activity_presentation_leases")) {
        stateReads += 1;
        return { rows: [{ state: stateReads === 1 ? "not_presented" : "foreground" }] };
      }
      if (text.includes("live_activity_update_tokens")) return { rows: [] };
      if (text.includes("count(*)::int AS count")) return { rows: [{ count: 0 }] };
      return { rows: [] };
    };

    await expect(syncActivityPresentationLease({ query } as never,{
      principalId: "principal-1",deviceId: "device-1",operation: "update",
      activity: { id: "activity-1",generation: 4,sequence: 8,state: "active",progress: 0.4 },
    })).resolves.toMatchObject({ state: "foreground",restartRequired: true });
    const upsert = calls.find(({ text }) => text.includes("INSERT INTO live_activity_presentation_leases"));
    expect(upsert?.values).toContain("presentation_restart_pending");
  });
});
