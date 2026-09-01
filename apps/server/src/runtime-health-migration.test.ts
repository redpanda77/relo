import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("runtime component migration grants the worker the narrow access it needs", async () => {
  const sql = await readFile(new URL("../migrations/0038_runtime_components.sql",import.meta.url),"utf8");
  expect(sql).toMatch(/CREATE TABLE runtime_components/);
  expect(sql).toMatch(/CHECK \(component IN \('worker'\)\)/);
  expect(sql).toMatch(/GRANT SELECT,INSERT,UPDATE ON runtime_components TO relo_runtime/);
});
