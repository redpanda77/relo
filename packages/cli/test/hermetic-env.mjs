// Tests decide which agent session (if any) they run in; never inherit the developer's own.
for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "RELO_SOURCE", "RELO_PROJECT", "RELO_TOPIC", "RELO_TOKEN",
  "RELO_COMPUTER", "RELO_ACCOUNT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE",
  "RELO_SESSION", "GEMINI_CLI", "CURSOR_AGENT", "COPILOT_HOME"]) {
  delete process.env[name];
}
// Tests never ask GitHub for the latest release.
process.env.RELO_NO_UPDATE_CHECK = "1";
// Tests never read or write the developer's end-to-end encryption key store.
process.env.RELO_KEY_STORE_PATH = `/nonexistent/relo-test-${process.pid}/e2ee.json`;
