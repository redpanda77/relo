#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const readme = await readFile(new URL("README.md", root), "utf8");
const cli = await readFile(new URL("src/cli.mjs", root), "utf8");

if (manifest.private !== true) throw new Error("reloctl must remain private");
if (manifest.license !== "PolyForm-Noncommercial-1.0.0") throw new Error("reloctl license policy changed");
if (manifest.publishConfig !== undefined) throw new Error("reloctl must not add publish configuration");
if (!cli.includes(`const VERSION = ${JSON.stringify(manifest.version)};`)) {
  throw new Error("reloctl runtime version does not match package.json");
}
if (!Array.isArray(manifest.files)
  || !manifest.files.includes("README.md")
  || !manifest.files.includes("LICENSE")) {
  throw new Error("reloctl package files must include README.md and LICENSE");
}
for (const required of [
  "--api-url", "--secret-file", "--page-size", "SHA-256", "same-version", "rollback", "uninstall",
]) {
  if (!readme.includes(required)) throw new Error(`reloctl README is missing ${required}`);
}
