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
import { ReloApiClient } from "./api-client.mjs";
import { MCP_SESSION_VARIABLE } from "./caller.mjs";

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const PROGRESS_INTERVAL_MS = 15_000;
const QUESTION_SECONDS = 300;

const SOURCE_NAMES = [
  [/^claude[-_ ]?code/iu, "Claude Code"],
  [/^claude/iu, "Claude"],
  [/^cursor/iu, "Cursor"],
  [/^codex/iu, "Codex"],
  [/^gemini/iu, "Gemini CLI"],
  [/^(vscode|visual studio code|vs ?code)/iu, "VS Code"],
  [/^opencode/iu, "OpenCode"],
];

/** The source name for an MCP clientInfo.name: known harnesses get their proper name, others stay as sent. */
export function sourceFromClient(name) {
  const clean = String(name ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim().slice(0, 80);
  if (!clean) return undefined;
  return SOURCE_NAMES.find(([pattern]) => pattern.test(clean))?.[1] ?? clean;
}

const RULES = "Relo shows your work as one live card on the owner's iPhone. ";
const CARD_TEXT = "Never put secrets, tokens, absolute paths, commands or raw output in card text.";

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const identity = {
  topic: string("The work in the owner's words, e.g. \"Release 0.7.57\" (not a step). Required on the first call of a session; optional afterwards."),
  project: string("Only if the server is not running inside the project's repository: the project or repository name."),
};

export const TOOLS = [
  {
    name: "relo_work_start",
    title: "Start work",
    description: RULES + "Declare this session's work for anything longer than a minute or two (calling it again with the same goal continues it). "
      + "Judgment work: pass `plan` (3-6 named steps) and move on with relo_work_update next_step. A counted job (10 images, 400 rows): pass "
      + "`progress` as \"3/10\". " + CARD_TEXT,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["goal"],
      properties: {
        goal: string("The work in the owner's words, e.g. \"Release 0.7.57\" (120 characters)."),
        status: string("What is happening now, e.g. \"Building the image\" (120 characters)."),
        plan: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30, description: "Named steps for judgment work." },
        progress: string("Counted job: \"3/10\"."),
        new: { type: "boolean", description: "Park the open work and start this as a separate one." },
      },
    },
    annotations: { title: "Start work", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "relo_work_update",
    title: "Update work",
    description: RULES + "Update this session's open work at real milestones, not on every tool call; send only what changed. " + CARD_TEXT,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        status: string("What is happening now (120 characters)."),
        progress: string("Counted progress: \"4/10\"."),
        next_step: { type: "boolean", description: "Mark the current step done and move to the next." },
        step: string("Jump to a step by id (s3) or name."),
        plan: { type: "array", items: { type: "string" }, description: "The steps that are left, replacing the remaining plan." },
        add: { type: "array", items: { type: "string" }, description: "Steps to append." },
        waiting: string("What the work waits on, e.g. \"CI\"."),
        not_waiting: { type: "boolean", description: "The wait is over." },
      },
    },
    annotations: { title: "Update work", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "relo_work_finish",
    title: "Finish work",
    description: RULES + "Finish this session's open work exactly once, honestly: say what happened; set failed or dropped when it did not succeed.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["outcome"],
      properties: {
        outcome: string("What happened, e.g. \"0.7.57 live on production\" (200 characters)."),
        failed: { type: "boolean", description: "The work failed." },
        dropped: { type: "boolean", description: "The work was abandoned." },
      },
    },
    annotations: { title: "Finish work", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "relo_work_state",
    title: "Show work state",
    description: RULES + "Show this session's open and parked work, as the server has it.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { title: "Show work state", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "relo_ask",
    title: "Ask the owner",
    description: RULES + "Ask the owner an approval or yes/no question on their phone and WAIT for the answer (up to 5 minutes; no shell timeout applies). "
      + "Ask only when the work depends on the answer; under 240 characters, one exact action, self-contained. "
      + "Only an `approval` question that returns state `approved` is permission to proceed. A yes/no answer is never permission. "
      + "Denied, no, expired, timeout, canceled or any error all mean NO: do not act. State `timeout` means the question is still open: call relo_interaction_wait with its id.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["question", "kind"],
      properties: {
        question: string("The question, e.g. \"Deploy 0.7.57 to production?\" (240 characters). No secrets or paths."),
        kind: { type: "string", enum: ["approval", "yes_no"], description: "approval: asks permission for one exact action. yes_no: a plain question." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: QUESTION_SECONDS, description: "How long to wait for the answer (default and maximum 300, the question's life)." },
        ...identity,
      },
    },
    annotations: { title: "Ask the owner", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "relo_interaction_wait",
    title: "Keep waiting for an answer",
    description: RULES + "Resume waiting for a question that relo_ask left open (state `timeout`). Same rules: only `approved` from an approval question is permission.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: string("The interaction id from relo_ask (int_…)."),
        timeout_seconds: { type: "integer", minimum: 1, maximum: QUESTION_SECONDS, description: "How long to wait (default and maximum 300)." },
      },
    },
    annotations: { title: "Keep waiting for an answer", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "relo_notify",
    title: "Send a notification",
    description: RULES + "Send one push notification, rarely: only for a finished outcome worth a buzz. Never a question, never progress (use the card). " + CARD_TEXT,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["body"],
      properties: { body: string("The message (what finished, in a sentence or two)."), title: string("Short title (80 characters)."), ...identity },
    },
    annotations: { title: "Send a notification", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "relo_doctor",
    title: "Check Relo",
    description: "Check that Relo is signed in and reachable. Returns {ok:true,ready:true} or the first unmet step in next. Changes nothing; "
      + "do not run it as a preamble to work, only when a Relo tool fails with an auth or no-phone error.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { title: "Check Relo", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

// A value that begins with "--" would read as a flag to the CLI's argument parser.
const safe = (value) => String(value).replace(/^-{2,}/u, "–");
const flag = (name, value) => (value === undefined || value === null ? [] : [`--${name}=${safe(value)}`]);

function identityFlags(args) {
  return [...flag("topic", args.topic), ...flag("project", args.project)];
}

const ARGV = {
  relo_work_start: (a) => ["work", "start", "--json", ...flag("goal", a.goal), ...flag("status", a.status),
    ...(a.plan?.length ? flag("plan", a.plan.join(",")) : []), ...flag("progress", a.progress), ...(a.new ? ["--new"] : [])],
  relo_work_update: (a) => ["work", "update", "--json", ...flag("status", a.status), ...flag("progress", a.progress), ...(a.next_step ? ["--next-step"] : []),
    ...flag("step", a.step), ...(a.plan?.length ? flag("plan", a.plan.join(",")) : []), ...(a.add?.length ? flag("add", a.add.join(",")) : []),
    ...flag("waiting", a.waiting), ...(a.not_waiting ? ["--not-waiting"] : [])],
  relo_work_finish: (a) => ["work", "finish", "--json", ...flag("outcome", a.outcome), ...(a.failed ? ["--failed"] : []), ...(a.dropped ? ["--dropped"] : [])],
  relo_work_state: () => ["state", "--sync", "--json"],
  relo_ask: (a) => ["ask", safe(a.question), a.kind === "approval" ? "--approval" : "--yes-no", `--timeout=${a.timeout_seconds ?? QUESTION_SECONDS}s`, ...identityFlags(a)],
  relo_interaction_wait: (a) => ["interaction", "wait", safe(a.id), `--timeout=${a.timeout_seconds ?? QUESTION_SECONDS}s`],
  relo_notify: (a) => ["notify", "send", safe(a.body), ...flag("title", a.title), ...identityFlags(a)],
  relo_doctor: () => ["doctor"],
};

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
export async function serveMcp({ input, output, run, version, env = process.env, overrides = {}, progressIntervalMs = PROGRESS_INTERVAL_MS, now = Date.now }) {
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
      exitCode = await run(ARGV[tool.name](args), { stdout: (line) => lines.push(line), stderr: (line) => notes.push(line), stdoutIsTTY: false }, {
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
}
