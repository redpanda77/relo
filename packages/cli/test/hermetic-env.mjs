// Every CLI test file imports this first (and `npm test` preloads it), so a test file run directly with
// `node --test test/x.test.mjs` is as hermetic as the suite (a direct run once queued fixture writes in the
// developer's real outbox, and the real CLI later sent them to the real server). Loaded twice in one
// process it does nothing the second time: the temp folders below are made once.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPLIED = Symbol.for("relo.test.hermeticEnv");

if (!globalThis[APPLIED]) {
  globalThis[APPLIED] = true;
  // Tests decide which agent session (if any) they run in; never inherit the developer's own.
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "RELO_SOURCE", "RELO_PROJECT", "RELO_TOPIC", "RELO_TOKEN",
    "RELO_COMPUTER", "RELO_ACCOUNT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE",
    "CLAUDE_CODE_REMOTE", "RELO_SESSION", "RELO_MCP_SESSION", "GEMINI_CLI", "CURSOR_AGENT", "COPILOT_HOME"]) {
    delete process.env[name];
  }
  // Tests never ask GitHub for the latest release.
  process.env.RELO_NO_UPDATE_CHECK = "1";
  // Tests never read or write the developer's end-to-end encryption key store.
  process.env.RELO_KEY_STORE_PATH = `/nonexistent/relo-test-${process.pid}/e2ee.json`;
  // Tests never start a background outbox flusher (it would use the developer's own config and network).
  process.env.RELO_NO_BACKGROUND_FLUSH = "1";
  // Tests never read or write the developer's harness credential.
  process.env.RELO_HARNESS_CREDENTIAL_PATH = `/nonexistent/relo-test-${process.pid}/harness-credential`;
  // Tests never touch the developer's state folder (hook bookkeeping, observed session state, outbox).
  process.env.RELO_STATE_DIR = join(tmpdir(), `relo-test-state-${process.pid}`);
  // Tests never install into the developer's global npm prefix (DOGFOOD #1, #13, #17, #18, #21: a test's
  // `npm install --global` replaced the owner's own relo four times). Any global install lands here.
  process.env.npm_config_prefix = join(tmpdir(), `relo-test-npm-prefix-${process.pid}`);
  // Tests never touch the developer's state folder (sessions, the outbox): a fresh one per test process.
  process.env.XDG_STATE_HOME = mkdtempSync(`${tmpdir()}/relo-test-state-`);
  // Tests never read the developer's home (installed skills, agent settings): HOME is an empty temp folder.
  process.env.HOME = mkdtempSync(join(tmpdir(), "relo-test-home-"));
  // Tests never write into this repository: a command that reads the working folder (relo setup --project,
  // relo uninstall) starts in an empty temp folder unless the test injects its own cwd. Paths to the
  // package itself come from import.meta.url, never from the working folder.
  process.chdir(mkdtempSync(join(tmpdir(), "relo-test-cwd-")));
}
