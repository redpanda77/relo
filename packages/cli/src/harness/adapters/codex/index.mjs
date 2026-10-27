// Codex adapter. Docs: learn.chatgpt.com/docs/hooks (was developers.openai.com/codex/hooks). Hooks live in
// <CODEX_HOME>/hooks.json in Claude Code's shape (`hooks.<Event>[].hooks[]`, timeouts in seconds, `async` honoured)
// and are on by default (`[features] hooks = false` turns them off). Codex runs a hook only once the owner trusted
// it in `/hooks` (the trust is a hash of the entry, kept in config.toml): Relo never writes that trust itself, so
// setup asks the owner to review its hooks there once (install.trust).
// Stdin JSON carries session_id (the thread id the agent's shell has as CODEX_THREAD_ID), hook_event_name, cwd;
// source on SessionStart; turn_id and tool_use_id on tool events; agent_id on SubagentStart/SubagentStop, whose
// subagent shares its parent's session_id (so it is never a session of its own). Codex has no Notification
// event: a PermissionRequest is the turn waiting on the owner (the hook answers nothing, so Codex asks in its own
// prompt), and Interrupt (the owner stopping a turn, which runs no Stop) is a stop. Sets: off and presence.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { reloCommand } from "../../core/launch.mjs";
import { harnessPath } from "../../paths.mjs";
import { codexSessionName } from "./session-name.mjs";
import descriptor from "./descriptor.mjs";

const HOOK_LEVELS = Object.freeze(["off", "presence"]);
const EVENT_ORDER = Object.freeze(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
  "SubagentStart", "SubagentStop", "PreCompact", "Stop", "Interrupt", "SessionEnd"]);

// `launch` makes the command absolute on Windows (launch.mjs); elsewhere it is the bare `relo hook <role>`.
const command = (launch) => (role, extra) => ({ type: "command", command: reloCommand(`hook ${role} --agent codex`, launch), ...extra });
// Every entry is async (the hook returns at once anyway) but the two Codex runs while a turn or the session closes:
// SessionEnd always runs synchronously and both allow at most 3 seconds.
const presence = (cmd) => ({
  SessionStart: [{ hooks: [cmd("start", { timeout: 5, async: true })] }],
  UserPromptSubmit: [{ hooks: [cmd("prompt", { timeout: 5, async: true })] }],
  // Only the shell runs long enough for "tool running since" to matter.
  PreToolUse: [{ matcher: "^Bash$", hooks: [cmd("tool-start", { timeout: 5, async: true })] }],
  PostToolUse: [{ hooks: [cmd("tool-end", { timeout: 5, async: true })] }],
  PermissionRequest: [{ hooks: [cmd("wait", { timeout: 5, async: true })] }],
  SubagentStart: [{ hooks: [cmd("subagent-start", { timeout: 5, async: true })] }],
  SubagentStop: [{ hooks: [cmd("subagent-stop", { timeout: 5, async: true })] }],
  PreCompact: [{ hooks: [cmd("compact", { timeout: 5, async: true })] }],
  Stop: [{ hooks: [cmd("stop", { timeout: 5, async: true })] }],
  Interrupt: [{ hooks: [cmd("stop", { timeout: 3 })] }],
  SessionEnd: [{ hooks: [cmd("end", { timeout: 3 })] }],
});

function wantedEntries(level, launch) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  return level === "off" ? {} : presence(command(launch));
}

export default Object.freeze({
  id: descriptor.id,
  label: descriptor.label,
  aliases: descriptor.aliases,
  events: Object.freeze({
    SessionStart: "start",
    UserPromptSubmit: "prompt",
    PreToolUse: "tool_start",
    PostToolUse: "tool_end",
    PermissionRequest: "wait",
    SubagentStart: "subagent_start",
    SubagentStop: "subagent_stop",
    PreCompact: "compact",
    Stop: "stop",
    Interrupt: "stop",
    SessionEnd: "end",
  }),

  identity: (input) => ({
    id: input.session_id,
    agent: input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop" ? input.agent_id : undefined,
    toolKey: input.tool_use_id,
    source: input.source,
    stopActive: input.stop_hook_active === true,
    cwd: input.cwd,
  }),

  /** The thread's name from Codex's own session index (<CODEX_HOME>/session_index.jsonl); undefined when it has none. */
  sessionTitle: (input, { env, home } = {}) => codexSessionName({ sessionId: input.session_id, env, home }),

  // The agent's shell as Codex sets it (any CODEX_* but CODEX_HOME marks Codex), so the account resolves like `relo work`.
  harnessEnv: (env) => (descriptor.detect(env) ? env : { ...env, CODEX_HOOK: "1" }),

  // No local roles at the levels offered, so nothing to render.
  render: () => undefined,

  install: Object.freeze({
    format: "json-hooks-map",
    global: (probe) => harnessPath(descriptor, descriptor.hooks.global, probe),
    project: () => undefined,
    levels: HOOK_LEVELS,
    recommended: "presence",
    sending: Object.freeze(["presence"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
    /** What the owner does once after setup writes or changes these hooks (Codex skips untrusted ones). */
    trust: "In Codex, type /hooks and trust Relo's hooks: Codex runs new or changed hooks only after you do.",
  }),
});
