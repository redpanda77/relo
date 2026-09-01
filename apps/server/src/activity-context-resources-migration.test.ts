import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";

describe("0029 activity context resources migration",() => {
  test("creates first-class conversations and work items with runtime-safe linkage",async () => {
    const sql = await readFile(
      new URL("../migrations/0029_activity_conversations_and_work_items.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE activity_conversations");
    expect(sql).toContain("CREATE TABLE activity_work_items");
    expect(sql).toContain("provider_thread_id text");
    expect(sql).toContain("provider_work_item_id text");
    expect(sql).toContain("CREATE TRIGGER live_activities_bind_context_resources");
    expect(sql).toContain("GRANT SELECT,INSERT,UPDATE ON activity_conversations,activity_work_items TO relo_runtime");
    expect(sql).toContain("REVOKE DELETE,TRUNCATE ON activity_conversations,activity_work_items FROM relo_runtime");
  });
});
