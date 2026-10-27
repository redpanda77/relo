// Version helpers for the install modules: two relo versions on one Mac must never overwrite each other's
// skill copy or MCP entry with an older one (audit 2026-10-26, wave 2 "App ↔ CLI").
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/u;

/** True when `a` is a plain x.y.z version strictly newer than the plain x.y.z `b`; anything else is never "newer". */
export function isNewerVersion(a, b) {
  const left = PLAIN.exec(String(a ?? ""))?.slice(1).map(Number);
  const right = PLAIN.exec(String(b ?? ""))?.slice(1).map(Number);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

/** The version of the CLI package that holds `entrypoint` (the nearest package.json above it), or undefined. */
export function entrypointVersion(entrypoint) {
  if (typeof entrypoint !== "string" || !isAbsolute(entrypoint)) return undefined;
  let directory = dirname(entrypoint);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))?.version;
      if (typeof version === "string") return version;
    } catch { /* keep climbing */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The relo.mjs-style script an MCP entry runs (GUI entries name it as their first argument), or undefined. */
export function entryScript(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  return args.find((arg) => typeof arg === "string" && /(^|[\\/])relo(ctl)?(\.mjs)?$/u.test(arg) && isAbsolute(arg));
}

/** True when `existing` names a CLI whose package version is newer than the one `wanted` names. */
export function entryNamesNewerCli(existing, wanted) {
  return isNewerVersion(entrypointVersion(entryScript(existing)), entrypointVersion(entryScript(wanted)));
}
