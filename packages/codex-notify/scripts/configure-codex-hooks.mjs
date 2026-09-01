#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  inspectCodexLifecycleHooks,installCodexLifecycleHooks,uninstallCodexLifecycleHooks,
} from "../src/codex-hooks-config.mjs";

const [rawAction = "doctor",...argv] = process.argv.slice(2);
const action = ["--help", "-h"].includes(rawAction) ? "doctor" : rawAction;
const values = parseArgs({ args: argv,options: {
  "hooks-config": { type: "string" },hook: { type: "string" },relo: { type: "string" },
  "installation-id-path": { type: "string" },help: { type: "boolean",default: false },
},strict: true }).values;
if (["--help", "-h"].includes(rawAction) || values.help || !["install","doctor","uninstall"].includes(action)) {
  console.log("Usage: configure-codex-hooks.mjs install|doctor|uninstall --hooks-config ABSOLUTE --hook ABSOLUTE --relo ABSOLUTE --installation-id-path ABSOLUTE");
  process.exit(["--help", "-h"].includes(rawAction) || values.help ? 0 : 2);
}
const input = {
  hooksConfig: values["hooks-config"],hook: values.hook,relo: values.relo,
  installationIdPath: values["installation-id-path"],
};
const result = action === "install" ? await installCodexLifecycleHooks(input)
  : action === "uninstall" ? await uninstallCodexLifecycleHooks(input)
    : await inspectCodexLifecycleHooks(input);
console.log(JSON.stringify(result));
