#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const readme = await readFile(new URL("README.md", root), "utf8");

if (manifest.private !== true) throw new Error("codex-notify must remain private");
if (manifest.license !== "PolyForm-Noncommercial-1.0.0") throw new Error("codex-notify license policy changed");
if (manifest.publishConfig !== undefined) throw new Error("codex-notify must not add publish configuration");
if (!Array.isArray(manifest.files)
  || !manifest.files.includes("README.md")
  || !manifest.files.includes("LICENSE")) {
  throw new Error("codex-notify package files must include README.md and LICENSE");
}
for (const required of ["--api-url", "Update", "SHA-256", "same-version", "roll back", "npm uninstall"]) {
  if (!readme.includes(required)) throw new Error(`codex-notify README is missing ${required}`);
}
