#!/usr/bin/env node
// Syntax-checks every .mjs file the package ships or runs, subfolders included. Silent on success: prepack
// runs it inside `npm pack --json`, whose stdout must stay JSON.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["bin", "src", "scripts"].flatMap((folder) => readdirSync(join(root, folder), { recursive: true })
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => join(root, folder, name)));
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
