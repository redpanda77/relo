import { readFileSync,readdirSync } from "node:fs";
import { join,relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe,expect,test } from "vitest";

/**
 * ADR 0010 reachability style for the derivation (plan 14, workstream 5): derive/** is pure policy. It reaches no
 * database, network or route module (load.ts is the one loader that reads rows for it), and the observed session
 * `phase` is interpreted in exactly one place, derive/presence.ts, so the card and the Sessions view cannot disagree.
 */
const DERIVE = fileURLToPath(new URL(".",import.meta.url));
const SRC = join(DERIVE,"..");
const files = (dir: string): string[] => readdirSync(dir,{ withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(dir,entry.name)) : entry.name.endsWith(".ts") ? [join(dir,entry.name)] : []);
const rel = (file: string) => relative(SRC,file);
const productionDerive = files(DERIVE).filter((file) => !file.endsWith(".test.ts"));
const importsOf = (file: string) => [...readFileSync(file,"utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
const lines = (file: string) => readFileSync(file,"utf8").split("\n").map((text,index) => ({ text,line: index + 1 }));

describe("derive/** reaches no database, network or route module",() => {
  const forbidden = /(^|\/)(db|app|server|worker|delivery|apns)(\.js)?$|(^|\/)api\/|-routes(\.js)?$|^(pg|hono|undici|node-fetch)(\/|$)|^node:(http|https|http2|net|tls|dgram|dns|child_process)$/;
  test("no import of a db, route, delivery or network module, except the loader that reads rows for derive()",() => {
    const found = productionDerive.filter((file) => importsOf(file).some((specifier) => forbidden.test(specifier))).map(rel);
    expect(found).toEqual(["derive/load.ts"]);
  });

  test("the loader is the only derive file that touches the database or the clock of the process",() => {
    const found = productionDerive.filter((file) => !file.endsWith("/derive/load.ts")).flatMap((file) => lines(file)
      .filter(({ text }) => /\b(db\.query|pool\.|fetch\(|Date\.now\(|new Date\(\)|statement_timestamp)/.test(text)
        && !/^\s*(\/\/|\*|\/\*)/.test(text)).map(({ text,line }) => `${rel(file)}:${line}: ${text.trim()}`));
    expect(found).toEqual([]);
  });

  test("the derivation does not import the storage module it reads from (storage imports nothing from derive/)",() => {
    const storage = readFileSync(join(SRC,"agent-sessions.ts"),"utf8");
    expect(importsOf(join(SRC,"agent-sessions.ts")).filter((specifier) => /derive\//.test(specifier))).toEqual([]);
    expect(storage).not.toMatch(/from\s+["']\.\/derive\//);
    expect(productionDerive.filter((file) => importsOf(file).some((specifier) => /(^|\/)agent-sessions(\.js)?$/.test(specifier))).map(rel))
      .toEqual(["derive/load.ts"]);
  });
});

describe("the observed phase is read in one place",() => {
  // A comparison, switch, case label or destructuring of the observed phase: reading its meaning.
  const reads = [
    /\bphase\s*[!=]==?\s*["']/, /["'][a-z]+["']\s*[!=]==?\s*[\w.]*\bphase\b/, /\bswitch\s*\([^)]*\bphase\b/,
    /\bcase\s+["'](stopped|waiting)["']\s*:/, /\{[^}]*\bphase\b[^}]*\}\s*=\s*[\w.]*(session|observed|evidence)/,
    /["']stopped["']/,
  ];
  // Storage (agent-sessions.ts) is pinned by edge-invariants.test.ts: it stores a reported snapshot and compares no stored phase.
  const owners = ["agent-session-reads.ts"];

  test("only derive/presence.ts interprets the phase: no comparison, switch or case on it in derive/** or the sessions read module",() => {
    const scanned = [...productionDerive,...owners.map((name) => join(SRC,name))].filter((file) => !file.endsWith("/derive/presence.ts"));
    const found = scanned.flatMap((file) => lines(file).filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text) && reads.some((read) => read.test(text)))
      .map(({ text,line }) => `${rel(file)}:${line}: ${text.trim()}`));
    expect(found).toEqual([]);
  });

  test("presence.ts does interpret it, and the card and the Sessions view both call presence() and reconcile()",() => {
    expect(readFileSync(join(DERIVE,"presence.ts"),"utf8")).toMatch(/switch \(observed\.phase\)/);
    for (const name of ["agent-session-evidence.ts","sessions-view.ts"]) {
      const text = readFileSync(join(DERIVE,name),"utf8");
      expect(text,name).toMatch(/\bpresence\(/);
      expect(text,name).toMatch(/\breconcile\(/);
    }
  });

  test("the timing a presence rule needs lives in the contracts' table, not as a local number",() => {
    const text = readFileSync(join(DERIVE,"presence.ts"),"utf8");
    expect(text).not.toMatch(/\b\d+\s*\*\s*60\b|\b\d{4,}\b/);
  });
});
