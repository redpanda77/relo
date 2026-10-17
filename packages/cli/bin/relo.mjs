#!/usr/bin/env node
// Three commands skip the dispatcher: a hook runs on every tool call, the status line wrapper on every refresh, and
// `--version` is a cheap probe.
const argv = process.argv.slice(2);
if (argv[0] === "hook") {
  const { runHook } = await import("../src/harness/entry.mjs");
  process.exitCode = await runHook(argv);
} else if (argv.length === 1 && argv[0] === "statusline") {
  const { runStatusline } = await import("../src/harness/entry.mjs");
  process.exitCode = await runStatusline();
} else if (argv.length === 1 && argv[0] === "--version") {
  const { VERSION } = await import("../src/version.mjs");
  process.stdout.write(`${VERSION}\n`);
} else {
  const { run } = await import("../src/cli.mjs");
  process.exitCode = await run(argv);
}
