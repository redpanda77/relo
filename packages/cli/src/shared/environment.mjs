// Every environment variable the CLI reads, once: relo schema and the docs (/docs/reference/environment)
// render this list, and test/environment.test.mjs fails when the code reads a RELO_ or XDG_ variable not
// listed here (or this lists one nothing reads). `internal` marks variables Relo sets for itself or tests.
// `setting` names the shared/settings.mjs entry the variable overrides (relo config, the machine report).
import { HARNESSES } from "../harness/catalog.mjs";

const DETECTED = HARNESSES.filter((harness) => harness.detect).map((harness) => harness.label).join(", ");

export const ENVIRONMENT = Object.freeze([
  { name: "RELO_API_URL", setting: "server", purpose: "The Relo server's origin, for CI and containers (with RELO_TOKEN); otherwise the config file holds it." },
  { name: "RELO_TOKEN", purpose: "A credential for CI and containers; overrides the config file. Requires RELO_API_URL." },
  { name: "RELO_PROFILE", setting: "profile", purpose: "Use this named sign-in (relo auth login --profile NAME) instead of the active one. RELO_TOKEN still wins." },
  { name: "RELO_CONFIG_PATH", setting: "configPath", purpose: "Another location for the config file (default: ~/Library/Application Support/relo/config.json on macOS, %APPDATA%\\relo\\config.json on Windows, else $XDG_CONFIG_HOME/relo/config.json or ~/.config/relo/config.json)." },
  { name: "RELO_SESSION", purpose: `A script, or a harness Relo does not detect: a stable id, so every command lands on one work and card and questions wait up to 100 s. For scripts it is the producer key (like --producer). Ignored inside a detected harness (${DETECTED}).` },
  { name: "RELO_SOURCE", setting: "source", purpose: `The sender shown on the phone (--source); name your harness here when Relo does not detect it (it detects ${DETECTED}).` },
  { name: "RELO_PROJECT", setting: "project", purpose: "Default --project (otherwise the git repository's name)." },
  { name: "RELO_TOPIC", setting: "topic", purpose: "Default --topic (otherwise the session's own name inside a harness)." },
  { name: "RELO_COMPUTER", setting: "computer", purpose: "Default --computer (otherwise the Mac's name, else the hostname)." },
  { name: "RELO_ACCOUNT", setting: "account", purpose: "Default --account (otherwise relo account NAME, else the name of a custom agent config folder)." },
  { name: "RELO_STATE_DIR", setting: "stateDir", purpose: "Where Relo keeps all of its local state: session copies, the outbox, hook bookkeeping, the sealed-card cache, asked questions, names, seen notes and the command journal (default $XDG_STATE_HOME/relo, else ~/.local/state/relo)." },
  { name: "XDG_STATE_HOME", purpose: "The standard state folder; Relo uses $XDG_STATE_HOME/relo when RELO_STATE_DIR is not set." },
  { name: "XDG_CONFIG_HOME", purpose: "The standard config folder; the config file is $XDG_CONFIG_HOME/relo/config.json when set." },
  { name: "RELO_KEY_STORE_PATH", purpose: "Another location for this computer's end-to-end keys (default e2ee.json beside the config file)." },
  { name: "RELO_HARNESS_CREDENTIAL_PATH", purpose: "Another location for the hooks' presence-only credential (default beside the config file)." },
  { name: "RELO_HANDOFF_THRESHOLD", purpose: "Optimize only: the context use in whole percent (1-100, default 60) at which the next prompt is nudged to hand off and continue in a fresh session, once per round." },
  { name: "RELO_NO_UPDATE_CHECK", setting: "updateCheck", purpose: "1: no update checks or automatic updates: relo doctor does not look for a newer CLI release (otherwise once a day, 2 s timeout) and a newer CLI your server offers is not installed by itself." },
  { name: "RELO_RELEASES_URL", purpose: "Another releases API for relo update and the update check (a self-hoster's mirror)." },
  { name: "RELO_DEBUG", purpose: "1: relo hook appends its errors to hook-debug.log in the state folder, and relo mcp logs to stderr (both are silent otherwise)." },
  { name: "RELO_MCP_SESSION", purpose: "Set by relo mcp for the commands it runs: one session per MCP connection.", internal: true },
  { name: "RELO_NO_BACKGROUND_FLUSH", purpose: "1: hooks do not start the background flusher (tests).", internal: true },
]);

/** The variables a person sets, for relo schema. */
export const PUBLIC_ENVIRONMENT = Object.freeze(Object.fromEntries(ENVIRONMENT.filter((variable) => !variable.internal).map(({ name, purpose }) => [name, purpose])));

