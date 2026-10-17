import { beforeEach, describe, expect, test } from "vitest";
import { forgetTouches, touch, TOUCH_INTERVAL_MS } from "./touch.js";

describe("last use (plan 10 B2)", () => {
  beforeEach(() => forgetTouches());
  test("writes at most once per credential per interval, each kind to its own table", async () => {
    const writes: Array<[string,unknown[]]> = [];
    const db = { query: async (text: string,values?: unknown[]) => { writes.push([text,values ?? []]); return { rows: [],rowCount: 1 }; } } as never;
    expect(await touch(db,"login","a",0)).toBe(true);
    expect(await touch(db,"login","a",TOUCH_INTERVAL_MS - 1)).toBe(false);
    expect(await touch(db,"service","a",1)).toBe(true);
    expect(await touch(db,"login","a",TOUCH_INTERVAL_MS)).toBe(true);
    expect(writes.map(([text]) => text.split(" ")[1])).toEqual(["principal_api_keys","webhook_services","principal_api_keys"]);
  });
});
