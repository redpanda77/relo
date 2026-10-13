import { describe, expect, test } from "vitest";
import { z } from "zod";
import { actorCursorScope, decodeCursor, encodeCursor } from "./cursor.js";

const schema = z.tuple([z.literal("test-v1"),z.iso.datetime(),z.uuid()]);
const id = "11111111-1111-4111-8111-111111111111";

describe("cursor codec", () => {
  test("round-trips a tagged tuple", () => {
    const cursor = encodeCursor(["test-v1","2026-10-06T00:00:00.000Z",id]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor,schema)).toEqual(["test-v1","2026-10-06T00:00:00.000Z",id]);
  });

  test("rejects missing, malformed, oversized and foreign cursors", () => {
    expect(decodeCursor(undefined,schema)).toBeUndefined();
    expect(decodeCursor("",schema)).toBeUndefined();
    expect(decodeCursor("not base64!",schema)).toBeUndefined();
    expect(decodeCursor(Buffer.from("{").toString("base64url"),schema)).toBeUndefined();
    expect(decodeCursor(encodeCursor(["other-v1","2026-10-06T00:00:00.000Z",id]),schema)).toBeUndefined();
    expect(decodeCursor("a".repeat(513),schema)).toBeUndefined();
  });

  test("scopes cursors to the account and device", () => {
    const owner = actorCursorScope({ principalId: id });
    expect(owner).toMatch(/^[a-f0-9]{64}$/);
    expect(actorCursorScope({ principalId: id,deviceId: null })).toBe(owner);
    expect(actorCursorScope({ principalId: id,deviceId: id })).not.toBe(owner);
  });
});
