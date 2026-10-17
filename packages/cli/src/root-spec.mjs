// Commands the dispatcher answers itself (cli.mjs): help, schema, and mcp (run() serves it on stdio).

// `root: true`: the dispatcher answers these before the registry lookup.
export const ROOT_COMMANDS = [
  { name: "mcp", root: true, summary: "A stdio MCP server for harnesses without a shell (Claude desktop, Cursor chat, Codex, Gemini CLI; VS Code reads it from a project's .vscode/mcp.json, which Relo does not write); a harness launches it, nobody types it. Tools: relo_work_start, relo_work_update, relo_work_finish, relo_work_state, relo_ask (waits up to 5 minutes with progress notifications), relo_interaction_wait, relo_notify, relo_doctor; results are the same compact JSON. Each connection is one session. The owner adds it with `relo setup --mcp --agent NAME`.", options: [] },
  { name: "help", root: true, summary: "Short guide; `help identity` or `help all` for more.", positionals: "[identity|all]", options: [] },
  { name: "schema", root: true, summary: "This machine-readable reference; `relo schema work update` (or work.update) prints only those commands plus exitCodes.", positionals: "[COMMAND...]", options: [] },
];
