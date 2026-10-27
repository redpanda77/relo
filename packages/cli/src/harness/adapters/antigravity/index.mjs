// Antigravity adapter. Docs: antigravity.google/docs/hooks. Hooks live in ~/.gemini/config/hooks.json as named
// hooks, { "<name>": { Event: [...] } }: tool events hold matcher groups, the others plain handlers (its
// jsonhook.ToolHookGroup and HookHandler, checked in language_server 2.26), timeouts in seconds. Relo's are one
// named hook, "relo". Stdin JSON is camelCase with no event name: conversationId (the id the agent's shell has as
// ANTIGRAVITY_CONVERSATION_ID) and workspacePaths, so each command names its event. Antigravity has no session end
// and no waiting event; a tool hook must answer with a decision, so presence uses only SessionStart, PreInvocation
// (each model call: the turn is working) and Stop (the loop ended). Sets: off and presence.
// No network here: adapters map events and render outcomes; the core owns state and transport.
import { harnessPath } from "../../paths.mjs";
import descriptor from "./descriptor.mjs";

const HOOK_LEVELS = Object.freeze(["off", "presence"]);
const EVENT_ORDER = Object.freeze(["SessionStart", "PreInvocation", "Stop"]);
const COMMANDS = { SessionStart: "start", PreInvocation: "prompt", Stop: "stop" };

function wantedEntries(level) {
  if (!HOOK_LEVELS.includes(level)) throw new Error(`unknown hook level ${level}`);
  if (level === "off") return {};
  return Object.fromEntries(EVENT_ORDER.map((event) => [event,
    [{ hooks: [{ type: "command", command: `relo hook ${COMMANDS[event]} --agent antigravity`, timeout: 5 }] }]]));
}

export default Object.freeze({
  id: descriptor.id,
  label: descriptor.label,
  aliases: descriptor.aliases,
  // No event name on stdin: the command line's (`relo hook stop`) is the event.
  events: Object.freeze({}),

  // A request is the first model call of a run (each later call in the run is the same turn), and a run that stops
  // with background commands still going is not a stopped turn.
  accept: (event, input) => (event !== "prompt" || !(input.invocationNum > 0)) && (event !== "stop" || input.fullyIdle !== false),

  identity: (input) => ({
    id: input.conversationId,
    cwd: Array.isArray(input.workspacePaths) ? input.workspacePaths.find((path) => typeof path === "string") : undefined,
  }),

  harnessEnv: (env) => (descriptor.detect(env) ? env : { ...env, ANTIGRAVITY_AGENT: "1" }),

  // No local roles at the levels offered, so nothing to render.
  render: () => undefined,

  install: Object.freeze({
    format: "json-hooks-map",
    named: Object.freeze({ key: "relo", inline: EVENT_ORDER }),
    global: (probe) => harnessPath(descriptor, descriptor.hooks.global, probe),
    project: () => undefined,
    levels: HOOK_LEVELS,
    recommended: "presence",
    sending: Object.freeze(["presence"]),
    eventOrder: EVENT_ORDER,
    entries: wantedEntries,
  }),
});
