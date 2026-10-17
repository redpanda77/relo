---
title: Machine and advanced commands
nav: machine and advanced
summary: The commands harnesses launch, the machine-readable reference, and the advanced delivery, evidence and outbox tools.
---

Nobody types most of these. A harness launches `relo mcp` (a stdio MCP server for tools without a
shell) and `relo hook` (the optional hook entry point that `relo setup --level guide` installs). `relo help`
and `relo schema` are the reference in the terminal: `relo help COMMAND` for one command, `relo help
all` for everything, `relo schema` for the same as JSON.

The rest are advanced and for troubleshooting. `relo delivery reconcile` settles a push whose fate is
unknown, `relo evidence timeline` and `relo evidence metrics` show delivery evidence, and `relo outbox
status` and `relo outbox flush` show and send the changes this computer still has queued (offline
writes and session snapshots). See [Troubleshooting](/docs/troubleshooting).

## Commands

{{cli machine}}
