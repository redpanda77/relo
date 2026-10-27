// Claude Code adapter (HA.2). Docs: code.claude.com/docs/en/hooks, code.claude.com/docs/en/settings.
// Stdin JSON carries session_id, hook_event_name, cwd, transcript_path; notification_type on
// Notification; tool_use_id on tool events; source on SessionStart; stop_hook_active on Stop; agent_id
// on every event fired inside a subagent (which shares its parent's session_id, so a subagent is never a
// session of its own). This adapter reads only the fields below: prompts, tool input and output, messages
// and transcript paths are never read. The exceptions are the transcript's token usage (contextTokens: a count only) and is `background`, a boolean computed here from the
// tool name and its run_in_background flag; neither leaves this function.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { absolutePath, harnessPath, projectPath } from "../../paths.mjs";
import descriptor from "./descriptor.mjs";
import { claudeContextTokens, claudeInterruptedSince, claudeResolveTitle, claudeSessionName } from "./session-name.mjs";
import { EVENT_ORDER, HOOK_LEVELS, WAITING_NOTIFICATIONS, wantedEntries } from "./levels.mjs";

const ROLE_EVENTS = { remind: "Stop", restore: "SessionStart", turn: "UserPromptSubmit", guard: "PreToolUse" };

// Tools that return at once and keep running, waking the agent when they report: a monitor, a workflow, and
// any tool started with run_in_background except a subagent (SubagentStart/SubagentStop count those).
const BACKGROUND_TOOLS = new Set(["Monitor", "Workflow"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
// Whether a shell command runs a relo command that reports to the owner (work, ask, state, notify, interaction)
// with its reply hidden from the agent: stdout or stderr sent to /dev/null, or piped into another program. `--json`
// output is for programs and may be piped. Quoted text is ignored, so a status like "a | b" is no pipe. Only this
// boolean leaves the adapter; the command itself is never kept.
const LEAD = /^(?:[({!]\s*|(?:if|then|else|do|time)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u;

function reloReplyHidden(command) {
  if (typeof command !== "string" || !command.includes("relo")) return false;
  const bare = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/gu, '""');
  return bare.split(/&&|\|\||;|\n/u).some((part) => {
    const segment = part.trim().replace(LEAD, "");
    if (!/^(?:npx\s+(?:--yes\s+)?)?relo\s+(?:work|ask|state|notify|interaction)\b/u.test(segment) || /\s--json\b/u.test(segment)) return false;
    return /\/dev\/null/u.test(segment) || /\|/u.test(segment);
  });
}

// The tools that change files: the guard checks the card before them.
export const EDIT_TOOLS = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** True for a PostToolUse whose tool keeps running in the background (only this boolean is kept). */
function runsInBackground(input) {
  if (input.hook_event_name !== "PostToolUse" || typeof input.tool_name !== "string") return false;
  if (BACKGROUND_TOOLS.has(input.tool_name)) return true;
  return input.tool_input?.run_in_background === true && !SUBAGENT_TOOLS.has(input.tool_name);
}

export default Object.freeze({
  id: descriptor.id,
  label: descriptor.label,
  aliases: descriptor.aliases,
  /** Records the status line's plan limits for `relo usage`; loaded only when the line carries them. */
  recordUsage: async (input, dependencies) => (await import("./usage-record.mjs")).recordClaudeUsage({ input, dependencies }),
  /** Whether a process command line is Claude Code itself (the liveness check records the nearest such ancestor). */
  harnessProcess: (command) => descriptor.processPattern.test(String(command)),

  events: Object.freeze({
    SessionStart: "start",
    UserPromptSubmit: "prompt",
    PreToolUse: "tool_start",
    PostToolUse: "tool_end",
    PostToolUseFailure: "tool_end",
    Notification: "wait",
    Stop: "stop",
    StopFailure: "stop",
    SessionEnd: "end",
    SubagentStart: "subagent_start",
    SubagentStop: "subagent_stop",
    PreCompact: "compact",
  }),

  /**
   * Stop does not run when the owner interrupts, so the other signals count: a tool failure flagged `is_interrupt` is a
   * stop (not for a subagent's tool), and the idle prompt (~60 s after Claude finished with no input) is an `idle`.
   */
  refine: (event, input) => {
    if (event === "wait" && input.notification_type === "idle_prompt") return "idle";
    if (event === "tool_end" && input.hook_event_name === "PostToolUseFailure" && input.is_interrupt === true && input.agent_id === undefined) return "stop";
    return undefined;
  },

  /** Only a prompt that blocks on the owner is a wait (the installed matcher filters too). */
  accept: (event, input) => event !== "wait" || WAITING_NOTIFICATIONS.includes(input.notification_type),

  /**
   * The terminal session's human name (the title the owner or Claude gave it), read locally from Claude Code's own
   * files (not the Desktop sidebar: resolveTitle adds that); undefined when there is none. It leaves the computer only sealed for the phones.
   */
  sessionTitle: (input, { env, home } = {}) => claudeSessionName({ sessionId: input.session_id, env, home, cwd: input.cwd }),

  /**
   * THE session-title rule, for hooks and relo commands alike: under Claude Desktop the sidebar title, else the title
   * the terminal session has. `titlePath` / `titleMissAt` are what the caller kept from last time; the returned
   * `cache` is what to keep now (local state only). { title?, cache }; synchronous.
   */
  resolveTitle: (input, { env, home, titlePath, titleMissAt, nameCache, now } = {}) =>
    claudeResolveTitle({ sessionId: input.session_id, env, home, cwd: input.cwd, titlePath, titleMissAt, nameCache, now }),

  /**
   * The titles the Claude desktop app shows in its sidebar: Map of session id → { title, cwd? }, read locally and
   * read-only (doctor compares them with sessionTitle). Empty without Desktop. Loaded on demand: hooks never need it
   * (startup-budget.test.mjs).
   */
  sidebarSessions: async ({ home } = {}) => (await import("./desktop-title.mjs")).desktopSessions({ home }),

  /**
   * Tokens in the session's context window, from the tail of its transcript; undefined when unknown. Only the
   * count leaves this function (the status line does not run in the desktop app, hooks do).
   */
  contextTokens: (input) => claudeContextTokens(input.transcript_path),

  /** The session's transcript file (kept in local observed state only, for `interrupted`); undefined when the payload has none. */
  transcriptPath: (input) => absolutePath(input.transcript_path),

  /** Whether the transcript ends in the owner's interrupt, newer than `since` (ms). A boolean; nothing is read into state. */
  interrupted: ({ path, since }) => claudeInterruptedSince(path, since),

  identity: (input) => ({
    id: input.session_id,
    agent: input.agent_id,
    toolKey: input.tool_use_id,
    source: input.source,
    reason: input.hook_event_name === "SessionEnd" ? input.reason : undefined,
    stopActive: input.stop_hook_active === true,
    background: runsInBackground(input),
    cwd: input.cwd,
  }),

  /**
   * A PreToolUse for a subagent call (the Agent tool, once called Task): whether it names a model and whether its
   * agent type fixes one (Relo's own agents, the built-in Explore). Only these booleans leave this function; the
   * prompt and the rest of the tool input are never read.
   */
  subagentCall: (input) => {
    if (input.hook_event_name !== "PreToolUse" || !SUBAGENT_TOOLS.has(input.tool_name)) return undefined;
    const given = input.tool_input;
    const type = typeof given?.subagent_type === "string" ? given.subagent_type : "";
    return { named: typeof given?.model === "string" && given.model.trim() !== "", pinned: type.startsWith("relo-") || type === "Explore" };
  },

  /**
   * A PreToolUse the guard looks at: an edit (only the tool's name is read), or a Bash command that runs relo with its
   * reply hidden from the agent (only that boolean leaves this function; the command is never kept).
   */
  guardCall: (input) => {
    if (input.hook_event_name !== "PreToolUse") return undefined;
    if (EDIT_TOOLS.includes(input.tool_name)) return { edit: true };
    if (input.tool_name === "Bash") return { hiddenReply: reloReplyHidden(input.tool_input?.command) };
    return undefined;
  },

  /** The agent's shell environment as Claude Code sets it, so the account resolves like `relo work`. */
  harnessEnv: (env) => (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT ? env : { ...env, CLAUDECODE: "1" }),

  /**
   * A PermissionRequest (the approvals level only): the one place this adapter reads a tool's name and
   * input, because the owner cannot decide what they cannot see. They leave this computer only inside the
   * sealed question the session's own `relo ask` sends, never in a phase snapshot.
   */
  permissionRequest: (input) => ({
    session: input.session_id,
    tool: typeof input.tool_name === "string" ? input.tool_name : "",
    input: input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input) ? input.tool_input : {},
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
  }),

  /** The environment a child `relo` needs to act as this session (the same variable an agent's shell has). */
  sessionEnv: (env, session) => ({ ...(env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT ? env : { ...env, CLAUDECODE: "1" }), [descriptor.sessionVariable]: session }),

  /** The owner's decision → Claude Code's PermissionRequest output. */
  renderDecision: ({ behavior, message }) => ({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: behavior === "allow" ? { behavior } : { behavior, message, interrupt: false } },
  }),

  /** Neutral role outcome → Claude Code hook output: additionalContext only, never a decision. */
  render: ({ role, context, deny }) => {
    const hookEventName = ROLE_EVENTS[role];
    // The one refusal a guard makes: a relo command whose reply the agent would not read (harness/core/guard.mjs).
    if (role === "guard" && typeof deny === "string" && deny) return { hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: deny } };
    if (!hookEventName || typeof context !== "string" || !context) return undefined;
    return { hookSpecificOutput: { hookEventName, additionalContext: context } };
  },

  install: Object.freeze({
    format: "json-hooks-map",
    global: (probe) => harnessPath(descriptor, descriptor.hooks.global, probe),
    project: (probe) => projectPath(descriptor.hooks.project, probe),
    levels: HOOK_LEVELS,
    recommended: "presence",
    // Levels whose hooks send observed snapshots (and so need the harness credential).
    sending: Object.freeze(["presence", "approvals", "presence+lean", "approvals+lean"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
  }),
});
