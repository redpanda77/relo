#!/usr/bin/env node

import { parseArgs } from "node:util";
import { configureCodexNotify } from "../src/configure-codex-notify.mjs";

const parsed = parseArgs({
  options: {
    config: { type: "string" },
    adapter: { type: "string" },
    relo: { type: "string" },
    "backup-suffix": { type: "string" },
    "installation-id-path": { type: "string" },
    generic: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});
const values = parsed.values;
const [action = "install"] = parsed.positionals;
if (parsed.positionals.length > 1) throw new Error("Expected at most one action");

if (values.help) {
  console.log("Usage: configure-codex-notify.mjs [install|doctor|uninstall] --config ABSOLUTE --adapter ABSOLUTE --relo ABSOLUTE [--installation-id-path ABSOLUTE] [--backup-suffix SAFE]");
  process.exit(0);
}
console.log(JSON.stringify(await configureCodexNotify({
  action,
  config: values.config,
  adapter: values.adapter,
  relo: values.relo,
  backupSuffix: values["backup-suffix"],
  installationIdPath: values["installation-id-path"],
  generic: values.generic,
})));
