// The module boundaries the CLI's design rests on (CLAUDE.md "Relo state model", plan 07 §1), pinned on
// the static import graph so a change that crosses one fails here, not in review:
//  - hooks (harness/**) are observed-only: they reach no declared-state writer, no producer module and
//    no network client, and import only the read side of the session store and the observed queue;
//  - producer types are separate modules: agent/ and script/ never import each other;
//  - shared core never asks who is calling (no caller.mjs import);
//  - no import cycles.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const FILES = readdirSync(SRC, { recursive: true }).filter((name) => name.endsWith(".mjs")).map((name) => join(SRC, name));
const short = (file) => relative(SRC, file).split(sep).join("/");

/** { specifier, names } per static import or re-export, and dynamic imports (names: undefined). */
function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const statics = [...text.matchAll(/^\s*(?:import|export)\s+(?:\{([^}]*)\}|[^;"]*?)\s*from\s+"([^"]+)"/gmu)]
    .map((match) => ({ specifier: match[2], names: match[1]?.split(",").map((name) => name.trim().split(/\s+as\s+/u)[0]).filter(Boolean) }));
  const dynamics = [...text.matchAll(/import\(\s*"([^"]+)"\s*\)/gu)].map((match) => ({ specifier: match[1] }));
  return [...statics, ...dynamics].filter(({ specifier }) => specifier.startsWith("."))
    .map((entry) => ({ ...entry, target: resolve(dirname(file), entry.specifier) }));
}
const GRAPH = new Map(FILES.map((file) => [file, importsOf(file)]));

function reachable(starts) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { target } of GRAPH.get(file) ?? []) visit(target);
  };
  starts.forEach(visit);
  return seen;
}

const under = (folder) => FILES.filter((file) => short(file).startsWith(`${folder}/`));

// harness/entry.mjs is the hook process's composition root: it builds the hook dependencies (hook-deps.mjs),
// so it alone may reach them. The hook logic it runs (core, adapters, catalog) may not.
const HOOK_LOGIC = () => under("harness").filter((file) => short(file) !== "harness/entry.mjs");

test("hooks reach no declared-state writer, producer module or network client", () => {
  const forbidden = [/^agent\//u, /^script\//u, /^owner\//u, /^messages\//u, /^cli\.mjs$/u,
    /^work\/declared-lane\.mjs$/u, /^work\/works-client\.mjs$/u, /^shared\/api-client\.mjs$/u,
    /^crypto\/seal-work\.mjs$/u, /^crypto\/self-copy\.mjs$/u, /^deps\.mjs$/u, /^hook-deps\.mjs$/u];
  const reached = [...reachable(HOOK_LOGIC())].map(short);
  for (const file of reached) {
    for (const pattern of forbidden) assert.doesNotMatch(file, pattern, `harness/** reaches ${file}`);
  }
});

test("the machine report and relo config are unreachable from the hook process, entry included", () => {
  const reached = [...reachable([join(SRC, "harness", "entry.mjs"), ...HOOK_LOGIC()])].map(short);
  for (const module of ["owner/machine-report.mjs", "owner/config.mjs", "deps.mjs"]) {
    assert.ok(!reached.includes(module), `the hook process reaches ${module}`);
  }
  assert.ok(!reached.some((file) => file.startsWith("owner/")), "the hook process reaches an owner module");
});

test("hooks import only the read side of the session store and only the observed queue", () => {
  const ALLOWED = { "work/session-store.mjs": ["readSessionFile"], "outbox/index.mjs": ["observedQueue", "serverOrigin"],
    "work/state-file.mjs": ["readStateFile", "stateRoot"] };
  const constant = (name) => /^[A-Z][A-Z0-9_]*$/u.test(name);
  for (const file of HOOK_LOGIC()) {
    for (const { target, names } of GRAPH.get(file)) {
      const allowed = ALLOWED[short(target)];
      if (!allowed) continue;
      for (const name of names ?? ["(dynamic import)"]) {
        assert.ok(allowed.includes(name) || constant(name), `${short(file)} imports ${name} from ${short(target)}`);
      }
    }
  }
});

test("the Relo MCP server knows no harness: only the composition root (cli.mjs) reaches both", () => {
  assert.deepEqual(GRAPH.get(join(SRC, "agent", "mcp.mjs")).map(({ target }) => short(target)).filter((file) => file.startsWith("harness/") && file !== "harness/catalog.mjs"), [],
    "agent/mcp.mjs imports a harness module (only the catalog of names is allowed)");
  const reachesBoth = FILES.filter((file) => {
    const targets = new Set(GRAPH.get(file).map(({ target }) => short(target)));
    return targets.has("agent/mcp.mjs") && [...targets].some((target) => target.startsWith("harness/"));
  }).map(short);
  assert.deepEqual(reachesBoth, ["cli.mjs"], "only the composition root imports both agent/mcp.mjs and a harness module");
});

test("producer types are separate modules: agent/ and script/ never import each other", () => {
  for (const [from, to] of [["agent", "script"], ["script", "agent"]]) {
    for (const file of under(from)) {
      for (const { target } of GRAPH.get(file)) assert.ok(!short(target).startsWith(`${to}/`), `${short(file)} imports ${short(target)}`);
    }
  }
});

test("shared core never asks who is calling", () => {
  for (const folder of ["shared", "work", "messages", "crypto", "outbox", "install"]) {
    for (const file of under(folder)) {
      for (const { target } of GRAPH.get(file)) assert.notEqual(short(target), "caller.mjs", `${short(file)} imports caller.mjs`);
    }
  }
});

test("no import cycles", () => {
  const cycles = new Set();
  const stack = [];
  const done = new Set();
  const visit = (file) => {
    const at = stack.indexOf(file);
    if (at !== -1) {
      const loop = stack.slice(at).map(short);
      const first = loop.indexOf([...loop].sort()[0]);
      cycles.add([...loop.slice(first), ...loop.slice(0, first)].join(" → "));
      return;
    }
    if (done.has(file)) return;
    stack.push(file);
    for (const { target } of GRAPH.get(file) ?? []) visit(target);
    stack.pop();
    done.add(file);
  };
  FILES.forEach(visit);
  assert.deepEqual([...cycles], []);
});
