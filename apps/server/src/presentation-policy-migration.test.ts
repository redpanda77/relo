import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";

describe("0026 Live Activity presentation policy migration",() => {
  test("adds scoped policy bindings and immutable activity provenance",async () => {
    const sql = await readFile(
      new URL("../migrations/0026_live_activity_presentation_policies.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("ALTER TABLE owner_principals");
    expect(sql).toContain("ALTER TABLE principal_api_keys");
    expect(sql).toContain("ALTER TABLE webhook_services");
    expect(sql).toContain("ADD COLUMN presentation_policy jsonb");
    expect(sql).toContain("ADD COLUMN presentation_policy_source text");
    expect(sql).toContain("'invocation','client','service','account','system'");
    expect(sql).not.toMatch(/prompt|assistant|thread_id|session_id|secret/i);
  });
});
