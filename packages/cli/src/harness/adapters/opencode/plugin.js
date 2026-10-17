// Relo's OpenCode plugin: written by `relo setup --level guide --agent opencode` into OpenCode's plugins
// folder; `relo setup --level track` and `relo uninstall` delete it. Do not edit this copy.
//
// OpenCode has no command hooks, so this plugin is the bridge: it turns OpenCode's events into the `relo hook`
// commands that relo-hooks.json (beside this folder, managed by relo setup) lists per event, one at a time and in
// order. Each command gets one small JSON object on stdin: the hook event, the session id, the subagent's session id
// inside a subagent, a tool call id, the working directory and the session's title (which relo seals for the phones,
// as it does Claude Code's). Prompts, messages, tool names, arguments and output are never read or passed on. A failing
// or missing relo never affects OpenCode.
//
// One file for both plugin systems: OpenCode 1 calls `server` and its event hooks; OpenCode 2 (whose local plugins
// must default-export { id, setup }) calls `setup` and reads its event stream (shapes captured from opencode 2.0.31).
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOOKS_FILE = fileURLToPath(new URL("../relo-hooks.json", import.meta.url));
// The node and relo.mjs that installed this plugin (relo setup writes them; --refresh after either moves). OpenCode's
// background service does not have the shell's PATH, so `relo` is not looked up there.
const LAUNCH = null;
const TIMEOUT_MS = 5_000;
// The approvals role waits for the owner's answer (harness/core/approve.mjs: 300 s), a little under this.
const PERMISSION_TIMEOUT_MS = 330_000;
const MAX_SESSIONS = 512;
// Roles whose output ({ context }) becomes part of the session's system text; the others print nothing here.
const CONTEXT_ROLES = new Set(["turn", "restore", "remind"]);
// How long a model request waits for the context of the prompt it answers (the turn role takes ~50 ms).
const CONTEXT_WAIT_MS = 1_500;

let cached = { mtime: -1, hooks: {} };

/** The commands for one event, re-read whenever relo setup rewrites the file. */
function commandsFor(event) {
  try {
    const mtime = statSync(HOOKS_FILE).mtimeMs;
    if (mtime !== cached.mtime) cached = { mtime, hooks: JSON.parse(readFileSync(HOOKS_FILE, "utf8"))?.hooks ?? {} };
  } catch {
    cached = { mtime: -1, hooks: {} };
  }
  const groups = Array.isArray(cached.hooks[event]) ? cached.hooks[event] : [];
  return groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .filter((hook) => hook?.type === "command" && typeof hook.command === "string" && hook.command.startsWith("relo hook "))
    .map((hook) => hook.command);
}

/** The role a command runs: `relo hook <role> --agent opencode`. */
const roleOf = (command) => command.split(" ").filter(Boolean)[2];

/** The last JSON object a command printed, or undefined. */
function lastObject(text) {
  for (const line of String(text).trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch { /* not JSON */ }
  }
  return undefined;
}

/** Runs one command with `input` on stdin; resolves with what it printed. `track(child)` can stop it early. */
function runCommand(command, input, { timeoutMs = TIMEOUT_MS, track } = {}) {
  return new Promise((resolve) => {
    let child;
    let output = "";
    try {
      // Commands are `relo hook <event> --agent opencode` (commandsFor checks the prefix): plain words, no shell needed.
      const words = command.split(" ").filter(Boolean);
      child = LAUNCH
        ? spawn(LAUNCH.node, [LAUNCH.script, ...words.slice(1)], { stdio: ["pipe", "pipe", "ignore"], env: process.env })
        : spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    } catch {
      resolve("");
      return;
    }
    track?.(child);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(output); }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (output.length < 64_000) output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(output); });
    child.on("close", () => { clearTimeout(timer); resolve(output); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * The bridge for one OpenCode server: native events in, `relo hook` commands out, one at a time and in order.
 * `lookupParent(id)` asks OpenCode for a session's parent when the plugin did not see the session created.
 */
function bridge({ directoryOf, lookupParent }) {
  // Child sessions (subagents) roll up into their root session: child id → parent id; null for a root session.
  const parents = new Map();
  // Each session's title (OpenCode names it after the first prompt): passed on so the phone shows it, sealed.
  const titles = new Map();
  // Root session → { turn, restore, remind }: what the continuity roles said, added to its system text.
  const contexts = new Map();
  let queue = Promise.resolve();

  const remember = (id, parent) => {
    if (typeof id !== "string" || !id) return;
    parents.set(id, typeof parent === "string" && parent ? parent : null);
    if (parents.size > MAX_SESSIONS) parents.delete(parents.keys().next().value);
  };

  async function parentOf(id) {
    if (!parents.has(id)) {
      let parent;
      try { parent = await lookupParent(id); } catch { parent = undefined; }
      remember(id, parent);
    }
    return parents.get(id) ?? null;
  }

  /** The root session and, inside a subagent, the subagent's own session. */
  async function lineage(id) {
    let root = id;
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = await parentOf(root);
      if (!parent) break;
      root = parent;
    }
    return root === id ? { session_id: id } : { session_id: root, agent_id: id };
  }

  /** Queues one event; `inChild` is its name when the session turns out to be a subagent's. */
  function send(event, sessionID, extra = {}, inChild = event) {
    if (typeof sessionID !== "string" || !sessionID) return;
    queue = queue.then(async () => {
      const ids = await lineage(sessionID);
      const name = ids.agent_id ? inChild : event;
      const commands = commandsFor(name);
      if (commands.length === 0) return;
      const cwd = directoryOf(ids.session_id);
      const title = titles.get(ids.session_id);
      const input = { hook_event_name: name, ...ids, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}), ...(ids.agent_id ? {} : extra) };
      for (const command of commands) {
        const role = roleOf(command);
        if (role === "permission") continue;
        const output = await runCommand(command, input);
        if (CONTEXT_ROLES.has(role) && !ids.agent_id) rememberContext(ids.session_id, role, lastObject(output)?.context);
      }
    }).catch(() => {});
  }

  /** A role's context for a root session: a prompt's turn replaces the last compaction's restore. */
  function rememberContext(id, role, text) {
    const current = { ...(contexts.get(id) ?? {}) };
    if (role === "turn") delete current.restore;
    if (typeof text === "string" && text.trim()) current[role] = text.trim().slice(0, 2_000);
    else delete current[role];
    contexts.set(id, current);
    if (contexts.size > MAX_SESSIONS) contexts.delete(contexts.keys().next().value);
  }

  /** The system text for a model request of `id`: none for a subagent, else its open work's context, once settled. */
  async function contextFor(id) {
    if (typeof id !== "string" || parents.get(id)) return undefined;
    await Promise.race([queue, new Promise((resolve) => setTimeout(resolve, CONTEXT_WAIT_MS))]);
    const current = contexts.get(id) ?? {};
    const parts = [current.restore, current.turn, current.remind].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  // OpenCode is waiting on the owner (a permission prompt): request id → the running approvals command.
  const asking = new Map();

  /**
   * The approvals level: the owner is asked on the phone too; the first answer wins. `answer(reply)` tells OpenCode
   * ("once" or "reject"); an answer in OpenCode first stops the command, which withdraws the question.
   */
  async function askOwner(request, answer) {
    const commands = commandsFor("permission.request").filter((command) => roleOf(command) === "permission");
    if (commands.length === 0 || typeof request.sessionID !== "string" || typeof request.id !== "string") return;
    const ids = await lineage(request.sessionID);
    const cwd = directoryOf(ids.session_id);
    const input = { hook_event_name: "permission.request", ...ids, ...(cwd ? { cwd } : {}), request_id: request.id,
      action: request.action, resources: Array.isArray(request.resources) ? request.resources : [] };
    const output = await runCommand(commands[0], input, { timeoutMs: PERMISSION_TIMEOUT_MS, track: (child) => asking.set(request.id, child) });
    const decided = asking.has(request.id);
    asking.delete(request.id);
    const decision = lastObject(output)?.decision;
    if (decided && (decision === "allow" || decision === "deny")) await answer(decision === "allow" ? "once" : "reject");
  }

  /** OpenCode's own prompt was answered: the phone's question is withdrawn. */
  function answered(requestID) {
    const child = asking.get(requestID);
    asking.delete(requestID);
    try { child?.kill("SIGTERM"); } catch { /* gone */ }
  }

  const titled = (id, title) => {
    if (typeof id !== "string" || typeof title !== "string" || !title.trim()) return;
    titles.set(id, title.trim().slice(0, 200));
    if (titles.size > MAX_SESSIONS) titles.delete(titles.keys().next().value);
  };

  return { remember, titled, has: (id) => parents.has(id), isChild: (id) => Boolean(parents.get(id)), send, contextFor, askOwner, answered };
}

/** OpenCode 1: event hooks (`properties` on events; chat.message and tool hooks with sessionID and callID). */
async function server({ client, directory }) {
  const relo = bridge({ directoryOf: () => directory, lookupParent: async (id) => {
    const found = await client.session.get({ path: { id } });
    return (found?.data ?? found)?.parentID;
  } });
  return {
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      switch (event?.type) {
        case "session.created": {
          const info = properties.info ?? {};
          relo.remember(info.id, info.parentID);
          relo.titled(info.id, info.title);
          relo.send("session.created", info.id, { source: "startup" }, "subagent.created");
          break;
        }
        case "session.updated":
          if (properties.info?.id && !relo.has(properties.info.id)) relo.remember(properties.info.id, properties.info.parentID);
          relo.titled(properties.info?.id, properties.info?.title);
          break;
        case "session.idle":
          relo.send("session.idle", properties.sessionID, {}, "subagent.idle");
          break;
        case "session.status":
          if (properties.status?.type === "idle") relo.send("session.idle", properties.sessionID, {}, "subagent.idle");
          break;
        case "session.deleted":
          relo.send("session.deleted", properties.info?.id, {}, "subagent.idle");
          break;
        case "session.compacted":
          relo.send("session.compacted", properties.sessionID);
          break;
        case "permission.asked":
        case "permission.updated":
          relo.send("permission.asked", properties.sessionID);
          break;
        default:
          break;
      }
    },
    "chat.message": async (input) => { relo.send("chat.message", input?.sessionID); },
    "experimental.chat.system.transform": async (input, output) => {
      const text = await relo.contextFor(input?.sessionID);
      if (text && Array.isArray(output?.system)) output.system.push(text);
    },
    "tool.execute.before": async (input) => { relo.send("tool.execute.before", input?.sessionID, { tool_id: input?.callID }); },
    "tool.execute.after": async (input) => { relo.send("tool.execute.after", input?.sessionID, { tool_id: input?.callID }); },
  };
}

/** OpenCode 2's event names (`data` on events) onto the bridge's. Anything else is not read. */
function onEvent(relo, event, answer) {
  const data = event?.data ?? {};
  const type = String(event?.type ?? "");
  if (type === "session.created") {
    relo.remember(data.sessionID, data.parentID);
    relo.titled(data.sessionID, data.title);
    relo.send("session.created", data.sessionID, { source: "startup" }, "subagent.created");
  } else if (type === "session.renamed") {
    relo.titled(data.sessionID, data.title);
  } else if (type === "session.inbox.enqueued") {
    if (data.item?.type === "user") relo.send("chat.message", data.sessionID);
  } else if (type === "session.execution.started") {
    relo.send("chat.message", data.sessionID);
  } else if (type.startsWith("session.execution.")) {
    relo.send("session.idle", data.sessionID, {}, "subagent.idle");
  } else if (type === "session.tool.called") {
    relo.send("tool.execute.before", data.sessionID, { tool_id: data.id });
  } else if (type === "session.tool.success" || type === "session.tool.failed") {
    relo.send("tool.execute.after", data.sessionID, { tool_id: data.id });
  } else if (type === "session.tool.progress") {
    // A subagent tool names its child session as it starts.
    const child = data.metadata?.sessionID;
    if (typeof child === "string" && child !== data.sessionID && !relo.has(child)) relo.remember(child, data.sessionID);
  } else if (type === "permission.replied") {
    relo.answered(data.requestID);
  } else if (type.includes("permission") && /ask|request/u.test(type)) {
    relo.send("permission.asked", data.sessionID);
    if (answer) void relo.askOwner(data, (reply) => answer({ sessionID: data.sessionID, requestID: data.id, reply })).catch(() => {});
  } else if (type === "session.compacted" || type === "session.compaction.ended") {
    relo.send("session.compacted", data.sessionID);
  } else if (type === "session.deleted" || type === "session.removed") {
    relo.send("session.deleted", data.sessionID ?? data.info?.id, {}, "subagent.idle");
  }
}

// OpenCode 2 calls setup once per location (each folder it opens), and every subscription receives every event of the
// process: one subscription serves them all, and an event is handled once (by its id).
let listening = false;

/** OpenCode 2: the process's event stream; each session's folder comes from its own events. */
async function setup(context) {
  if (listening) return;
  listening = true;
  const folders = new Map();
  const handled = new Set();
  const relo = bridge({
    directoryOf: (id) => folders.get(id) ?? context.location?.directory,
    lookupParent: async (id) => (await context.session.get({ sessionID: id }))?.parentID,
  });
  // The session's open work as system text for each model request (turn, restore, remind roles).
  await context.session?.hook?.("context", async (request) => {
    const text = await relo.contextFor(request?.sessionID);
    if (text && Array.isArray(request?.system)) request.system.push({ type: "text", text });
  });
  const answer = typeof context.permission?.reply === "function"
    ? async (reply) => { try { await context.permission.reply(reply); } catch { /* answered meanwhile */ } } : undefined;
  (async () => {
    for await (const event of context.event.subscribe("session.created")) {
      if (typeof event?.id === "string") {
        if (handled.has(event.id)) continue;
        handled.add(event.id);
        if (handled.size > MAX_SESSIONS * 8) handled.delete(handled.values().next().value);
      }
      const id = event?.data?.sessionID;
      const folder = event?.location?.directory ?? event?.data?.location?.directory;
      if (typeof id === "string" && typeof folder === "string" && !folders.has(id)) {
        folders.set(id, folder);
        if (folders.size > MAX_SESSIONS) folders.delete(folders.keys().next().value);
      }
      onEvent(relo, event, answer);
    }
  })().catch(() => { listening = false; });
}

export default { id: "relo", setup, server };
