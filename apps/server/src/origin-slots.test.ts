import { describe,expect,test } from "vitest";
import {
  canonicalOriginHash,dashboardTestLabOrigin,lockOriginGenerationSlot,originDescriptorSchema,
  originGenerationMetadata,
} from "./origin-slots.js";

describe("origin slot identity", () => {
  const base = {
    sourceInstance: "codex:macbook-studio",
    project: "Relo notifications",
    thread: "thread-42",
    channel: "task-progress",
  };

  test("is stable, bounded, and separates every identity dimension", () => {
    const first = canonicalOriginHash("principal-1",base);
    expect(first).toMatch(/^org_[A-Za-z0-9_-]{43}$/);
    expect(canonicalOriginHash("principal-1",{ ...base })).toBe(first);
    for (const [field,value] of [
      ["sourceInstance","codex:other"],
      ["project","another-project"],
      ["thread","thread-43"],
      ["channel","approval"],
    ] as const) {
      expect(canonicalOriginHash("principal-1",{ ...base,[field]: value })).not.toBe(first);
    }
    expect(canonicalOriginHash("principal-2",base)).not.toBe(first);
  });

  test("normalizes surrounding whitespace without retaining raw origin values", () => {
    expect(canonicalOriginHash("principal-1",{
      sourceInstance: " codex:macbook-studio ",project: " Relo notifications ",
      thread: " thread-42 ",channel: " task-progress ",
    })).toBe(canonicalOriginHash("principal-1",base));
    expect(dashboardTestLabOrigin("principal-1","device-1"))
      .not.toBe(dashboardTestLabOrigin("principal-1","device-2"));
    expect(originDescriptorSchema.safeParse({ ...base,secret: "forbidden" }).success).toBe(false);
  });

  test("locks before selecting the active row and allocating the next retained generation", async () => {
    const calls: Array<{ text: string;values?: unknown[] }> = [];
    const query = {
      async query(text: string,values?: unknown[]) {
        calls.push({ text,values });
        if (text.includes("FROM live_activities")) return { rows: [
          { id: "newer",state: "active",generation: 2 },
          { id: "older",state: "ended",generation: 1 },
        ] };
        return { rows: [] };
      },
    };
    const slot = await lockOriginGenerationSlot(query,"principal-1","org_test");
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(calls[1]?.text).toContain("ORDER BY generation DESC");
    expect(slot).toEqual({
      active: { id: "newer",state: "active",generation: 2 },
      latest: { id: "newer",state: "active",generation: 2 },
      nextGeneration: 3,
    });
    expect(originGenerationMetadata({ origin_hash: "org_test",generation: 3 },false))
      .toEqual({ reused: false,resumed: true });
    expect(originGenerationMetadata({ origin_hash: "org_test",generation: 3 },true))
      .toEqual({ reused: true,resumed: false });
  });
});
