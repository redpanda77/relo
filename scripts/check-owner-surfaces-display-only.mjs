#!/usr/bin/env node
// F.1 gate: owner surfaces (iPhone app, Dashboard) display the server's derived state; they never
// re-derive it. Fails when client source names a client-side policy the server owns: quiet/recent
// windows, session phase derivation, abandonment/idle timers, or a stale time computed on the client.
// Test, preview and fixture files are skipped (sample data, or naming the banned symbols to assert their absence).
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SURFACES = ["apps/ios/Sources", "apps/dashboard/src", "packages/owner-client/src"];
const EXTENSIONS = /\.(swift|ts|tsx|js|jsx|mjs)$/u;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|\/Tests\/|\/PreviewData\.swift$|Fixtures\.swift$)/u;

export const BANNED = [
  { name: "QUIET_AFTER_MS", pattern: /\bQUIET_AFTER_MS\b/u },
  { name: "RECENT_WINDOW_MS", pattern: /\bRECENT_WINDOW_MS\b/u },
  { name: "agentSessionPhase(", pattern: /\bagentSessionPhase\s*\(/u },
  // Raw session events never reach owner surfaces: the server sends a derived phase and waitingFor.
  { name: "lastEvent", pattern: /\blastEvent\b/u },
  { name: "quietFor(", pattern: /\bquietFor\s*\(/u },
  { name: "groupSessions(", pattern: /\bgroupSessions\s*\(/u },
  { name: "LiveActivityAbandonmentPolicy", pattern: /\bLiveActivityAbandonmentPolicy\b/u },
  { name: "waitingAfterStop", pattern: /\bwaitingAfterStop\b/u },
  { name: "idleLostAfter", pattern: /\bidleLostAfter\b/u },
  { name: "staleAt + <interval>", pattern: /\bstale(At|Date)\??\s*\+/u },
  { name: "staleAt.addingTimeInterval", pattern: /\bstale(At|Date)\??\.addingTimeInterval\b/u },
  { name: "staleAt computed from addingTimeInterval", pattern: /\bstale(At|Date)\s*[:=]\s*[^,\n]*addingTimeInterval/u },
];

function* walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXTENSIONS.test(name)) yield path;
  }
}

export function scan(base = root) {
  const findings = [];
  for (const surface of SURFACES) {
    for (const file of walk(join(base, surface))) {
      const rel = relative(base, file);
      if (TEST_FILE.test(`/${rel}`)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/u.test(line)) return;
        for (const rule of BANNED) if (rule.pattern.test(line)) findings.push(`${rel}:${index + 1}: ${rule.name}: ${line.trim()}`);
      });
    }
  }
  return findings;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const findings = scan(process.argv[2] ? resolve(process.argv[2]) : root);
  if (findings.length) {
    console.error(`Owner surfaces must be display-only (F.1). ${findings.length} client-side policy reference(s):`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log("owner surfaces display-only: ok");
}
