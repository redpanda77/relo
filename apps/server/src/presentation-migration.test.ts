import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";

describe("current presentation migration",() => {
  test("accepts only the current stored contract",async () => {
    const sql = await readFile(
      new URL("../migrations/0041_current_presentation_contract.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TEMP TABLE stale_live_activity_ids");
    expect(sql).toContain("DELETE FROM notification_events");
    expect(sql).toContain("DELETE FROM live_activities");
    expect(sql).toContain("DELETE FROM live_activity_operations");
    expect(sql).toContain("NOT (presentation @?");
    expect(sql).toContain("NOT (presentation_snapshot @?");
    expect(sql).toContain("ALTER COLUMN presentation SET NOT NULL");
    expect(sql).toContain("ALTER COLUMN presentation_snapshot SET NOT NULL");
    expect(sql).toContain("presentation->>'version'='3'");
    expect(sql).toContain("presentation_snapshot->>'version'='3'");
    expect(sql).not.toContain("jsonb_build_object");
    expect(sql).not.toContain("ADD CONSTRAINT live_activities_presentation_version_check CHECK (\n    presentation IS NULL OR");
    expect(sql).not.toContain("IN ('2','3')");
  });

  test("removes the retired fallback shape after an already-applied cutover",async () => {
    const sql = await readFile(
      new URL("../migrations/0042_retired_presentation_fallback_cleanup.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TEMP TABLE retired_fallback_activity_ids");
    expect(sql).toContain("WHERE presentation ? 'fallback'");
    expect(sql).toContain("DELETE FROM notification_events");
    expect(sql).toContain("DELETE FROM live_activities");
    expect(sql).toContain("DELETE FROM live_activity_operations");
    expect(sql).toContain("live_activities_no_retired_fallback_check");
    expect(sql).toContain("live_activity_operations_no_retired_fallback_check");
    expect(sql).not.toContain("jsonb_build_object");
  });
});
