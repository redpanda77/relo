// Gemini CLI adapter (HA.2). Docs: geminicli.com/docs/hooks, geminicli.com/docs/hooks/reference.
// Same settings shape as Claude Code (`hooks.<Event>[].hooks[]`) with timeouts in milliseconds; stdin JSON
// carries session_id, hook_event_name, cwd; source on SessionStart; notification_type on Notification.
// No subagent or tool ids are documented. Sets: off and presence.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { harnessPath, projectPath } from "../../paths.mjs";
import { reloCommand } from "../../core/launch.mjs";
import descriptor from "./descriptor.mjs";

const HOOK_LEVELS = Object.freeze(["off", "presence"]);
const WAITING_NOTIFICATIONS = Object.freeze(["ToolPermission"]);
const EVENT_ORDER = Object.freeze(["SessionStart", "BeforeAgent", "AfterTool", "Notification", "PreCompress", "AfterAgent", "SessionEnd"]);
const COMMANDS = { SessionStart: "start", BeforeAgent: "prompt", AfterTool: "tool-end", Notification: "wait",
  PreCompress: "compact", AfterAgent: "stop", SessionEnd: "end" };

function wantedEntries(level, launch) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  if (level === "off") return {};
  return Object.fromEntries(EVENT_ORDER.map((event) => [event,
    [{ hooks: [{ type: "command", command: reloCommand(`hook ${COMMANDS[event]} --agent gemini`, launch), timeout: 5_000 }] }]]));
}

export default Object.freeze({
  id: descriptor.id,
  label: descriptor.label,
  aliases: descriptor.aliases,
  events: Object.freeze({
    SessionStart: "start",
    BeforeAgent: "prompt",
    BeforeTool: "tool_start",
    AfterTool: "tool_end",
    Notification: "wait",
    AfterAgent: "stop",
    SessionEnd: "end",
    PreCompress: "compact",
  }),

  accept: (event, input) => event !== "wait" || WAITING_NOTIFICATIONS.includes(input.notification_type),

  identity: (input) => ({ id: input.session_id, source: input.source, cwd: input.cwd }),

  harnessEnv: (env) => (env.GEMINI_CLI === "1" ? env : { ...env, GEMINI_CLI: "1" }),

  // No local roles at the levels offered, so nothing to render.
  render: () => undefined,

  install: Object.freeze({
    format: "json-hooks-map",
    global: (probe) => harnessPath(descriptor, descriptor.hooks.global, probe),
    project: (probe) => projectPath(descriptor.hooks.project, probe),
    levels: HOOK_LEVELS,
    recommended: "presence",
    sending: Object.freeze(["presence"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
  }),
});
