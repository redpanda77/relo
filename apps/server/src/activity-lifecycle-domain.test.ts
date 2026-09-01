import { describe, expect, test } from "vitest";
import {
  beginActivityTransaction,
  lifecycleMutationAllowed,
  resolveActivityByIdentifier,
  resolveActivityReplay,
  resolveActivitySelector,
  sameActivityTargets,
} from "./activity-lifecycle-domain.js";

function queryResult(rows: any[]) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string,values?: unknown[]) => {
      calls.push({ text,values });
      return { rows,rowCount: rows.length };
    },
  };
}

describe("activity lifecycle domain", () => {
  test("commits and releases an activity transaction exactly once", async () => {
    const commands: string[] = [];
    let releases = 0;
    const transaction = await beginActivityTransaction({
      connect: async () => ({
        query: async (text: string) => { commands.push(text); return { rows: [],rowCount: 0 }; },
        release: () => { releases += 1; },
      }),
    });
    await transaction.commit();
    await transaction.rollback();
    await transaction.close();
    await transaction.close();
    expect(commands).toEqual(["BEGIN","COMMIT"]);
    expect(releases).toBe(1);
  });

  test("rolls an unsettled activity transaction back before releasing it", async () => {
    const commands: string[] = [];
    let releases = 0;
    const transaction = await beginActivityTransaction({
      connect: async () => ({
        query: async (text: string) => { commands.push(text); return { rows: [],rowCount: 0 }; },
        release: () => { releases += 1; },
      }),
    });
    await transaction.close();
    expect(commands).toEqual(["BEGIN","ROLLBACK"]);
    expect(releases).toBe(1);
  });

  test("releases the client when beginning a transaction fails", async () => {
    let releases = 0;
    await expect(beginActivityTransaction({
      connect: async () => ({
        query: async () => { throw new Error("begin failed"); },
        release: () => { releases += 1; },
      }),
    })).rejects.toThrow("begin failed");
    expect(releases).toBe(1);
  });

  test("keeps lifecycle mutations bound to the exact provider run", () => {
    const row = { lifecycle_provider: "codex",lifecycle_run_id: "run-1" };
    expect(lifecycleMutationAllowed(row,undefined)).toBe(true);
    expect(lifecycleMutationAllowed(row,{ provider: "codex",runId: "run-1" })).toBe(true);
    expect(lifecycleMutationAllowed(row,{ provider: "codex",runId: "run-2" })).toBe(false);
    expect(lifecycleMutationAllowed({}, { provider: "codex",runId: "run-1" })).toBe(false);
  });

  test("compares target sets without depending on order", () => {
    expect(sameActivityTargets(["device-b","device-a"],["device-a","device-b"])).toBe(true);
    expect(sameActivityTargets(["device-a"],["device-a","device-b"])).toBe(false);
  });

  test("resolves a service activity through the shared owner-scoped identifier policy", async () => {
    const database = queryResult([{ id: "activity" }]);
    const activity = await resolveActivityByIdentifier(database,{
      principalId: "principal",credentialId: null,serviceId: "service",
    },"daily-build",true);
    expect(activity).toEqual({ id: "activity" });
    expect(database.calls[0]?.text).toContain("requester_service_id IS NOT DISTINCT FROM $3::uuid");
    expect(database.calls[0]?.text).toContain("FOR UPDATE");
    expect(database.calls[0]?.values).toEqual(["principal",null,"service","daily-build"]);
  });

  test("fails closed when current selection is ambiguous for a service", async () => {
    const database = queryResult([{ id: "newest" },{ id: "older" }]);
    const selection = await resolveActivitySelector(database,{
      principalId: "principal",credentialId: null,serviceId: "service",
    },{ current: true });
    expect(selection).toEqual({ ambiguous: true });
    expect(database.calls[0]?.values).toEqual(["principal",null,"service"]);
  });

  test("resolves the exact lifecycle for a credential owner", async () => {
    const database = queryResult([{ id: "activity" }]);
    const selection = await resolveActivitySelector(database,{
      principalId: "principal",credentialId: "credential",serviceId: null,
    },{ lifecycle: { provider: "codex",runId: "turn-1" } });
    expect(selection.activity).toEqual({ id: "activity" });
    expect(selection.ambiguous).toBe(false);
    expect(database.calls[0]?.values).toEqual(["principal","credential",null,"codex","turn-1"]);
  });

  test("replays an exact service operation through the shared owner policy", async () => {
    const database = queryResult([{
      operation: "update",request_hash: "hash",delivery_summary: { eligibleDevices: 1 },
      dismiss_after_seconds: null,activity_snapshot: { id: "activity" },
      requester_credential_id: null,requester_service_id: "service",
    }]);
    const replay = await resolveActivityReplay(database,{
      principalId: "principal",credentialId: null,serviceId: "service",
    },"request-1","update","hash",(delivery) => delivery);
    expect(replay).toEqual({
      conflict: false,snapshot: { id: "activity" },
      delivery: { eligibleDevices: 1 },dismissAfterSeconds: null,
    });
    expect(database.calls[0]?.text).toContain("o.requester_service_id=$2");
    expect(database.calls[0]?.values).toEqual(["principal","service","request-1"]);
  });

  test("keeps legacy credential replay rows fail-closed", async () => {
    const database = queryResult([{
      operation: "update",request_hash: "hash",delivery_summary: {},
      dismiss_after_seconds: null,activity_snapshot: { id: "legacy" },
      requester_credential_id: null,requester_service_id: null,
    }]);
    const replay = await resolveActivityReplay(database,{
      principalId: "principal",credentialId: "credential",serviceId: null,
    },"request-1","update","hash",() => {
      throw new Error("conflicting replay must not parse delivery");
    });
    expect(replay).toEqual({ conflict: true });
    expect(database.calls[0]?.text).toContain("o.requester_credential_id=$2 OR o.requester_credential_id IS NULL");
    expect(database.calls[0]?.values).toEqual(["principal","credential","request-1"]);
  });

  test("does not query when no idempotency key was supplied", async () => {
    const database = queryResult([]);
    await expect(resolveActivityReplay(database,{
      principalId: "principal",credentialId: "credential",serviceId: null,
    },undefined,"end","hash",(delivery) => delivery)).resolves.toBeNull();
    expect(database.calls).toHaveLength(0);
  });
});
