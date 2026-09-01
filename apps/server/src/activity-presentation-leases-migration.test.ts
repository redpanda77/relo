import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";

describe("activity presentation lease migration",() => {
  test("separates per-device presentation from canonical lifecycle",async () => {
    const sql = await readFile(
      new URL("../migrations/0027_activity_presentation_leases.sql",import.meta.url),"utf8",
    );
    expect(sql).toContain("CREATE TABLE live_activity_presentation_leases");
    expect(sql).toContain("WHERE state='foreground'");
    expect(sql).toContain("ADD COLUMN terminal_reason text");
    expect(sql).toContain("ADD COLUMN presentation_preset_id text");
    const scopedSql = await readFile(
      new URL("../migrations/0030_scoped_activity_presentation_leases.sql",import.meta.url),"utf8",
    );
    expect(scopedSql).toContain("ADD COLUMN scope_key text");
    expect(scopedSql).toContain("live_activity_presentation_leases_foreground_scope_idx");
    expect(scopedSql).toContain("principal_id,device_id,scope_key");
  });
});
