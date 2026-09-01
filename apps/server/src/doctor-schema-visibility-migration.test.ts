import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";

describe("doctor schema visibility migration",() => {
  test("grants the runtime role only read access to migration identities",async () => {
    const sql = await readFile(
      new URL("../migrations/0039_doctor_schema_visibility.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/GRANT SELECT ON schema_migrations TO relo_runtime/);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL)/);
  });
});
