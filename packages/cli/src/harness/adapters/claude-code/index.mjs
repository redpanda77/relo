// Claude Code adapter (HA.2). Docs: code.claude.com/docs/en/hooks, code.claude.com/docs/en/settings.
// Stdin JSON carries session_id, hook_event_name, cwd, transcript_path; notification_type on
// Notification; tool_use_id on tool events; source on SessionStart; stop_hook_active on Stop; agent_id
// on every event fired inside a subagent (which shares its parent's session_id, so a subagent is never a
// session of its own). This adapter reads only the fields below: prompts, tool names, tool input and
// output, messages and transcript paths are never read.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { join, resolve } from "node:path";
import { repositoryRoot } from "../../../setup.mjs";
import { claudeSessionName } from "../../../agent/session-name.mjs";
import { EVENT_ORDER, HOOK_LEVELS, WAITING_NOTIFICATIONS, wantedEntries } from "./levels.mjs";

const ROLE_EVENTS = { remind: "Stop", restore: "SessionStart" };

export default Object.freeze({
  id: "claude-code",
  label: "Claude Code",
  aliases: ["claude"],
  events: Object.freeze({
    SessionStart: "start",
    UserPromptSubmit: "prompt",
    PreToolUse: "tool_start",
    PostToolUse: "tool_end",
    Notification: "wait",
    Stop: "stop",
    SessionEnd: "end",
    SubagentStart: "subagent_start",
    SubagentStop: "subagent_stop",
    PreCompact: "compact",
  }),

  /** Only a prompt that blocks on the owner is a wait (the installed matcher filters too). */
  accept: (event, input) => event !== "wait" || WAITING_NOTIFICATIONS.includes(input.notification_type),

  /**
   * The session's human name (the title the owner or Claude gave it), read locally from Claude Code's own
   * files; undefined when there is none. It leaves the computer only sealed for the phones.
   */
  sessionTitle: (input, { env, home } = {}) => claudeSessionName({ sessionId: input.session_id, env, home, cwd: input.cwd }),

  identity: (input) => ({
    id: input.session_id,
    agent: input.agent_id,
    toolKey: input.tool_use_id,
    source: input.source,
    stopActive: input.stop_hook_active === true,
    cwd: input.cwd,
  }),

  /** The agent's shell environment as Claude Code sets it, so the account resolves like `relo work`. */
  harnessEnv: (env) => (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT ? env : { ...env, CLAUDECODE: "1" }),

  /** Neutral role outcome → Claude Code hook output: additionalContext only, never a decision. */
  render: ({ role, context }) => {
    const hookEventName = ROLE_EVENTS[role];
    if (!hookEventName || typeof context !== "string" || !context) return undefined;
    return { hookSpecificOutput: { hookEventName, additionalContext: context } };
  },

  install: Object.freeze({
    format: "json-hooks-map",
    global: ({ env, home }) => join(env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : join(home, ".claude"), "settings.json"),
    project: ({ cwd }) => join(repositoryRoot(cwd), ".claude", "settings.json"),
    levels: HOOK_LEVELS,
    recommended: "reminders",
    // Levels whose hooks send observed snapshots (and so need the harness credential).
    sending: Object.freeze(["presence"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
  }),
});
