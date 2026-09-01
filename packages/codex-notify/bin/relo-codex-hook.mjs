#!/usr/bin/env node

import { runHook } from "../src/hook-adapter.mjs";

const argv = process.argv.slice(2);
if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
  process.stdout.write("Usage: relo-codex-hook --relo-bin ABSOLUTE_PATH --installation-id-path ABSOLUTE_PATH [--state-path ABSOLUTE_PATH]\n");
} else {
  process.exitCode = await runHook(argv);
}
