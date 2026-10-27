#!/usr/bin/env node
// Proportional release gates: which of scripts/gates.sh's gates a set of changed paths needs.
//   node scripts/select-gates.mjs <file listing changed paths, one per line>
// Prints "gates: <selected keys>" on the first line, then one line per gate with the paths that selected it.
// A path no rule knows selects every gate: when unsure, run the gate. The cheap gates (F.1, public:check,
// release state) always run and are not listed here.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GATES = ["contracts", "dashboard", "server", "cli", "skill", "repo"];
const ALL = GATES;
// What each gate covers, read from what its tests actually load (fixtures and sources across packages):
//   server: typecheck and the DB suite. They import packages/cli crypto, read the iOS fixtures and E2EE source,
//     the public docs and docs site, docs/api, deploy/ and the private operations Compose files, and serve the
//     dashboard build, so all of those select it with the contracts and dashboard builds it needs.
//   cli: reads skills/, docs/site/reference and the iOS E2EE fixture. repo: release build reads packages/cli,
//     skills/, LICENSE and README; public export reads public-export.json and the root policy files.
const SERVER = ["contracts", "dashboard", "server"];
export const RULES = [
  // The gate machinery and the workspace itself: everything.
  [/^(scripts\/gates\.sh|scripts\/select-gates\.mjs|scripts\/narrow-tests\.mjs|scripts\/gate-keys\.mjs|scripts\/gates-cache\.sh|scripts\/release\/head-gates\.sh|scripts\/check-test-ran\.mjs)$/u, ALL],
  [/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|\.npmrc|\.gitignore|\.dockerignore)$/u, ALL],
  // Paths no gate reads: an app with its own tests, internal notes, decisions, contributor docs.
  [/^apps\/notch\//u, []],
  [/^apps\/windows\//u, []],
  [/^apps\/ios\/(Tests\/[^/]+\/Fixtures|Sources\/ReloCore\/E2EE)\//u, [...SERVER, "cli"]],
  [/^apps\/ios\//u, []], // F.1 (always run) covers apps/ios/Sources
  [/^docs\/internal\/operations\/[^/]+\/compose\.yaml$/u, SERVER],
  [/^docs\/(internal|adr)\//u, []],
  [/^(\.github|\.claude)\//u, []],
  [/^(ROADMAP|CLAUDE|CONTRIBUTING)\.md$/u, []],
  [/^\.gitnexusrc$/u, []],
  // Product code.
  [/^(apps\/server|packages\/contracts|deploy|docs\/api)\//u, SERVER],
  // The owner clients' shared E2EE code: the Dashboard bundles it from source (no build step of its own), so a change
  // is a Dashboard change and, through the build the server serves, a server one.
  [/^packages\/owner-crypto\//u, SERVER],
  // The owner client builds on the contracts and has its own tests, run with the contracts gate; nothing reads it back.
  [/^packages\/owner-client\//u, ["contracts"]],
  // Sounds, images and fonts: the Dashboard build and its tests read them; no server test does.
  [/^apps\/dashboard\/(src\/assets|public)\/.*\.(m4a|mp3|wav|png|jpe?g|webp|svg|ico|woff2?)$/u, ["dashboard"]],
  [/^apps\/dashboard\//u, SERVER],
  [/^packages\/cli\//u, [...SERVER, "cli", "skill", "repo"]],
  [/^skills\//u, ["cli", "skill", "repo"]],
  [/^docs\/site\//u, [...SERVER, "cli"]],
  [/^docs\/[^/]+\.md$/u, SERVER],
  [/^(README\.md|LICENSE|SECURITY\.md|public-export\.json)$/u, ["repo"]],
  [/^scripts\//u, ["repo"]],
];

/** The gates one path needs; `null` when no rule knows it (the caller then runs every gate). */
export function gatesFor(path) {
  for (const [pattern, gates] of RULES) if (pattern.test(path)) return gates;
  return null;
}

export function selectGates(paths) {
  const reasons = new Map(GATES.map((gate) => [gate, []]));
  const unknown = [];
  for (const path of paths) {
    const gates = gatesFor(path);
    if (gates === null) unknown.push(path);
    for (const gate of gates ?? ALL) reasons.get(gate).push(path);
  }
  return { selected: GATES.filter((gate) => reasons.get(gate).length), reasons, unknown };
}

// Real paths on both sides: a script under a symlinked folder (macOS /var -> /private/var) must still run.
const invoked = process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (invoked && invoked === pathToFileURL(realpathSync(new URL(import.meta.url))).href) {
  const [listPath] = process.argv.slice(2);
  if (!listPath) { console.error("usage: select-gates.mjs <changed-paths-file>"); process.exit(2); }
  const paths = readFileSync(listPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  const { selected, reasons, unknown } = selectGates(paths);
  console.log(`gates: ${selected.join(" ")}`);
  const sample = (list) => list.slice(0, 3).join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "");
  for (const gate of GATES) {
    const list = reasons.get(gate);
    console.log(list.length ? `  run   ${gate}: ${sample(list)}` : `  skip  ${gate}: no changed path it covers`);
  }
  if (unknown.length) console.log(`  unknown paths select every gate: ${sample(unknown)}`);
}
