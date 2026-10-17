// `relo hook permission` (the `approvals` level, ADR 0008 "The approvals exception"): Claude Code is about to
// ask the owner for permission, so the owner is asked on the phone and the Dashboard too, and Claude Code
// gets whichever answer comes first.
//
// The hook does not write Relo state itself. It runs the session's own `relo ask` (a declared act of the
// session, sealed like any question) and `relo interaction wait`, through `runRelo`, which the composition
// root (harness/entry.mjs) injects: this module reaches no client, no outbox and no card writer. What it
// prints is Claude Code's PermissionRequest decision, or nothing: no answer (the owner away, the wait over,
// anything failing) leaves Claude Code's own terminal prompt exactly as it was. Never a decision on a guess:
// only an approved answer (signed by a phone this computer verified, checked inside `relo interaction wait`)
// allows, and only a denied one denies.
//
// Claude Code races this hook against its terminal dialog. When the owner answers there instead, Claude
// Code ends this process (SIGTERM) or the session moves on; either way the question is withdrawn so it
// never lingers on a card as a stale "needs you".
import { sessionKey } from "../../shared/session-key.mjs";
import { readObservedPhase } from "./session-state.mjs";

/** How long the owner has to answer here, a little under the hook's own ceiling (levels.mjs: 330 s). */
export const APPROVAL_WAIT_SECONDS = 300;
/** One `relo interaction wait` slice: short, so a withdrawn or answered-elsewhere question is noticed soon. */
const SLICE_SECONDS = 20;
const PROMPT_MAX = 120;
const DETAIL_MAX = 2_000;

const oneLine = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const clip = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
const baseName = (path) => oneLine(path).split(/[\\/]/u).filter(Boolean).pop() ?? "";

/** The question's one line and its detail, from what Claude Code is about to run. Pure. */
export function describeRequest({ tool, input }) {
  const name = oneLine(tool) || "a tool";
  const command = typeof input.command === "string" ? input.command : undefined;
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
  let summary;
  let detail;
  if (command !== undefined) {
    summary = `Run ${oneLine(command)}`;
    detail = `${name}\n${command}`;
  } else if (file !== undefined) {
    const verb = /^(?:Edit|MultiEdit|NotebookEdit)$/u.test(name) ? "Edit" : name === "Write" ? "Write" : name === "Read" ? "Read" : `${name}:`;
    summary = `${verb} ${baseName(file)}`;
    detail = `${name}\n${file}`;
  } else if (typeof input.url === "string") {
    let host = input.url;
    try { host = new URL(input.url).host; } catch { /* keep the text */ }
    summary = `${name} ${host}`;
    detail = `${name}\n${input.url}`;
  } else if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    summary = `Use ${server} ${rest.join(" ")}`.trim();
    detail = name;
  } else {
    summary = `Use ${name}`;
    detail = name;
  }
  return { prompt: clip(`Allow: ${clip(summary, PROMPT_MAX - 9)}?`, PROMPT_MAX), detail: clip(detail, DETAIL_MAX) };
}

/** The interaction id from `relo ask --no-wait`'s JSON line. */
function interactionId(stdout) {
  try {
    const data = JSON.parse(String(stdout).trim().split("\n").pop());
    const id = data?.interaction?.id ?? data?.interactionId ?? data?.data?.interaction?.id ?? data?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns { decision: "allow" | "deny" | "none", ... }; prints the adapter's rendering for allow and deny.
 * Never throws. `dependencies.runRelo(args, { env, cwd }) → { code, stdout }` runs the CLI as this session.
 */
export async function runPermission({ adapter, input, dependencies }) {
  const request = adapter.permissionRequest?.(input);
  const render = adapter.renderDecision;
  const runRelo = dependencies.runRelo;
  if (!request?.session || !request.tool || !render || !runRelo || !adapter.sessionEnv) return { decision: "none", reason: "unsupported" };
  const env = adapter.sessionEnv?.(dependencies.env, request.session);
  const run = (args) => runRelo(args, { env, cwd: request.cwd });
  const { prompt, detail } = describeRequest(request);
  let id;
  let finished = false;
  const withdraw = async () => {
    if (!id || finished) return;
    finished = true;
    try { await run(["interaction", "cancel", id]); } catch { /* best effort: it expires on its own */ }
  };
  // Claude Code ends the hook when the owner answers its own dialog first.
  const release = dependencies.onTerminate?.(async () => { await withdraw(); dependencies.exit?.(0); });
  try {
    const asked = await run(["ask", prompt, "--approval", "--no-wait", "--expires-in", `${APPROVAL_WAIT_SECONDS}s`, "--detail", detail]);
    id = asked.code === 0 ? interactionId(asked.stdout) : undefined;
    if (!id) return { decision: "none", reason: "not_asked" };
    const wait = dependencies.approvalWaitSeconds ?? APPROVAL_WAIT_SECONDS;
    const deadline = dependencies.now() + wait * 1_000;
    let sawWaiting = false;
    while (dependencies.now() < deadline && !finished) {
      const slice = Math.max(1, Math.min(SLICE_SECONDS, Math.ceil((deadline - dependencies.now()) / 1_000)));
      const answer = await run(["interaction", "wait", id, "--timeout", `${slice}s`]);
      if (answer.code === 0 || answer.code === 5) {
        finished = true;
        const behavior = answer.code === 0 ? "allow" : "deny";
        dependencies.emit?.(render({ behavior, message: "Denied from Relo." }));
        return { decision: behavior };
      }
      if (answer.code !== 4) { finished = true; return { decision: "none", reason: "closed" }; }
      // Answered in the terminal: the session was waiting on its prompt and is working again.
      const phase = await readObservedPhase(dependencies.observedStateDirectory, sessionKey({ harness: adapter.id, id: request.session })).catch(() => undefined);
      if (phase === "waiting") sawWaiting = true;
      else if (sawWaiting && phase !== undefined) break;
    }
    return { decision: "none", reason: finished ? "closed" : "unanswered" };
  } catch {
    return { decision: "none", reason: "error" };
  } finally {
    await withdraw();
    release?.();
  }
}
