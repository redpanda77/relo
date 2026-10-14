import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Principle 12 (ADR 0008): every card names the producer type that owns it. A source scan keeps any new
// INSERT INTO live_activities from leaning on a default or a nullable column.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("producer_type on every card insert", () => {
  test("each INSERT INTO live_activities in server code names producer_type", () => {
    const root = new URL(".", import.meta.url).pathname;
    const inserts: { file: string; columns: string }[] = [];
    for (const file of sources(root)) {
      for (const match of readFileSync(file, "utf8").matchAll(/INSERT INTO live_activities\s*\(([^)]*)\)/g)) {
        inserts.push({ file: file.slice(root.length), columns: match[1]! });
      }
    }
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.filter(({ columns }) => !/\bproducer_type\b/.test(columns)).map(({ file }) => file)).toEqual([]);
  });
});
