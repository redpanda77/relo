// OpenCode adapter. Docs: opencode.ai/docs/plugins. OpenCode has no command hooks: Relo's plugin (plugin.js,
// installed as plugins/relo.js) maps OpenCode's events onto the `relo hook` commands that relo-hooks.json lists,
// the same `hooks.<Event>[].hooks[]` shape as Claude Code. Its stdin JSON carries only hook_event_name,
// session_id (the root session), agent_id (a subagent's child session), tool_id (a tool call), source and cwd.
// Event names are OpenCode's own, plus subagent.created and subagent.idle for child sessions.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPath } from "../../paths.mjs";
import descriptor from "./descriptor.mjs";

// presence: the observed events, plus the continuity roles (the open work as context at each prompt and after a
// compaction, and a stale-card note carried into the next turn), as Claude Code's presence includes its reminders.
// approvals: presence, plus OpenCode's permission prompts relayed to the owner's phone (ADR 0008).
const HOOK_LEVELS = Object.freeze(["off", "presence", "approvals"]);
const PRESENCE = Object.freeze({
  "session.created": ["start", "restore"], "chat.message": ["prompt", "turn"], "tool.execute.before": ["tool-start"],
  "tool.execute.after": ["tool-end"], "permission.asked": ["wait"], "subagent.created": ["subagent-start"],
  "subagent.idle": ["subagent-stop"], "session.compacted": ["compact", "restore"], "session.idle": ["stop", "remind"],
  // Esc publishes session.error (MessageAbortedError) and session.idle in either order; any error ends the turn, and stop
  // is idempotent. session.busy (a busy session.status) is the turn running again.
  "session.error": ["stop"], "session.busy": ["prompt"], "session.deleted": ["end"],
});
// Not async in the plugin: it waits for the owner's answer (APPROVAL_WAIT_SECONDS in harness/core/approve.mjs).
const APPROVALS = Object.freeze({ "permission.request": ["permission"] });
const EVENT_ORDER = Object.freeze([...Object.keys(PRESENCE), ...Object.keys(APPROVALS)]);
const ROLES = new Set(["restore", "turn", "remind", "permission"]);

function wantedEntries(level) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  if (level === "off") return {};
  const sets = level === "approvals" ? { ...PRESENCE, ...APPROVALS } : PRESENCE;
  return Object.fromEntries(Object.entries(sets).map(([event, commands]) => [event, [{ hooks: commands.map((command) =>
    ({ type: "command", command: `relo hook ${command} --agent opencode`, timeout: command === "permission" ? 330 : 5 })) }]]));
}

/** What OpenCode is about to run, in the shape the approvals role describes (approve.mjs describeRequest). */
function permissionTool(action, resources) {
  const first = resources[0] ?? "";
  switch (action) {
    case "shell": return { tool: "Bash", input: { command: resources.join("\n") } };
    case "edit": return { tool: "Edit", input: { file_path: first } };
    case "write": return { tool: "Write", input: { file_path: first } };
    case "read": return { tool: "Read", input: { file_path: first } };
    case "webfetch": return { tool: "WebFetch", input: { url: first } };
    default: return { tool: action, input: {} };
  }
}

export default Object.freeze({
  id: descriptor.id,
  label: descriptor.label,
  aliases: descriptor.aliases,
  /** Whether a process command line is OpenCode itself (the liveness check resolves a hook's parent to it). */
  harnessProcess: (command) => descriptor.processPattern.test(String(command)),
  // The observed event each native event is (the first command of its presence set); roles are named on the command line.
  events: Object.freeze(Object.fromEntries(Object.entries(PRESENCE).map(([event, commands]) => [event, commands[0].replace("-", "_")]))),

  identity: (input) => ({ id: input.session_id, agent: input.agent_id, toolKey: input.tool_id, source: input.source, cwd: input.cwd }),

  /** The session's title as OpenCode named it (the plugin passes it); it leaves the computer only sealed for the phones. */
  sessionTitle: (input) => (typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : undefined),

  harnessEnv: (env) => (env.OPENCODE === "1" ? env : { ...env, OPENCODE: "1" }),

  /** A role's context, for the plugin to add to the session's system text (OpenCode's session "context" hook). */
  render: ({ role, context }) => (ROLES.has(role) && typeof context === "string" && context ? { context } : undefined),

  /**
   * OpenCode's permission prompt (the approvals level only): the one place this adapter reads what is about to run,
   * because the owner cannot decide what they cannot see. It leaves this computer only inside the sealed question
   * the session's own `relo ask` sends, never in a phase snapshot.
   */
  permissionRequest: (input) => {
    const resources = Array.isArray(input.resources) ? input.resources.filter((value) => typeof value === "string") : [];
    return { session: input.session_id, ...permissionTool(typeof input.action === "string" ? input.action : "", resources),
      cwd: typeof input.cwd === "string" ? input.cwd : undefined };
  },

  /** The environment a child `relo` needs to act as this session (what OpenCode's shell tool sets). */
  sessionEnv: (env, session) => ({ ...env, OPENCODE: "1", [descriptor.sessionVariable]: session }),

  /** The owner's decision, for the plugin to answer OpenCode with (permission.reply "once" or "reject"). */
  renderDecision: ({ behavior }) => ({ decision: behavior === "allow" ? "allow" : "deny" }),

  install: Object.freeze({
    format: "json-hooks-map",
    global: (probe) => harnessPath(descriptor, descriptor.hooks.global, probe),
    project: () => undefined,
    levels: HOOK_LEVELS,
    recommended: "presence",
    sending: Object.freeze(["presence", "approvals"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
    /** The plugin that runs the hooks file's commands: written with any level but off, deleted with off. */
    runner: (settingsPath) => ({
      path: join(dirname(settingsPath), "plugins", "relo.js"),
      // OpenCode's background service has its own PATH (not the shell's), so the plugin runs this CLI by absolute path.
      content: ({ nodePath, entrypoint } = {}) => {
        const text = readFileSync(new URL("./plugin.js", import.meta.url), "utf8");
        // Always injected: without a LAUNCH the plugin would have nothing to run. Defaults are this running CLI.
        nodePath ||= process.execPath;
        entrypoint ||= fileURLToPath(new URL("../../../../bin/relo.mjs", import.meta.url));
        return text.replace("const LAUNCH = null;", `const LAUNCH = ${JSON.stringify({ node: nodePath, script: entrypoint })};`);
      },
    }),
  }),
});
