// Tests decide which agent session (if any) they run in; never inherit the developer's own.
for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "RELO_SOURCE", "RELO_PROJECT", "RELO_TOPIC", "RELO_TOKEN"]) {
  delete process.env[name];
}
