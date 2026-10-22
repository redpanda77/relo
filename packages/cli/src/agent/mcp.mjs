// `relo mcp`: a stdio MCP server (JSON-RPC 2.0, one message per line) for harnesses without a shell.
// Every tool runs the same `relo` command the shell would (through run()), so validation, truncation
// notes, identity and the compact result are identical; the only addition is that `ask` waits with
// MCP progress notifications instead of a shell timeout. No runtime dependencies.
//
// Protocol: this server speaks the initialize-handshake revisions of the Model Context Protocol
// (latest 2025-11-25; also 2025-06-18, 2025-03-26, 2024-11-05), negotiated per the spec: the client's
// version is echoed when supported, else the latest. Revision 2026-07-28 replaces the handshake with
// per-request _meta and `server/discover`; this server answers `server/discover` with "method not
// found", which the spec defines as the signal for a dual-era client to fall back to `initialize`.
// stdout carries protocol messages and nothing else; logs go to stderr only when RELO_DEBUG=1.
import { randomBytes } from "node:crypto";
import { ReloApiClient } from "../shared/api-client.mjs";
import { MCP_SESSION_VARIABLE } from "../caller.mjs";
import { HARNESSES } from "../harness/catalog.mjs";
import { OPTIONS } from "../shared/options.mjs";
import { FACTS } from "../shared/facts.mjs";

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PROGRESS_INTERVAL_MS = 15_000;
const QUESTION_SECONDS = 300;

/** The source name for an MCP clientInfo.name: known harnesses get their proper name, others stay as sent. */
export function sourceFromClient(name) {
  const clean = String(name ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim().slice(0, 80);
  if (!clean) return undefined;
  return HARNESSES.find((harness) => harness.mcpClient?.test(clean))?.label ?? clean;
}

const RULES = "Relo shows your work as one live card on the owner's iPhone. ";
const CARD_TEXT = "Never put secrets, tokens, absolute paths, commands or raw output in card text.";

/**
 * Every tool is one registry command (`command`) and a few of its options. An argument is the option of
 * the same name in snake_case (next_step is --next-step); its type and length come from that option
 * (shared/options.mjs), so a tool can never send a flag its command does not take (test/mcp.test.mjs).
 * An argument may instead be the command's positional text (`positional`), a choice between flags
 * (`choice`: value -> flag), or a wait in seconds for a duration option (`seconds`).
 */
const identity = {
  topic: { describe: "The work in the owner's words, e.g. \"Release 0.7.57\" (not a step). Optional: inside a session it defaults to the session's name or the work's goal." },
  project: { describe: "Only if neither the repository nor the folder the server runs in names the project: the project's name." },
};
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOL_SPECS = [
  {
    name: "relo_work_start", title: "Start work", command: "work start", hints: WRITE,
    description: RULES + "Declare this session's work for anything longer than a minute or two (calling it again with the same goal continues it). "
      + "Judgment work: pass `plan` (3-6 named steps) and move on with relo_work_update next_step. A counted job (10 images, 400 rows): pass "
      + "`progress` as \"3/10\". " + CARD_TEXT,
    args: {
      goal: { describe: "The work in the owner's words, e.g. \"Release 0.7.57\". Required unless you pass round or from." },
      spoken_name: { describe: "How Relo for Mac calls the work aloud: 2 to 4 words, a noun phrase, e.g. \"Notch redesign\"." },
      status: { describe: "What is happening now, e.g. \"Building the image\"." },
      round: { describe: "A new request on a goal whose last round you delivered: the request in a few words, e.g. \"Add the dark theme\". Opens the next round of the same goal (goal may then be left out); without plan it carries the unfinished steps." },
      plan: { list: { minItems: 1, maxItems: FACTS.work.planMaxSteps }, describe: "Named steps for judgment work. Nest a step under the one above it by indenting its text two spaces (at most three levels), only when a step cannot be finished in one go." },
      progress: { describe: "Counted job: \"3/10\"." },
      new: { describe: "Park the open work and start this as a separate one." },
      from: { describe: "A waiting handoff's handle (rh_…): take over the work another session handed off, instead of starting one (goal may then be left out)." },
    },
  },
  {
    name: "relo_work_update", title: "Update work", command: "work update", hints: WRITE,
    description: RULES + "Update this session's open work at real milestones, not on every tool call; send only what changed. " + CARD_TEXT,
    args: {
      status: { describe: "What is happening now." },
      spoken_name: { describe: "Rename how Relo for Mac calls the work aloud: 2 to 4 words." },
      progress: { describe: "Counted progress: \"4/10\"." },
      next_step: { describe: "Mark the current step done and move to the next." },
      step: { describe: "Jump to a step by id (s3) or name." },
      plan: { list: {}, describe: "The steps that are left, replacing the remaining plan (indent a step two spaces to nest it under the one above)." },
      add: { list: {}, describe: "Steps to add at the end of the round (indent a step two spaces to nest it under the one above); after puts them after one step." },
      under: { describe: "With add: the id of the step the new steps go under (s3), when a step turns out to need sub-steps." },
      after: { describe: "With add: the id of the step the new steps follow, as its siblings (s3)." },
      detail: { describe: "One or two sentences about the current step." },
      waiting: { describe: "What the work waits on, e.g. \"CI\"." },
      not_waiting: { describe: "The wait is over." },
    },
  },
  {
    name: "relo_work_deliver", title: "Deliver a round", command: "work deliver", hints: WRITE,
    description: RULES + "Deliver this request: close the current round with what it delivered; the owner gets one quiet notification and it is their turn, and the work stays open for a follow-up (relo_work_start with round). Deliver means this request is done; it is refused while top-level steps are open (the owner must act mid-plan: use relo_ask or relo_work_update with waiting); when the work is done and nothing is left, use relo_work_finish (a later follow-up starts a fresh card with relo_work_start and round).",
    args: {
      outcome: { required: true, describe: "What this request delivered, e.g. \"Dark theme added and tested\"." },
      say: { describe: "The line Relo for Mac says aloud after \"<Kind>: <name>.\": what happened and what it means, at most 20 words (a failure: its reason, at most 12), no versions, ids or paths. Without it the CLI cuts your outcome." },
      drop_rest: { describe: "Deliver although top-level steps are still open: they are skipped (a later round without plan carries them)." },
    },
  },
  {
    name: "relo_work_handoff", title: "Hand off work", command: "work handoff", hints: WRITE,
    description: RULES + "Hand this session's open work to a fresh session on this computer when your context is heavy or before /clear: the card goes on, the round stays open, nothing is announced. Returns the handle; the next session continues with relo_work_start and from. This session no longer owns the work.",
    args: {
      next: { required: true, describe: "What the next session should do, in a few words, e.g. \"Wire the CLI verb\"." },
    },
  },
  {
    name: "relo_work_finish", title: "Finish work", command: "work finish", hints: WRITE,
    description: RULES + "End this session's goal honestly when the work is done and nothing is left: say what happened; set failed or dropped when it did not succeed. A later follow-up starts a fresh card (relo_work_start with round). When this request is done but more of the goal is to come, use relo_work_deliver instead.",
    args: {
      outcome: { required: true, describe: "What happened, e.g. \"0.7.57 live on production\"." },
      say: { describe: "The line Relo for Mac says aloud after \"<Kind>: <name>.\": what happened and what it means, at most 20 words (a failure: its reason, at most 12), no versions, ids or paths. Without it the CLI cuts your outcome." },
      failed: { describe: "The work failed." },
      dropped: { describe: "The work was abandoned." },
    },
  },
  {
    name: "relo_work_state", title: "Show work state", command: "state", fixed: ["--sync"], hints: READ,
    description: RULES + "Show this session's open and parked work, as the server has it: goal, status, current step id, rounds and the open round's plan as a tree of steps (id, label, state, detail, children).", args: {},
  },
  {
    name: "relo_ask", title: "Ask the owner", command: "ask", hints: WRITE,
    description: RULES + "Ask the owner an approval or yes/no question on their phone and WAIT for the answer (up to 5 minutes; no shell timeout applies). "
      + "Ask only when the work depends on the answer; one line of at most 120 characters, one exact action, self-contained (the CLI refuses longer). "
      + "Only an `approval` question that returns state `approved` is permission to proceed. A yes/no answer is never permission. "
      + "Denied, no, expired, timeout, canceled or any error all mean NO: do not act. State `timeout` means the question is still open: call relo_interaction_wait with its id.",
    args: {
      question: { positional: true, required: true, describe: "The question, e.g. \"Deploy 0.7.57 to production?\" (at most 120 characters, one line). No secrets or paths." },
      kind: { required: true, choice: { approval: "approval", yes_no: "yes-no" }, describe: "approval: asks permission for one exact action. yes_no: a plain question." },
      timeout_seconds: { seconds: "timeout", max: QUESTION_SECONDS, describe: "How long to wait for the answer (default and maximum 300, the question's life)." },
      ...identity,
    },
  },
  {
    name: "relo_interaction_wait", title: "Keep waiting for an answer", command: "interaction wait", hints: READ,
    description: RULES + "Resume waiting for a question that relo_ask left open (state `timeout`). Same rules: only `approved` from an approval question is permission.",
    args: {
      id: { positional: true, required: true, describe: "The interaction id from relo_ask (int_…)." },
      timeout_seconds: { seconds: "timeout", max: QUESTION_SECONDS, describe: "How long to wait (default and maximum 300)." },
    },
  },
  {
    name: "relo_notify", title: "Send a notification", command: "notify send", hints: WRITE,
    description: RULES + "Send one push notification, rarely: only when no work is open (deliver and finish already notify), for an outcome worth a buzz. Never a question, never progress (use the card). " + CARD_TEXT,
    args: { body: { positional: true, required: true, describe: "The message (what finished, in a sentence or two)." }, title: { describe: "Short title." }, ...identity },
  },
  {
    name: "relo_doctor", title: "Check Relo", command: "doctor", hints: READ,
    description: "Check that Relo is signed in and reachable. Returns {ok:true,ready:true} or the first unmet step in next. Changes nothing; "
      + "do not run it as a preamble to work, only when a Relo tool fails with an auth or no-phone error.",
    args: {},
  },
];

/** The CLI option an argument becomes: next_step -> next-step. */
export const optionOf = (key) => key.replace(/_/gu, "-");

function property(key, arg) {
  const description = arg.describe;
  if (arg.positional) return { type: "string", description };
  if (arg.choice) return { type: "string", enum: Object.keys(arg.choice), description };
  if (arg.seconds) return { type: "integer", minimum: 1, maximum: arg.max, description };
  const option = OPTIONS[optionOf(key)];
  if (arg.list) return { type: "array", items: { type: "string" }, ...arg.list, description };
  if (option.type === "boolean") return { type: "boolean", description };
  return { type: "string", ...(option.maxLength ? { maxLength: option.maxLength } : {}), description };
}

/** The tools/list entries, rendered from the specs. */
export const TOOLS = TOOL_SPECS.map((spec) => {
  const required = Object.entries(spec.args).filter(([, arg]) => arg.required).map(([key]) => key);
  return {
    name: spec.name, title: spec.title, description: spec.description,
    inputSchema: { type: "object", additionalProperties: false, ...(required.length ? { required } : {}),
      properties: Object.fromEntries(Object.entries(spec.args).map(([key, arg]) => [key, property(key, arg)])) },
    annotations: { title: spec.title, ...spec.hints },
  };
});
export { TOOL_SPECS };

// A value that begins with "--" would read as a flag to the CLI's argument parser.
const safe = (value) => String(value).replace(/^-{2,}/u, "–");

/** The relo command line a tool call runs: the command, its positional text, then one flag per argument given. */
export function toolArgv(spec, args) {
  const positional = [];
  const flags = [];
  for (const [key, arg] of Object.entries(spec.args)) {
    const value = args[key];
    if (arg.seconds) { flags.push(`--${arg.seconds}=${value ?? arg.max}s`); continue; }
    if (value === undefined || value === null) continue;
    if (arg.positional) positional.push(safe(value));
    else if (arg.choice) flags.push(`--${arg.choice[value]}`);
    // Items indented to nest are a newline list; plain ones are comma-separated, as ever.
    else if (arg.list) { if (value.length) flags.push(`--${optionOf(key)}=${safe(value.join(value.some((item) => /^\s/u.test(item)) ? "\n" : ","))}`); }
    else if (OPTIONS[optionOf(key)].type === "boolean") { if (value) flags.push(`--${optionOf(key)}`); }
    else flags.push(`--${optionOf(key)}=${safe(value)}`);
  }
  return [...spec.command.split(" "), ...positional, ...(spec.fixed ?? []), "--json", ...flags];
}

function typeOk(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => candidate === "integer" ? Number.isInteger(value)
    : candidate === "array" ? Array.isArray(value) : candidate === "number" ? typeof value === "number" && Number.isFinite(value)
      : typeof value === candidate);
}

/** Checks arguments against a tool's inputSchema; returns a message or undefined. */
export function validateArguments(schema, args) {
  if (args === undefined) args = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  for (const key of schema.required ?? []) if (args[key] === undefined) return `${key} is required`;
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) return `unknown argument ${key}`;
    if (!typeOk(value, property.type)) return `${key} must be ${[].concat(property.type).join(" or ")}`;
    if (property.enum && !property.enum.includes(value)) return `${key} must be one of ${property.enum.join(", ")}`;
    if (typeof value === "number" && property.minimum !== undefined && value < property.minimum) return `${key} must be at least ${property.minimum}`;
    if (typeof value === "number" && property.maximum !== undefined && value > property.maximum) return `${key} must be at most ${property.maximum}`;
    if (Array.isArray(value)) {
      if (property.maxItems !== undefined && value.length > property.maxItems) return `${key} has at most ${property.maxItems} items`;
      if (property.minItems !== undefined && value.length < property.minItems) return `${key} needs at least ${property.minItems} items`;
      if (value.some((item) => typeof item !== "string")) return `${key} must hold strings`;
    }
  }
  return undefined;
}

class Cancelled extends Error {}

/**
 * Wraps a Relo API client so a question's wait runs in ~15 s slices: between slices the call sends an
 * MCP progress notification (when the client gave a progressToken) and notices cancellation at once.
 */
function waitingClient(inner, call) {
  call.client = inner;
  const waitOnce = async (id, seconds) => {
    call.interactionId = id;
    if (call.isClosed()) call.cancel();
    const end = Date.now() + seconds * 1_000;
    for (;;) {
      if (call.cancelled) throw new Cancelled();
      const left = Math.max(0, end - Date.now());
      const slice = Math.max(1, Math.min(Math.ceil(call.intervalMs / 1_000), Math.ceil(left / 1_000)));
      const reply = await Promise.race([inner.waitForInteraction(id, slice), call.cancelSignal]);
      if (call.cancelled) throw new Cancelled();
      const state = reply?.interaction?.state ?? reply?.state ?? reply?.interaction?.status;
      if (state !== "pending" || Date.now() >= end) return reply;
      call.progress(`Waiting for the owner's answer (${Math.max(0, Math.round((end - Date.now()) / 1_000))}s left)`);
    }
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === "waitForInteraction") return waitOnce;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Serves MCP on `input`/`output` until the input ends. `run` executes a relo command line
 * (default: the CLI's own run); `overrides` are the CLI's dependency overrides (tests inject fakes).
 */
export async function serveMcp({ input, output, run, version, env = process.env, overrides = {}, progressIntervalMs = PROGRESS_INTERVAL_MS, now = Date.now, onClose }) {
  const debug = env.RELO_DEBUG === "1" ? (...parts) => process.stderr.write(`relo mcp: ${parts.join(" ")}\n`) : () => {};
  const startedAt = now();
  const state = { clientInfo: undefined, session: undefined };
  let closed = false;
  const inflight = new Map(); // JSON-RPC id -> call
  const running = new Set();

  const send = (message) => { output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const sessionEnv = () => {
    const source = sourceFromClient(state.clientInfo?.name);
    state.session ??= `${state.clientInfo?.name ?? "mcp"}-${startedAt}-${randomBytes(6).toString("hex")}`;
    // One agent session per connection; a harness session id, or an owner's RELO_SESSION outside a harness, wins (detectCaller).
    return { ...env, [MCP_SESSION_VARIABLE]: state.session,
      ...(source && !env.RELO_SOURCE?.trim() ? { RELO_SOURCE: source } : {}) };
  };

  async function callTool(id, params) {
    const tool = TOOLS.find((candidate) => candidate.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const problem = validateArguments(tool.inputSchema, params.arguments);
    if (problem) return reply(id, toolText({ ok: false, error: { code: "USAGE_ERROR", message: `Invalid arguments: ${problem}` } }, true));
    const args = params.arguments ?? {};
    const token = params._meta?.progressToken;
    let ticks = 0;
    let cancelNow;
    const call = {
      cancelled: false, isClosed: () => closed, intervalMs: progressIntervalMs, interactionId: undefined,
      cancelSignal: new Promise((resolve) => { cancelNow = resolve; }),
      cancel() { call.cancelled = true; cancelNow(); },
      progress(message) {
        if (token === undefined) return;
        ticks += 1;
        send({ method: "notifications/progress", params: { progressToken: token, progress: ticks, message } });
      },
    };
    inflight.set(id, call);
    const lines = [];
    const notes = [];
    const baseFactory = overrides.clientFactory ?? ((config) => new ReloApiClient({ ...config, version,
      fetchImpl: overrides.fetchImpl ?? globalThis.fetch }));
    let exitCode;
    try {
      exitCode = await run(toolArgv(TOOL_SPECS.find((spec) => spec.name === tool.name), args), { stdout: (line) => lines.push(line), stderr: (line) => notes.push(line), stdoutIsTTY: false }, {
        ...overrides, env: sessionEnv(), clientFactory: (config) => waitingClient(baseFactory(config), call),
      });
    } catch (error) {
      debug("tool failed", error?.message);
      exitCode = 1;
      lines.push(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Relo failed unexpectedly." } }));
    } finally {
      inflight.delete(id);
    }
    if (call.cancelled) {
      // The client gave up: no response. A question nobody waits for any more must not stay answerable.
      if (tool.name === "relo_ask" && call.interactionId) {
        try { await call.client?.cancelInteraction?.(call.interactionId); } catch { /* best effort */ }
      }
      debug("cancelled", id);
      return undefined;
    }
    const text = lines.join("\n") || JSON.stringify({ ok: exitCode === 0 });
    // Exit 5 is a legitimate answer (denied, no), not a failure of the tool.
    return reply(id, { content: [{ type: "text", text }], isError: !(exitCode === 0 || exitCode === 5) });
  }

  const toolText = (value, isError) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });

  async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return fail(message?.id ?? null, -32600, "Invalid Request");
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null && typeof method === "string";
    if (typeof method !== "string") return undefined; // a response from the client: nothing is outstanding
    if (!isRequest) {
      if (method === "notifications/cancelled") inflight.get(params?.requestId)?.cancel();
      return undefined;
    }
    switch (method) {
      case "initialize": {
        state.clientInfo = params?.clientInfo;
        state.session = undefined;
        const requested = params?.protocolVersion;
        debug("initialize", state.clientInfo?.name, requested);
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "relo", title: "Relo", version },
          instructions: "Relo puts your work on the owner's iPhone. Use the relo_work_* tools for work longer than a couple of minutes, "
            + "relo_ask before risky actions (only an approved approval question is permission), relo_notify rarely for finished outcomes.",
        });
      }
      case "ping": return reply(id, {});
      case "tools/list": return reply(id, { tools: TOOLS });
      case "tools/call": return callTool(id, params);
      default: return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  const onLine = (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return fail(null, -32700, "Parse error"); }
    const task = Promise.resolve(handle(message)).catch((error) => {
      debug("handler error", error?.message);
      if (message?.id !== undefined && message?.id !== null) fail(message.id, -32603, "Internal error");
    }).finally(() => running.delete(task));
    running.add(task);
  };

  await new Promise((resolve) => {
    let buffer = "";
    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onLine(line);
      }
    });
    input.on("end", () => { if (buffer.trim()) onLine(buffer); resolve(); });
    input.on("close", resolve);
    input.on("error", resolve);
  });
  // The client went away: stop waiting on questions, then let in-flight handlers settle.
  // Quick calls still finish and answer; calls that are (or get to be) waiting on a question stop.
  closed = true;
  for (const call of inflight.values()) if (call.interactionId) call.cancel();
  await Promise.allSettled([...running]);
  // What the composition root wants done when the client has gone (cli.mjs: tell whether the harness itself exited). This
  // module knows nothing of harnesses; the callback is the only way it reaches one.
  try { await onClose?.(); } catch { /* the server's exit never fails */ }
}
