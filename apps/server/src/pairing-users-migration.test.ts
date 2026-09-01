import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("pairing and users migration", () => {
  test("adds single-use grants, account roles, and attributable devices", async () => {
    const sql = await readFile(new URL("../migrations/0037_pairing_and_users.sql",import.meta.url),"utf8");
    expect(sql).toContain("CREATE TABLE connection_grants");
    expect(sql).toContain("grant_hash text NOT NULL UNIQUE");
    expect(sql).toContain("role text NOT NULL DEFAULT 'owner'");
    expect(sql).toContain("registered_by_subject text REFERENCES auth.users");
  });
});
