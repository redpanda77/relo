// Hook sets for Claude Code (plan 12 §4.7): off | presence | approvals, and each with "+lean" (optimize, plan 12 §4.6:
// the same set plus the subagent model nudge on the Agent and Task tools). `wantedEntries(level)` is the exact
// set of Relo hook groups per settings event; the installer reconciles a settings file to exactly this set.
// Every command starts with `relo hook `: that prefix is how Relo recognizes its own entries.
import { FACTS } from "../../../shared/facts.generated.mjs";
export const HOOK_LEVELS = Object.freeze(["off", "presence", "approvals", "presence+lean", "approvals+lean"]);

/** Notification types that block on the owner (a permission or an input prompt); others are not a wait. */
export const WAITING_NOTIFICATIONS = Object.freeze(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

const cmd = (role, extra = {}) => ({ type: "command", command: `relo hook ${role}`, ...extra });

// The local half of presence (restore, prompt-time context, tool guard, refusal and deliver reminders); it sends
// nothing by itself. It has no set of its own any more: presence is this plus PRESENCE.
const LOCAL = {
  SessionStart: [{ hooks: [cmd("restore", { timeout: 5 })] }],
  // Synchronous: the prompt-time decision is context for the agent, which an async hook cannot add (one local file read).
  UserPromptSubmit: [{ hooks: [cmd("turn", { timeout: 5 })] }],
  PreToolUse: [
    { matcher: "Bash", hooks: [cmd("guard", { if: "Bash(relo *)", timeout: 5 })] },
    { matcher: "mcp__relo__.*", hooks: [cmd("guard", { timeout: 5 })] },
    // Before an edit: the card checked (no card yet, a delivered round, a step left behind); one local file read.
    { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [cmd("guard", { timeout: 5 })] },
  ],
  PostToolUse: [{ matcher: "Bash", hooks: [cmd("await", { if: "Bash(relo ask *)", asyncRewake: true, timeout: FACTS.card.maxSeconds })] }],
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

// Approvals (ADR 0008, "The approvals exception"): when Claude Code is about to ask for permission, the hook asks the
// owner on the phone and the Dashboard through the session's own `relo ask`, and answers Claude Code with the
// owner's decision. Claude Code races this hook against its terminal dialog: whichever is answered first wins, and
// no answer here (the owner's phone off, the wait over) leaves the terminal prompt as it was. Not async: the hook
// is the decision. The ceiling is above the wait (APPROVAL_WAIT_SECONDS in harness/core/approve.mjs).
const APPROVALS = {
  PermissionRequest: [{ hooks: [cmd("permission", { timeout: 330 })] }],
};

// Optimize only: before a subagent starts, one line of context when the call names no model (harness/core/guard.mjs).
const LEAN = {
  PreToolUse: [{ matcher: "Agent|Task", hooks: [cmd("guard", { timeout: 5 })] }],
};

export const EVENT_ORDER = Object.freeze(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PermissionRequest",
  "SubagentStart", "SubagentStop", "PreCompact", "Stop", "SessionEnd"]);

/** { EventName: [group, …] } for a level; a fresh copy each call. */
export function wantedEntries(level) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  const out = {};
  const base = level.startsWith("approvals") ? [LOCAL, PRESENCE, APPROVALS] : [LOCAL, PRESENCE];
  const sets = level === "off" ? [] : level.endsWith("+lean") ? [...base, LEAN] : base;
  for (const event of EVENT_ORDER) {
    const groups = sets.flatMap((set) => set[event] ?? []);
    if (groups.length > 0) out[event] = structuredClone(groups);
  }
  return out;
}
