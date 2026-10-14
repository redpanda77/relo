// relo work start|update|pause|resume|finish and relo state for agent sessions and unidentified callers
// (plan 04 §2.3–2.7). Text echo on stdout; --json gives {ok, disposition, work, parked, echo}.
import { createHash } from "node:crypto";
import { EXIT, UsageError } from "../errors.mjs";
import { checkLabels, checkText } from "../work/content-filter.mjs";
import { declaredLane, laneSummary, offline } from "../work/declared-lane.mjs";
import { renderEcho, shortId, stateLine } from "../work/echo.mjs";
import { applyChange, finishPlan, parseCount, splitLabels, splitWarnings, startPlan } from "../work/plan.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { SEALED, workCardText, workSealer } from "../work/seal-work.mjs";
import { loadSelfKey, restoreFromSelfCopy, selfCopyText } from "../work/self-copy.mjs";
import { newIdempotencyKey, splitWorks, WORK_ROUTES, worksClient } from "../work/works-client.mjs";
import { guardWorkFlags, harnessName } from "./guards.mjs";
import { handleIdentity, mintHandleToken, parseHandle, printHandle } from "./handle.mjs";
import { sessionName } from "./session-name.mjs";
import { readSession, writeSession } from "./session-file.mjs";

export const VERBS = ["start", "update", "pause", "resume", "finish"];
export const ALLOWED = {
  start: ["goal", "plan", "progress", "status", "new", "dry-run"],
  update: ["status", "goal", "next-step", "step", "plan", "add", "progress", "waiting", "not-waiting", "dry-run", "work"],
  pause: ["status", "dry-run", "work"],
  resume: ["dry-run", "work"],
  finish: ["outcome", "failed", "dropped", "work", "dry-run"],
};
const RETRY_WINDOW_MS = 10 * 60_000;
/** Declared text on the wire (contracts/works.ts declaredTextSchema). */
const readable = (text) => ({ readable: text });
/** A work started while offline: the server has not given it an id yet, so writes name the session's open work. */
const QUEUED_ID = "wrk_queued";
const routeId = (work) => (work?.queued ? "current" : work.id);
/** The same body with its text as {sealed: true} (the card and self copy carry the text). */
function sealedText(body) {
  const out = { ...body };
  for (const key of ["goal", "status", "outcome"]) if (out[key]) out[key] = SEALED;
  if (out.waiting) out.waiting = { reason: SEALED };
  return out;
}

/** Content filter refusals in the three-line shape. */
function filtered(fn, state, next) {
  try { return fn(); } catch (error) {
    if (error instanceof UsageError) throw new WorkRefusal(error.code ?? "CONTENT_REFUSED", { what: error.message.replace(/^Refused:\s*/u, "").replace(/\.$/u, ""), state, next });
    throw error;
  }
}

function result(echo, { disposition, work, parked = [], queued = false, exitCode = EXIT.OK } = {}) {
  return {
    exitCode,
    command: "work",
    echo,
    data: { ok: true, disposition, work: work ? { id: work.id, lifecycle: work.lifecycle, version: work.version, step: stepOf(work), progress: work.progress ?? null } : null, parked: parked.map((p) => p.id), ...(queued ? { queued: true } : {}), echo },
  };
}

function stepOf(work) {
  const steps = work?.plan?.steps?.filter((s) => s.state !== "skipped") ?? [];
  const i = steps.findIndex((s) => s.state === "current");
  return i === -1 ? null : `${i + 1}/${steps.length}`;
}

/** Labels the server may withhold (sealed accounts) come back from the local copy by id. */
function withLocalLabels(work, local) {
  if (!work || !local || local.id !== work.id) return work;
  const labels = new Map((local.plan?.steps ?? []).map((s) => [s.id, s.label]));
  // A sealed work comes back without text: the local copy holds what this computer sealed.
  return { ...work, goal: work.goal ?? local.goal, status: work.status ?? local.status ?? null, outcome: work.outcome ?? local.outcome ?? null, plan: work.plan ? { ...work.plan, steps: (work.plan.steps ?? []).map((s) => ({ ...s, label: s.label ?? labels.get(s.id) ?? null })) } : work.plan };
}

/** Creation defaults, with this session's own name (plan 3.7) as the topic unless RELO_TOPIC names one. */
async function context(dependencies) {
  let defaults;
  try { defaults = dependencies.creationDefaults?.() ?? {}; } catch { defaults = {}; }
  const name = defaults.threadName === undefined ? sessionName(dependencies) : undefined;
  return name ? { ...defaults, threadName: name } : defaults;
}

/** The session's name when it differs from the one this work last sent (Claude renames sessions after a few turns). */
function renamed(ctx, dependencies) {
  if (dependencies.env?.RELO_TOPIC?.trim()) return undefined;
  const name = sessionName(dependencies);
  return name && name !== ctx.file?.sessionName ? name : undefined;
}

/** Resolves who is calling and where its work lives: a session, or a handle for unidentified callers. */
async function scope(command, verb) {
  const { options, dependencies } = command;
  const caller = dependencies.caller;
  if (caller.type === "agent_session") {
    const file = await readSession(caller, dependencies);
    return { caller, dependencies, identity: { sessionKey: caller.sessionKey, harness: caller.harness === "claude-code" ? "claude-code" : caller.harness }, file, persist: true };
  }
  // unidentified
  if (verb === "start") {
    const token = mintHandleToken();
    return { caller, dependencies, identity: handleIdentity(token, caller), token, file: undefined, persist: false };
  }
  if (options.work === undefined) {
    throw new WorkRefusal("REFUSED_NO_SESSION", { what: `this shell has no session id (${harnessName(caller)}), so Relo cannot tell which work is yours`, state: "no session; work is reached only through its handle", next: 'relo work update --work <handle printed by relo work start> --status "…"' });
  }
  const handle = parseHandle(options.work);
  if (!handle) throw new WorkRefusal("REFUSED_HANDLE", { what: "no work matches that handle", state: "handles are printed once, by relo work start", next: 'relo work start --goal "…"' });
  return { caller, dependencies, identity: handleIdentity(handle.token, caller), token: handle.token, handle, file: undefined, persist: false };
}

/**
 * The session's works: the local working copy (EDGE.4), or the server's when asked to sync or when there is
 * no local copy. Text the server cannot read (sealed works) comes back from the local copy, else from the
 * producer's own sealed copy (2.21), so a lost state file still knows its goal and step labels.
 * `tolerateOffline`: an unreachable server reads as nothing known (a start then queues and the server decides).
 */
async function current(ctx, api, { sync = false, tolerateOffline = false } = {}) {
  if (!sync && ctx.file) return { open: ctx.file.open ?? null, parked: ctx.file.parked ?? [], local: true };
  if (!api) return { open: null, parked: [], local: true };
  let listed;
  try { listed = await api.list(); } catch (error) {
    if (tolerateOffline && offline(error)) return { open: null, parked: [], local: true, offline: true };
    throw error;
  }
  const { open, parked } = splitWorks(listed);
  if (ctx.handle && open && !String(open.id).startsWith(ctx.handle.prefix)) {
    throw new WorkRefusal("REFUSED_HANDLE", { what: "no work matches that handle", state: "handles are printed once, by relo work start", next: 'relo work start --goal "…"' });
  }
  const sealedWorks = [open, ...parked].some((work) => work?.producerSealed);
  const key = sealedWorks ? await loadSelfKey(ctx.dependencies) : null;
  return { open: restoreFromSelfCopy(withLocalLabels(open, ctx.file?.open), key), parked: parked.map((work) => restoreFromSelfCopy(work, key)), local: false };
}

async function save(ctx, dependencies, { open, parked, echo, pendingStart, question }) {
  if (!ctx.persist) return [];
  const name = ctx.sessionName ?? ctx.file?.sessionName;
  const ok = await writeSession(ctx.caller, dependencies, { open: open && open.lifecycle !== "finished" ? open : null, parked, lastEcho: echo, ...(pendingStart ? { pendingStart } : {}), ...(question ? { question } : {}), ...(name ? { sessionName: name } : {}) });
  return ok ? [] : [];
}

function handleOf(ctx, work) {
  return ctx.token && work?.id ? printHandle(work.id, ctx.token) : undefined;
}

function view(payload, local) {
  return { disposition: payload?.disposition, work: withLocalLabels(payload?.work ?? null, local), parked: payload?.parked ?? [] };
}

/** Notes from the lane flush that ran before this command. */
const drainNotes = (drained) => (drained.sent ? [`sent ${drained.sent} queued change${drained.sent === 1 ? "" : "s"}`] : []);

async function withRetry(fn, refetch, state, argv) {
  try { return await fn(undefined); } catch (error) {
    if (error?.code !== "VERSION_CONFLICT") throw error;
  }
  const fresh = await refetch();
  try { return await fn(fresh); } catch (error) {
    if (error?.code !== "VERSION_CONFLICT") throw error;
    throw new WorkRefusal("VERSION_CONFLICT", { what: "the work changed twice while this command ran (another relo command in this session)", state, next: `relo ${argv.join(" ")}`, exitCode: EXIT.API });
  }
}

export async function runAgentWork(command, verb) {
  const { options, rest = [], dependencies, client } = command;
  const argv = dependencies.argv ?? ["work", verb];
  const sealNotes = [];
  let sealerPromise;
  const sealer = () => (sealerPromise ??= workSealer({ client, config: command.config, dependencies, notes: sealNotes }));
  /** A sealed work is always sealed, a readable one never; a work not on the server yet seals when it can. */
  const sealMode = (work) => (work?.queued ? "auto" : work?.sealed ? "always" : "never");
  const dryRun = Boolean(options["dry-run"]);
  if (!VERBS.includes(verb)) {
    if (verb === "heartbeat") guardWorkFlags({ verb, options, positionals: [], argv, caller: dependencies.caller, state: "nothing open" });
    throw new WorkRefusal("REFUSED_VERB", { what: `relo work has no "${verb ?? ""}"`, state: "verbs: start, update, pause, resume, finish (and relo state)", next: 'relo work start --goal "…"' });
  }
  const ctx = await scope(command, verb);
  const localState = stateLine(ctx.file?.open ?? null, ctx.file?.parked ?? []);
  guardWorkFlags({ verb, options, positionals: rest, argv, caller: ctx.caller, state: localState });
  for (const [name, value] of Object.entries(options)) {
    if (["help", "json", "full", "device", "scope"].includes(name) || ALLOWED[verb].includes(name)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value !== undefined && value !== false) throw new WorkRefusal("REFUSED_FLAG", { what: `--${name} is not a relo work ${verb} flag`, state: localState, next: `relo help` });
  }
  const api = dryRun ? undefined : worksClient(client, ctx.identity);
  // EDGE.3: queued writes go first, so order is kept; anything still queued puts this write behind it.
  const lane = dryRun ? undefined : declaredLane({ client, config: command.config, dependencies, identity: ctx.identity, sealer });
  const drained = lane ? await lane.drain() : { sent: 0, pending: 0 };
  const resync = Boolean(lane) && !lane.queued && (drained.sent > 0 || Boolean(ctx.file?.open?.queued));
  const now = new Date();

  if (verb === "start") {
    const goal = filtered(() => checkText("goal", options.goal, { flag: "--goal" }), localState, 'relo work start --goal "…"');
    const status = options.status === undefined ? undefined : filtered(() => checkText("status", options.status, { goal }), localState, `relo work start --goal "${goal}" --status "…"`);
    const labels = options.plan === undefined ? undefined : filtered(() => checkLabels(splitLabels(options.plan)), localState, `relo work start --goal "${goal}" --plan "…"`);
    const splitNotes = labels ? splitWarnings(labels) : [];
    if (options.plan !== undefined && !labels.length) throw new WorkRefusal("CONTENT_REFUSED", { what: "--plan is empty", state: localState, next: `relo work start --goal "${goal}" --plan "Reproduce the bug,Find the cause"` });
    const progress = options.progress === undefined ? undefined : parseCount(options.progress, localState);
    const existing = ctx.persist ? await current(ctx, api, { sync: !ctx.file || resync, tolerateOffline: true }) : { open: null, parked: [] };
    const open = existing.open?.lifecycle === "open" ? existing.open : null;
    if (open && !options.new) {
      const notes = drainNotes(drained);
      if (String(open.goal ?? "").toLowerCase() === goal.toLowerCase()) notes.push("this goal is already open; nothing changed.");
      else {
        notes.push(`open work is "${open.goal}". You passed "${goal}". Nothing changed.`);
        notes.push(`same goal → relo work update --goal "${goal}"; new goal → relo work start --new --goal "${goal}"`);
      }
      for (const flag of ["plan", "progress", "status"]) if (options[flag] !== undefined) notes.push(`--${flag} was ignored on a continuing start; to revise: relo work update --${flag} "…"`);
      const echo = renderEcho({ work: open, parked: existing.parked, disposition: "continuing", notes, now });
      return result(echo, { disposition: "continuing", work: open, parked: existing.parked });
    }
    const { plan } = startPlan(labels, labels ? progress : undefined, localState);
    const body = { goal: readable(goal), ...(status ? { status: readable(status) } : {}), ...(plan ? { plan: { op: "set", steps: labels.map((label) => ({ label })) } } : {}), ...(progress ? { progress } : {}), ...(options.new ? { new: true } : {}), context: await context(dependencies) };
    const named = body.context.threadName;
    const notes = [...drainNotes(drained), ...(options.new && !open ? ["--new had nothing to park"] : []), ...splitNotes];
    if (dryRun) {
      const work = { id: "wrk_00000000", goal, status, plan, progress: plan ? undefined : progress, lifecycle: "open" };
      return result(renderEcho({ work, disposition: "started", notes, dryRun: true, now }), { disposition: "started", work });
    }
    const digest = createHash("sha256").update(JSON.stringify([goal, labels ?? null, progress ?? null])).digest("hex");
    const pending = ctx.file?.pendingStart;
    const key = pending && pending.digest === digest && now - new Date(pending.at) < RETRY_WINDOW_MS ? pending.key : newIdempotencyKey();
    if (ctx.persist) await writeSession(ctx.caller, dependencies, { ...(ctx.file ?? {}), open: ctx.file?.open ?? null, parked: ctx.file?.parked ?? [], pendingStart: { digest, key, at: now.toISOString() } });
    // Sealed (when this computer has a phone to seal for): the text rides the card and the self copy; plan
    // entries carry predicted ids; project, topic and computer go as handles whose names ride the card.
    const payload = await lane.write({
      route: WORK_ROUTES.start(), key, seal: "auto", readable: body,
      sealedForm: { ...sealedText(body), ...(body.plan ? { plan: { op: "set", steps: labels.map((_, i) => ({ id: `s${i + 1}` })) } } : {}) },
      opaque: body.context, withContext: true,
      card: { title: goal, status, ...(labels?.length ? { steps: labels } : {}) },
      copy: selfCopyText({ goal, status, plan }),
    });
    if (named) ctx.sessionName = named;
    if (!payload) {
      // Queued: the local copy is the working copy until the server has it.
      const work = { id: QUEUED_ID, queued: true, version: 0, goal, status: status ?? null, plan, progress: plan ? null : progress ?? null, lifecycle: "open" };
      const parked = open ? [{ ...open, lifecycle: "paused", pausedReason: "parked" }, ...existing.parked] : existing.parked;
      if (open) notes.push(`parks ${shortId(open.id)} "${open.goal}" once sent`);
      const disposition = open ? "switched" : "started";
      const echo = renderEcho({ work, parked, disposition, notes, queued: true, now });
      await save(ctx, dependencies, { open: work, parked, echo });
      return result(echo, { disposition, work, parked, queued: true });
    }
    const response = view(payload, { id: undefined });
    let work = response.work;
    if (work) work = withLocalLabels(work, { id: work.id, goal, status, plan });
    if (open && response.disposition === "switched") notes.push(`parked ${shortId(open.id)} "${open.goal}"; its card left the Lock Screen.`);
    const handle = handleOf(ctx, work);
    const echo = renderEcho({ work, parked: response.parked, disposition: response.disposition ?? "started", notes, handle, now });
    await save(ctx, dependencies, { open: work, parked: response.parked, echo });
    return result(echo, { disposition: response.disposition ?? "started", work, parked: response.parked });
  }

  if (verb === "resume") {
    const target = rest[0] ?? (ctx.handle ? undefined : options.work);
    const state = await current(ctx, api, { sync: (!ctx.file || resync) && !dryRun });
    const candidates = [...(state.open?.lifecycle === "paused" ? [state.open] : []), ...state.parked];
    const chosen = target ? candidates.find((w) => String(w.id).startsWith(target)) : candidates[0];
    if (!chosen && ctx.handle && state.open?.lifecycle === "paused") return resumeOne(state.open);
    if (!chosen) {
      if (target) throw new WorkRefusal("NOT_FOUND", { what: `no work ${target} in this session`, state: stateLine(state.open, state.parked), next: "relo state" });
      throw new WorkRefusal("REFUSED_NOTHING_TO_RESUME", { what: "nothing to resume in this session", state: stateLine(state.open, state.parked), next: 'relo work start --goal "…"' });
    }
    return resumeOne(chosen);
    async function resumeOne(work) {
      if (dryRun) return result(renderEcho({ work: { ...work, lifecycle: "open" }, disposition: "resumed", dryRun: true, now }), { disposition: "resumed", work });
      let payload;
      try {
        payload = await lane.write({ route: WORK_ROUTES.resume(work.queued ? "newest" : work.id), key: newIdempotencyKey(), seal: "never", readable: {} });
      } catch (error) {
        if (error?.status === 404) throw new WorkRefusal("NOT_FOUND", { what: `no work ${shortId(work.id)} in this session`, state: stateLine(state.open, state.parked), next: "relo state" });
        if (error?.status === 409) throw new WorkRefusal("REFUSED_FINISHED", { what: `${shortId(work.id)} is finished; finished work is not reopened`, state: stateLine(state.open, state.parked), next: 'relo work start --new --goal "…"' });
        throw error;
      }
      const notes = [...drainNotes(drained), ...(state.open && state.open.lifecycle === "open" && state.open.id !== work.id ? [`parked ${shortId(state.open.id)} "${state.open.goal}"`] : [])];
      const before = [state.open, ...state.parked].filter((w) => w && w.id !== work.id).map((w) => (w.lifecycle === "open" ? { ...w, lifecycle: "paused", pausedReason: "parked" } : w));
      const response = payload ? view(payload, state.open?.id === work.id ? state.open : work) : { work: { ...work, lifecycle: "open", pausedReason: null }, parked: before };
      const echo = renderEcho({ work: response.work, parked: response.parked, disposition: "resumed", notes, handle: handleOf(ctx, response.work), queued: !payload, now });
      await save(ctx, dependencies, { open: response.work, parked: response.parked, echo });
      return result(echo, { disposition: "resumed", work: response.work, parked: response.parked, queued: !payload });
    }
  }

  const state = await current(ctx, api, { sync: (!ctx.file || Boolean(ctx.handle) || resync) && !dryRun });
  const sline = stateLine(state.open, state.parked);
  const parkedNext = state.parked[0] ? `  |  relo work resume ${shortId(state.parked[0].id)}` : "";
  const noOpen = () => new WorkRefusal("REFUSED_NO_OPEN_WORK", { what: "this session has no open work", state: state.parked[0] ? `parked: ${shortId(state.parked[0].id)} "${state.parked[0].goal}"` : "nothing open", next: `relo work start --goal "…"${parkedNext}` });

  if (verb === "finish") {
    if (options.outcome === undefined) throw new WorkRefusal("REFUSED_NO_OUTCOME", { what: "finishing needs an outcome: what happened, in the owner's words", state: sline, next: 'relo work finish --outcome "…"  |  relo work finish --failed --outcome "…"' });
    if (options.failed && options.dropped) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--failed and --dropped contradict each other", state: sline, next: 'relo work finish --failed --outcome "…"' });
    const outcome = filtered(() => checkText("outcome", options.outcome, { flag: "--outcome" }), sline, 'relo work finish --outcome "0.17 built and tested"');
    const ref = ctx.handle ? undefined : options.work;
    let target = state.open;
    if (ref) {
      target = [state.open, ...state.parked].filter(Boolean).find((w) => String(w.id).startsWith(ref));
      if (!target && !dryRun) {
        const fresh = await current(ctx, api, { sync: true });
        target = [fresh.open, ...fresh.parked].filter(Boolean).find((w) => String(w.id).startsWith(ref));
      }
      if (!target) throw new WorkRefusal("NOT_FOUND", { what: `no work ${ref} in this session`, state: sline, next: "relo state" });
    }
    if (!target) throw noOpen();
    const resultKind = options.failed ? "failed" : options.dropped ? "dropped" : "finished";
    // DOGFOOD #20: the outcome replaces the status; on success the current step is done.
    const { plan } = finishPlan(target.plan, resultKind);
    const finished = { ...target, plan, status: null, waiting: null, lifecycle: "finished", result: resultKind, outcome };
    if (dryRun) return result(renderEcho({ work: finished, dryRun: true, now }), { disposition: "finished", work: finished });
    let payload;
    try {
      payload = await lane.write({
        route: WORK_ROUTES.finish(routeId(target)), key: newIdempotencyKey(), seal: sealMode(target),
        readable: { result: resultKind, outcome: readable(outcome) }, sealedForm: { result: resultKind, outcome: SEALED },
        card: workCardText({ ...target, plan }, { status: outcome }),
      });
    } catch (error) {
      if (error?.status === 404) throw new WorkRefusal("NOT_FOUND", { what: `no work ${shortId(target.id)} in this session`, state: sline, next: "relo state" });
      throw error;
    }
    const response = payload ? view(payload, target) : { work: null, parked: undefined };
    const work = response.work ? { ...response.work, status: null } : finished;
    const remaining = target === state.open ? null : state.open;
    const parked = response.parked ?? state.parked.filter((p) => p.id !== target.id);
    const echo = renderEcho({ work: { ...work, result: work.result ?? resultKind, outcome: work.outcome ?? outcome }, parked, notes: drainNotes(drained), queued: !payload, now });
    await save(ctx, dependencies, { open: remaining, parked, echo });
    return result(echo, { disposition: "finished", work, parked, queued: !payload });
  }

  if (!state.open || state.open.lifecycle === "finished") throw noOpen();
  const open = state.open;

  if (verb === "pause") {
    if (open.lifecycle === "paused") throw new WorkRefusal("REFUSED_PAUSED", { what: `${shortId(open.id)} is already paused`, state: `paused: "${open.status ?? ""}"`, next: "relo work resume" });
    if (options.status === undefined) throw new WorkRefusal("REFUSED_NO_REASON", { what: "pausing needs a reason: --status says why", state: sline, next: 'relo work pause --status "…"' });
    const status = filtered(() => checkText("status", options.status, { goal: open.goal }), sline, 'relo work pause --status "…"');
    if (dryRun) return result(renderEcho({ work: { ...open, status, lifecycle: "paused" }, disposition: "paused", dryRun: true, now }), { disposition: "paused", work: open });
    const paused = { ...open, status, lifecycle: "paused", pausedReason: "declared" };
    const payload = await lane.write({
      route: WORK_ROUTES.pause(routeId(open)), key: newIdempotencyKey(), seal: sealMode(open),
      readable: { status: readable(status) }, sealedForm: { status: SEALED },
      card: workCardText(open, { status }), copy: selfCopyText(paused),
    });
    const response = payload ? view(payload, paused) : { work: paused, parked: state.parked };
    const work = response.work ?? paused;
    const echo = renderEcho({ work, parked: response.parked, disposition: "paused", notes: drainNotes(drained), handle: handleOf(ctx, work), queued: !payload, now });
    await save(ctx, dependencies, { open: work, parked: response.parked, echo });
    return result(echo, { disposition: "paused", work, parked: response.parked, queued: !payload });
  }

  // update
  if (open.lifecycle === "paused") throw new WorkRefusal("REFUSED_PAUSED", { what: `${shortId(open.id)} is paused`, state: sline, next: "relo work resume" });
  if (options.waiting !== undefined && options["not-waiting"]) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--waiting and --not-waiting contradict each other", state: sline, next: 'relo work update --waiting "…"' });
  const stepValue = Array.isArray(options.step) ? options.step[0] : options.step;
  if (options["next-step"] && stepValue !== undefined) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--next-step and --step contradict each other", state: sline, next: "relo work update --next-step" });
  const change = {
    ...(options["next-step"] ? { nextStep: true } : {}),
    ...(options.plan !== undefined ? { plan: filtered(() => checkLabels(splitLabels(options.plan)), sline, 'relo work update --plan "…"') } : {}),
    ...(options.add !== undefined ? { add: filtered(() => checkLabels(splitLabels(options.add)), sline, 'relo work update --add "…"') } : {}),
    ...(stepValue !== undefined ? { step: String(stepValue).trim() } : {}),
    ...(options.progress !== undefined ? { progress: parseCount(options.progress, sline) } : {}),
  };
  if (change.plan && !change.plan.length) throw new WorkRefusal("CONTENT_REFUSED", { what: "--plan is empty", state: sline, next: 'relo work update --plan "…"' });
  const goal = options.goal === undefined ? undefined : filtered(() => checkText("goal", options.goal, { flag: "--goal" }), sline, 'relo work update --goal "…"');
  const status = options.status === undefined ? undefined : filtered(() => checkText("status", options.status, { goal: goal ?? open.goal }), sline, 'relo work update --status "…"');
  const waiting = options.waiting === undefined ? undefined : filtered(() => checkText("waiting", options.waiting, { flag: "--waiting" }), sline, 'relo work update --waiting "CI"');
  if (!Object.keys(change).length && goal === undefined && status === undefined && waiting === undefined && !options["not-waiting"]) {
    throw new WorkRefusal("REFUSED_NO_CHANGE", { what: "relo work update needs at least one change", state: sline, next: 'relo work update --status "…"  |  relo work update --next-step' });
  }
  const planned = Boolean(open.plan?.steps?.length) || Boolean(change.plan) || Boolean(change.add);
  const build = (base) => {
    const labelsKnown = !base.plan?.steps?.some((s) => s.label == null);
    const planChange = { ...change, ...(planned ? {} : { progress: undefined }) };
    const outcome = Object.keys(planChange).some((k) => planChange[k] !== undefined) ? applyChange(base.plan ?? null, planChange, labelsKnown, sline) : { plan: base.plan ?? null, notes: [], moved: { added: [] } };
    const notes = [...outcome.notes, ...splitWarnings([...(change.plan ?? []), ...(change.add ?? [])]), ...(outcome.moved.added ?? []).filter(() => base.plan?.steps?.length).map((id) => `added ${id} ${outcome.plan.steps.find((s) => s.id === id)?.label ?? ""}`.trim())];
    // The server takes one plan command per request: one PATCH per plan change, text on the first,
    // progress on the last (it lands on the current step when the work has a plan).
    const commands = [];
    if (change.nextStep) commands.push({ op: "next" });
    if (change.plan) commands.push({ op: "revise", labels: change.plan });
    if (change.add) commands.push({ op: "add", steps: change.add.map((label) => ({ label })) });
    if (change.step !== undefined) {
      const id = /^s\d+$/u.test(change.step) ? change.step : outcome.plan?.steps?.find((s) => s.state === "current")?.id;
      if (id) commands.push({ op: "step", id });
    }
    const text = {
      ...(goal !== undefined ? { goal: readable(goal) } : {}),
      ...(status !== undefined ? { status: readable(status) } : {}),
      ...(waiting !== undefined ? { waiting: { reason: readable(waiting) } } : options["not-waiting"] ? { waiting: null } : {}),
    };
    const bodies = (commands.length ? commands : [undefined]).map((plan, i) => ({
      ...(i === 0 ? { baseVersion: base.version, ...text } : {}),
      ...(plan ? { plan } : {}),
    }));
    if (change.progress) bodies[bodies.length - 1].progress = change.progress;
    const body = bodies;
    const next = { ...base, ...(goal !== undefined ? { goal } : {}), ...(status !== undefined ? { status } : {}), ...(waiting !== undefined ? { waiting } : options["not-waiting"] ? { waiting: null } : {}), plan: outcome.plan, ...(change.progress && !planned ? { progress: change.progress } : {}) };
    return { body, next, notes };
  };
  if (dryRun) {
    const { next, notes } = build(open);
    return result(renderEcho({ work: next, parked: state.parked, disposition: "updated", notes, dryRun: true, now }), { disposition: "updated", work: next });
  }
  let notes = [];
  let local;
  let queued = false;
  const name = renamed(ctx, dependencies);
  const response = await withRetry(async (fresh) => {
    const base = fresh ?? open;
    const built = build(base);
    notes = built.notes;
    local = built.next;
    const seal = sealMode(base);
    const final = built.next.plan?.steps ?? [];
    const known = new Set((base.plan?.steps ?? []).map((step) => step.id));
    let payload;
    for (const [i, body] of built.body.entries()) {
      // A renamed session refreshes the card's topic (plan 3.7), on the first request of the update.
      const readableBody = i === 0 && name !== undefined ? { ...body, context: { threadName: name } } : body;
      const sealedBody = sealedText(body);
      if (sealedBody.plan?.op === "revise") sealedBody.plan = { op: "set", steps: final.filter((step) => step.state !== "done" && step.state !== "skipped").map((step) => ({ id: step.id })) };
      else if (sealedBody.plan?.op === "add") {
        if (change.plan) delete sealedBody.plan; // the set above already lists the added steps
        else sealedBody.plan = { op: "add", steps: final.filter((step) => !known.has(step.id)).map((step) => ({ id: step.id })) };
      }
      const sent = await lane.write({
        route: WORK_ROUTES.update(routeId(base)), key: newIdempotencyKey(), seal, readable: readableBody, sealedForm: sealedBody,
        ...(name !== undefined ? { opaque: { threadName: name }, withContext: i === 0 } : {}),
        card: workCardText(built.next), copy: selfCopyText(built.next),
      });
      if (sent) payload = sent; else queued = true;
    }
    return queued ? { work: null } : view(payload, local);
  }, async () => (await current(ctx, api, { sync: true })).open ?? open, sline, argv);
  if (name) ctx.sessionName = name;
  const work = response.work ? withLocalLabels(response.work, local) : local;
  const parked = response.parked ?? state.parked;
  const echo = renderEcho({ work, parked, disposition: response.disposition ?? "updated", notes: [...drainNotes(drained), ...notes], handle: handleOf(ctx, work), queued, now });
  await save(ctx, dependencies, { open: work, parked, echo });
  return result(echo, { disposition: "updated", work, parked, queued });
}

export async function runAgentState(command) {
  const { options, dependencies, client } = command;
  const ctx = await scope(command, "state");
  // Queued declared writes go out first (EDGE.3); what is still queued is shown.
  let sealerPromise;
  const sealer = () => (sealerPromise ??= workSealer({ client, config: command.config, dependencies, notes: [] }));
  const drained = client ? await declaredLane({ client, config: command.config, dependencies, identity: ctx.identity, sealer }).drain() : { sent: 0, pending: 0 };
  const sync = Boolean(options.sync) || !ctx.file || (drained.sent > 0 && !drained.pending) || (Boolean(ctx.file?.open?.queued) && !drained.pending);
  const api = sync ? worksClient(client, ctx.identity) : undefined;
  const state = await current(ctx, api, { sync });
  const lines = [];
  if (!sync && ctx.file?.writtenAt && Date.now() - new Date(ctx.file.writtenAt) > 3600_000) {
    const at = new Date(ctx.file.writtenAt);
    lines.push(`Local copy from ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}, possibly stale: relo state --sync`);
  }
  lines.push(renderEcho({ work: state.open, parked: state.parked, notes: drainNotes(drained), lane: await laneSummary(dependencies), handle: ctx.token && state.open ? printHandle(state.open.id, ctx.token) : undefined }));
  const echo = lines.join("\n");
  if (sync) await save(ctx, dependencies, { open: state.open, parked: state.parked, echo });
  return result(echo, { disposition: undefined, work: state.open, parked: state.parked });
}
