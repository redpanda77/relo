// Hook levels for Claude Code (plan 05 §3.1): off | reminders | presence. `wantedEntries(level)` is the exact
// set of Relo hook groups per settings event; the installer reconciles a settings file to exactly this set.
// Every command starts with `relo hook `: that prefix is how Relo recognizes its own entries.
export const HOOK_LEVELS = Object.freeze(["off", "reminders", "presence"]);

/** Notification types that block on the owner (a permission or an input prompt); others are not a wait. */
export const WAITING_NOTIFICATIONS = Object.freeze(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

const cmd = (role, extra = {}) => ({ type: "command", command: `relo hook ${role}`, ...extra });

const REMINDERS = {
  SessionStart: [{ hooks: [cmd("restore", { timeout: 5 })] }],
  UserPromptSubmit: [{ hooks: [cmd("turn", { async: true })] }],
  PreToolUse: [
    { matcher: "Bash", hooks: [cmd("guard", { if: "Bash(relo *)", timeout: 5 })] },
    { matcher: "mcp__relo__.*", hooks: [cmd("guard", { timeout: 5 })] },
  ],
  PostToolUse: [{ matcher: "Bash", hooks: [cmd("await", { if: "Bash(relo ask *)", asyncRewake: true, timeout: 28800 })] }],
  Stop: [{ hooks: [cmd("remind", { timeout: 5 })] }],
  SessionEnd: [{ hooks: [cmd("release", { timeout: 2 })] }],
};

// Presence feeds the local state machine; only phase transitions leave the computer. Every entry is
// async (the hook returns at once anyway); SessionEnd is synchronous with a short ceiling because the
// harness process is exiting. PreToolUse is limited to the tools that run long (shell, subagents).
const PRESENCE = {
  SessionStart: [{ hooks: [cmd("start", { async: true })] }],
  UserPromptSubmit: [{ hooks: [cmd("prompt", { async: true })] }],
  PreToolUse: [{ matcher: "Bash|Agent|Task", hooks: [cmd("tool-start", { async: true })] }],
  PostToolUse: [{ hooks: [cmd("tool-end", { async: true })] }],
  Notification: [{ matcher: WAITING_NOTIFICATIONS.join("|"), hooks: [cmd("wait", { async: true })] }],
  SubagentStart: [{ hooks: [cmd("subagent-start", { async: true })] }],
  SubagentStop: [{ hooks: [cmd("subagent-stop", { async: true })] }],
  PreCompact: [{ hooks: [cmd("compact", { async: true })] }],
  Stop: [{ hooks: [cmd("stop", { async: true })] }],
  SessionEnd: [{ hooks: [cmd("end", { timeout: 3 })] }],
};

export const EVENT_ORDER = Object.freeze(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification",
  "SubagentStart", "SubagentStop", "PreCompact", "Stop", "SessionEnd"]);

/** { EventName: [group, …] } for a level; a fresh copy each call. */
export function wantedEntries(level) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  const out = {};
  const sets = level === "off" ? [] : level === "reminders" ? [REMINDERS] : [REMINDERS, PRESENCE];
  for (const event of EVENT_ORDER) {
    const groups = sets.flatMap((set) => set[event] ?? []);
    if (groups.length > 0) out[event] = structuredClone(groups);
  }
  return out;
}
