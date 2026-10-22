#!/usr/bin/env node
// Pass-cache keys for the release gates: one "group key" line per gate group (scripts/select-gates.mjs's groups).
//   node scripts/gate-keys.mjs [commit] [--repo DIR] [--node-major N]
// A key is a sha256 over the blobs of every tracked file the group covers (select-gates's own mapping, so an
// unknown path counts for every group), the lockfile, scripts/gates.sh and the node major version: the same key
// means the same inputs, so a group that passed on it need not run again (scripts/gates-cache.sh).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GATES, gatesFor } from "./select-gates.mjs";

/** entries: [{ path, blob }] of the tracked files. Returns Map<group, key>. Pure: no git, no filesystem. */
export function computeKeys(entries, { nodeMajor }) {
  const blobOf = (path) => entries.find((e) => e.path === path)?.blob ?? "none";
  const extra = [`lock ${blobOf("pnpm-lock.yaml")}`, `gates ${blobOf("scripts/gates.sh")}`, `node ${nodeMajor}`];
  const keys = new Map();
  for (const group of GATES) {
    const covered = entries
      .filter((e) => (gatesFor(e.path) ?? GATES).includes(group))
      .map((e) => `${e.path}\0${e.blob}`)
      .sort();
    keys.set(group, createHash("sha256").update([group, ...extra, ...covered].join("\n")).digest("hex"));
  }
  return keys;
}

export function formatKeys(keys) {
  return [...keys].map(([group, key]) => `${group} ${key}`).join("\n") + "\n";
}

/** Parses `git ls-tree -r -z` output ("<mode> blob <sha>\t<path>\0..."). */
export function parseLsTree(out) {
  return out.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    return { blob: record.slice(0, tab).split(" ")[2], path: record.slice(tab + 1) };
  });
}

export function keysForCommit(repo, commit, nodeMajor) {
  const out = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", commit], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return computeKeys(parseLsTree(out), { nodeMajor });
}

// Real paths on both sides: a script under a symlinked folder (macOS /var -> /private/var) must still run.
const invoked = process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (invoked && invoked === pathToFileURL(realpathSync(new URL(import.meta.url))).href) {
  const args = process.argv.slice(2);
  const take = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args.splice(i, 2)[1]; };
  const repo = take("--repo", ".");
  const nodeMajor = take("--node-major", process.versions.node.split(".")[0]);
  process.stdout.write(formatKeys(keysForCommit(repo, args[0] ?? "HEAD", nodeMajor)));
}
