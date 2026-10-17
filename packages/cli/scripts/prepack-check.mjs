#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertSkillVersion } from "./bundle-skill.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const readme = await readFile(new URL("README.md", root), "utf8");
const cli = await readFile(new URL("src/version.mjs", root), "utf8");

if (manifest.private !== true) throw new Error("@relo/cli must remain private");
if (manifest.license !== "PolyForm-Noncommercial-1.0.0") throw new Error("The relo CLI license policy changed");
if (manifest.publishConfig !== undefined) throw new Error("The relo CLI must not add publish configuration");
if (!cli.includes(`const VERSION = ${JSON.stringify(manifest.version)};`)) {
  throw new Error("The relo CLI runtime version does not match package.json");
}
if (!Array.isArray(manifest.files)
  || !manifest.files.includes("README.md")
  || !manifest.files.includes("LICENSE")) {
  throw new Error("The relo CLI package files must include README.md and LICENSE");
}
// The packed README must still teach the model, login, and exit codes.
for (const required of [
  "--api-url", "--secret-file", "relo work start", "relo ask", "relo notify", "| `5` | The owner denied or said no",
]) {
  if (!readme.includes(required)) throw new Error(`The relo CLI README is missing ${required}`);
}
// The skill ships inside the package at the CLI's exact version (scripts/bundle-skill.mjs makes it).
if (!manifest.files.includes("skill")) throw new Error("The relo CLI package files must include the bundled skill");
await readFile(new URL("skill/SKILL.md", root), "utf8").catch(() => { throw new Error("The relo CLI is missing the bundled skill (run scripts/bundle-skill.mjs)"); });
await assertSkillVersion(fileURLToPath(new URL("skill/", root)), manifest.version);
