// relo work start|update|pause|resume|finish and relo state for agent sessions and unidentified callers
// (plan 04 §2.3–2.7). Text echo on stdout; --json gives {ok, disposition, work, parked, echo}.
import { createHash } from "node:crypto";
import { EXIT, UsageError } from "../shared/errors.mjs";
import { FACTS } from "../shared/facts.generated.mjs";
import { checkLabels, checkText } from "../work/content-filter.mjs";
import { declaredLane, laneSummary, materialize, offline } from "../work/declared-lane.mjs";
import { renderEcho, shortId, stateLine } from "../work/echo.mjs";
import { applyChange, deliverPlan, entryLabels, finishPlan, isDelivered, lastRound, openRoundPlan, parseCount, parsePlan, planBodies, planCommands, position, splitWarnings, startPlan, wireEntries } from "../work/plan.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { clearPendingHandoff, readPendingHandoff, sessionHash, writePendingHandoff } from "../work/handoff-store.mjs";
import { envSetting } from "../shared/settings.mjs";
import { T_RETIRE_MS } from "../work/state-file.mjs";
import { SEALED, workCardText, workSealer } from "../crypto/seal-work.mjs";
import { checkSpoken, outcomeGist, saidGist, spokenLine, spokenName as nameAloud, voiceNote, voiceSetting } from "../work/spoken.mjs";
import { readable, sealedStart, sealedUpdate } from "../work/sealed-form.mjs";
import { loadSelfKey, restoredPlan, restoreFromSelfCopy, selfCopyText } from "../crypto/self-copy.mjs";
import { newIdempotencyKey, splitWorks, WORK_ROUTES, worksClient } from "../work/works-client.mjs";
import { guardWorkFlags, harnessName } from "./guards.mjs";
import { handleIdentity, mintHandleToken, parseHandle, printHandle } from "./handle.mjs";
import { isLoopbackApiUrl } from "../shared/config.mjs";
import { sessionName, titleCacheOf } from "./session-name.mjs";
import { readSession, writeSession } from "./session-file.mjs";

const VERBS = ["start", "update", "pause", "resume", "deliver", "handoff", "finish"];
/** The handoff note on the card: "Handing off: <next>" (the server stores what it is sent). */
const HANDOFF_PREFIX = "Handing off: ";
const HANDLE_FORMAT = /^rh_[A-Za-z0-9_-]{20,190}$/u;
const RETRY_WINDOW_MS = 10 * 60_000;
/** A work started while offline: the server has not given it an id yet, so writes name the session's open work. */
const QUEUED_ID = "wrk_queued";
const routeId = (work) => (work?.queued ? "current" : work.id);
/** Content filter refusals in the three-line shape. */
function filtered(fn, state, next) {
  try { return fn(); } catch (error) {
    if (error instanceof UsageError) throw new WorkRefusal(error.code ?? "CONTENT_REFUSED", { what: error.message.replace(/^Refused:\s*/u, "").replace(/\.$/u, ""), state, next });
    throw error;
  }
}

/** The text cut to fit `max` characters, at a word when one is near, "…" only when something was cut. */
export function fitText(text, max) {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/u, "")}…`;
}

const quoted = (text) => String(text).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

/** The Next of a refused outcome or status: the agent's own text cut to the limit when it was too long. */
function textNext(command, flag, raw, max, fallback) {
  const text = typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : "";
  return text && Array.from(text).length > max ? `${command} ${flag} "${quoted(fitText(text, max))}"` : fallback;
}

/** A plan value as entries (nested by indentation), through the content filter, in the three-line refusal shape. */
const planEntries = (value, state, next) => filtered(() => {
  const entries = parsePlan(value, state);
  checkLabels(entryLabels(entries));
  return entries;
}, state, next);

/** The open round's steps as a tree [{id,label,state,detail?,children?}] (a closed round's steps appear only as round outcomes). */
function planTree(plan) {
  const rounds = plan?.rounds;
  const last = rounds?.[rounds.length - 1];
  if (!plan?.steps || last?.state === "closed") return [];
  const steps = last ? plan.steps.filter((s) => (s.round ?? 1) === last.n) : plan.steps;
  const nodes = new Map(steps.map((s) => [s.id, { id: s.id, ...(typeof s.label === "string" ? { label: s.label } : {}), state: s.state, ...(typeof s.detail === "string" ? { detail: s.detail } : {}) }]));
  const roots = [];
  for (const s of steps) {
    const parent = s.parent === undefined ? undefined : nodes.get(s.parent);
    if (parent) (parent.children ??= []).push(nodes.get(s.id));
    else roots.push(nodes.get(s.id));
  }
  return roots;
}

const VIEW_ROUNDS = 5;

/** The work as `--json` shows it: ids and lifecycle, plus what an agent needs to resume: goal, status, current step, rounds, plan tree. */
export function workView(work) {
  // The newest few rounds only: a long work has dozens, and this view is read into an agent's context on every command.
  const all = work.plan?.rounds ?? [];
  const rounds = all.slice(-VIEW_ROUNDS).map((r) => ({ n: r.n, state: r.state, ...(r.title ? { title: r.title } : {}), ...(r.outcome ? { outcome: r.outcome } : {}) }));
  return {
    id: work.id, lifecycle: work.lifecycle, version: work.version, step: stepOf(work), progress: work.progress ?? null,
    goal: work.goal ?? null,
    ...(typeof work.status === "string" ? { status: work.status } : {}),
    current: work.plan?.steps?.find((s) => s.state === "current")?.id ?? null,
    rounds,
    ...(all.length > rounds.length ? { earlierRounds: all.length - rounds.length } : {}),
    plan: planTree(work.plan),
  };
}

function result(echo, { disposition, work, parked = [], queued = false, exitCode = EXIT.OK, extra } = {}) {
  return {
    exitCode,
    command: "work",
    echo,
    data: { ok: true, disposition, work: work ? workView(work) : null, parked: parked.map((p) => p.id), ...(queued ? { queued: true } : {}), ...(extra ?? {}), echo },
  };
}

function stepOf(work) {
  const pos = position(work?.plan);
  return pos.current ? `${pos.index}/${pos.total}` : null;
}

/** Labels the server may withhold (sealed accounts) come back from the local copy by id. */
export function withLocalLabels(work, local) {
  if (!work || !local || local.id !== work.id) return work;
  // A sealed work comes back without text: the local copy holds what this computer sealed (labels and details
  // by step id, round titles and outcomes by number).
  // The waiting reason is text too: the server holds {reason: null, since} for a sealed work, this computer the words.
  const localReason = local.waiting && typeof local.waiting === "object" ? local.waiting.reason : local.waiting;
  const waiting = work.waiting && typeof work.waiting === "object" && work.waiting.reason == null && localReason ? { ...work.waiting, reason: localReason } : work.waiting;
  return { ...work, goal: work.goal ?? local.goal, ...(work.spokenName ?? local.spokenName ? { spokenName: work.spokenName ?? local.spokenName } : {}), status: work.status ?? local.status ?? null, outcome: work.outcome ?? local.outcome ?? null, waiting, plan: work.plan ? restoredPlan(work.plan, selfCopyText(local)) : work.plan };
}

/**
 * Creation defaults, with this session's own name (plan 3.7) as the topic unless RELO_TOPIC names one.
 * `topic`: the name this work last sent as its topic, when it is known (a later write names that one).
 */
async function context(dependencies, topic) {
  let defaults;
  try { defaults = dependencies.creationDefaults?.() ?? {}; } catch { defaults = {}; }
  const name = defaults.threadName === undefined ? topic ?? sessionName(dependencies) : undefined;
  return name ? { ...defaults, threadName: name } : defaults;
}

/** The work's context as its start sent it (topic: the latest name sent), so every card envelope names its handles. */
const workContext = (ctx, dependencies, renamedTo) => context(dependencies, renamedTo ?? ctx.sessionName ?? ctx.file?.sessionName);

/** The session's name when it differs from the one this work last sent (Claude renames sessions after a few turns). */
function renamed(ctx, dependencies) {
  if (envSetting("topic", dependencies.env)) return undefined;
  const name = sessionName(dependencies);
  return name && name !== ctx.file?.sessionName ? name : undefined;
}

/** Resolves who is calling and where its work lives: a session, or a handle for unidentified callers. */
async function scope(command, verb) {
  const { options, dependencies } = command;
  const caller = dependencies.caller;
  if (caller.type === "agent_session") {
    const file = await readSession(caller, dependencies);
    return { caller, dependencies, identity: { sessionKey: caller.sessionKey, harness: caller.harness }, file, persist: true };
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

/** `pendingRefusal`: undefined keeps the session's, null clears it (an accepted finish or deliver). */
async function save(ctx, dependencies, { open, parked, echo, pendingStart, question, pendingRefusal, finishedGoal }) {
  if (!ctx.persist) return [];
  const name = ctx.sessionName ?? ctx.file?.sessionName;
  const refusal = pendingRefusal === undefined ? ctx.file?.pendingRefusal : pendingRefusal;
  const kept = open && open.lifecycle !== "finished" ? open : null;
  // The goal this session last finished, while nothing else is open: a follow-up (--round) starts it again.
  const finished = finishedGoal ?? (kept ? undefined : ctx.file?.finishedGoal);
  const titleCache = titleCacheOf(dependencies, ctx.file);
  const ok = await writeSession(ctx.caller, dependencies, { open: kept, ...(titleCache && Object.keys(titleCache).length > 0 ? { titleCache } : {}), parked, lastEcho: echo, ...(pendingStart ? { pendingStart } : {}), ...(question ? { question } : {}), ...(refusal ? { pendingRefusal: refusal } : {}), ...(name ? { sessionName: name } : {}), ...(finished ? { finishedGoal: finished } : {}) });
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
  const onMac = command.config?.local === true && isLoopbackApiUrl(command.config.apiUrl);
  let sealerPromise;
  const sealer = () => (sealerPromise ??= workSealer({ client, config: command.config, dependencies, notes: sealNotes }));
  /** A sealed work is always sealed, a readable one never; a work not on the server yet seals when it can. */
  const sealMode = (work) => (work?.queued ? "auto" : work?.sealed ? "always" : "never");
  /** A spoken line rides the sealed card only; a readable work has none, and says so instead of dropping it. */
  const unsentSpoken = (spoken, work) => (spoken && sealMode(work) === "never"
    ? [onMac ? "--say was not sent: Relo for Mac says the goal and the outcome; a custom spoken line is not supported on this Mac yet"
      : "--say was not sent: this work is readable, and the spoken line travels only inside the end-to-end encrypted card"] : []);
  /** The whole line Relo for Mac says for this deliver or finish (ADR 0015); a readable work has no sealed gist, so the frame alone. */
  // ADR 0015 revision 1: how much Relo for Mac may say of this work (RELO_VOICE, this project's setting, relo voice, verbose).
  const voice = voiceSetting(dependencies);
  /** The card's sealed text, with the voice level; at off it carries no spoken gist. */
  const cardText = (work, extra = {}) => workCardText({ ...work, voice: voice.level }, voice.level === "off" ? { ...extra, spoken: undefined } : extra);
  /** The whole line Relo for Mac says for this deliver or finish; a readable work has no sealed gist, so the frame alone. */
  const macSays = (kind, work, spoken) => (voice.level === "off" ? "nothing (voice is off here)"
    : `"${spokenLine(kind, { goal: work.goal, name: work.spokenName, gist: sealMode(work) === "never" || voice.level === "brief" ? null : spoken })}"`);
  /** A line cut from the outcome: ask for one written for the ear next time. */
  const sayNudge = (said) => (said === undefined && ["full", "verbose"].includes(voice.level) ? ["the line above was cut from your outcome; write it for the ear next time: --say \"<what happened>\""] : []);
  const dryRun = Boolean(options["dry-run"]);
  if (!VERBS.includes(verb)) {
    if (verb === "heartbeat") guardWorkFlags({ verb, options, positionals: [], argv, caller: dependencies.caller, state: "nothing open" });
    throw new WorkRefusal("REFUSED_VERB", { what: `relo work has no "${verb ?? ""}"`, state: "verbs: start, update, pause, resume, deliver, handoff, finish (and relo state)", next: 'relo work start --goal "…"' });
  }
  const ctx = await scope(command, verb);
  const localState = stateLine(ctx.file?.open ?? null, ctx.file?.parked ?? []);
  guardWorkFlags({ verb, options, positionals: rest, argv, caller: ctx.caller, state: localState });
  for (const [name, value] of Object.entries(options)) {
    if (["help", "json", "full", "device", "scope"].includes(name) || command.allowed.includes(name)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value !== undefined && value !== false) throw new WorkRefusal("REFUSED_FLAG", { what: `--${name} is not a relo work ${verb} flag`, state: localState, next: `relo help` });
  }
  const api = dryRun ? undefined : worksClient(client, ctx.identity);
  // EDGE.3: queued writes go first, so order is kept; anything still queued puts this write behind it.
  const lane = dryRun ? undefined : declaredLane({ client, config: command.config, dependencies, identity: ctx.identity, sealer });
  const drained = lane ? await lane.drain() : { sent: 0, pending: 0 };
  const resync = Boolean(lane) && !lane.queued && (drained.sent > 0 || Boolean(ctx.file?.open?.queued));
  const now = new Date();
  // A refused finish or deliver rides on every echo until an accepted one clears it.
  const pendingRefusal = ctx.file?.pendingRefusal;
  const echoOf = (args) => renderEcho({ pendingRefusal, notch: onMac, ...args });

  /** `start --round` on a work whose last round is delivered: round n+1 with the plan's steps (the title stays local on a sealed work). */
  async function openNextRound({ open, existing, entries, progress }) {
    const title = filtered(() => checkText("label", options.round, { flag: "--round" }), localState, 'relo work start --round "<the request in a few words>"');
    const opened = openRoundPlan(open.plan, title, entries ?? [], entries?.length ? progress : undefined, localState);
    const next = { ...open, plan: opened.plan, status: null, waiting: null };
    const body = { goal: readable(open.goal), round: readable(title), ...(entries?.length ? { plan: { op: "set", steps: wireEntries(opened.tree) } } : {}), ...(entries?.length && progress ? { progress } : {}), context: await workContext(ctx, dependencies) };
    const labelOf = (id) => opened.plan.steps.find((x) => x.id === id)?.label;
    const carriedTop = opened.plan.steps.filter((x) => x.carriedFrom !== undefined && x.parent === undefined && opened.moved.added.includes(x.id));
    const notes = [...drainNotes(drained), ...(entries?.length ? splitWarnings(entryLabels(entries)) : []),
      ...(opened.carried ? [`carried ${opened.carried} unfinished step${opened.carried === 1 ? "" : "s"} from round ${opened.carriedFrom} into this round: ${carriedTop.map((x) => `${x.id} ${labelOf(x.id) ?? ""}`.trim()).join(", ")} (change them with relo work update --plan)`] : []),
      ...(opened.notCarried ? [`${opened.notCarried} unfinished step${opened.notCarried === 1 ? "" : "s"} from round ${opened.carriedFrom} were not carried; add them with --add if they still matter`] : [])];
    if (dryRun) return result(echoOf({ work: next, parked: existing.parked, disposition: "round_opened", notes, dryRun: true, now }), { disposition: "round_opened", work: next });
    const digest = createHash("sha256").update(JSON.stringify([open.id, title, entryLabels(entries ?? []), progress ?? null])).digest("hex");
    const pending = ctx.file?.pendingStart;
    const key = pending && pending.digest === digest && now - new Date(pending.at) < RETRY_WINDOW_MS ? pending.key : newIdempotencyKey();
    if (ctx.persist) await writeSession(ctx.caller, dependencies, { ...(ctx.file ?? {}), open: ctx.file?.open ?? null, parked: ctx.file?.parked ?? [], pendingStart: { digest, key, at: now.toISOString() } });
    const payload = await lane.write({
      route: WORK_ROUTES.start(), key, seal: sealMode(open), readable: body, sealedForm: sealedStart(body, opened.tree),
      opaque: body.context, withContext: true, named: body.context, card: cardText(next), copy: selfCopyText(next),
    });
    const response = payload ? view(payload, next) : { work: next, parked: existing.parked, disposition: "round_opened" };
    const work = response.work ?? next;
    const parked = response.parked ?? existing.parked;
    const echo = echoOf({ work, parked, disposition: response.disposition ?? "round_opened", notes, handle: handleOf(ctx, work), queued: !payload, now });
    await save(ctx, dependencies, { open: work, parked, echo });
    return result(echo, { disposition: response.disposition ?? "round_opened", work, parked, queued: !payload });
  }

  /** `start --from <handle>`: this session takes over the work another session of this computer handed off. */
  // `adopted`: a plain start named the goal a session of this project handed off, so it takes that work over.
  async function takeOver({ adopted } = {}) {
    if (!ctx.persist) throw new WorkRefusal("REFUSED_NO_SESSION", { what: `--from takes over a handed-off work, and this shell has no session id (${harnessName(ctx.caller)})`, state: localState, next: 'relo work start --goal "…"' });
    for (const flag of adopted ? [] : ["goal", "round", "plan", "progress", "status", "new"]) {
      if (options[flag] !== undefined && options[flag] !== false) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: `--${flag} and --from contradict each other: the handed-off work keeps its goal and plan`, state: localState, next: `relo work start --from ${String(options.from)}` });
    }
    const handle = String(adopted?.handle ?? options.from).trim();
    if (!HANDLE_FORMAT.test(handle)) throw new WorkRefusal("REFUSED_HANDLE", { what: "that is not a handoff handle (it starts with rh_ and is printed by relo work handoff)", state: localState, next: 'relo work start --goal "…"' });
    const pending = await readPendingHandoff(dependencies, dependencies.cwd, now.getTime());
    const known = pending?.handle === handle ? pending : undefined;
    if (dryRun) {
      const work = { id: known?.workId ?? "wrk_00000000", goal: known?.goal ?? "(the handed-off work)", status: known?.status ?? null, plan: { v: 1, next: 1, steps: [] }, lifecycle: "open" };
      return result(echoOf({ work, disposition: "taken_over", notes: ["would take over the handed-off work"], dryRun: true, now }), { disposition: "taken_over", work });
    }
    if (lane.queued) throw new WorkRefusal("REFUSED_QUEUED", { what: "changes of this session are still queued and not sent, so the order would break", state: localState, next: `relo state   then relo work start --from ${handle}` });
    let payload;
    try {
      payload = await api.send(WORK_ROUTES.start(), { from: handle }, newIdempotencyKey());
    } catch (error) {
      if (offline(error)) throw new WorkRefusal("REFUSED_OFFLINE", { what: "taking over a work needs the server, and it could not be reached", state: "nothing changed", next: `relo work start --from ${handle}`, exitCode: EXIT.NETWORK });
      if (["HANDOFF_INVALID", "HANDOFF_FINISHED"].includes(error?.code)) await clearPendingHandoff(dependencies, dependencies.cwd, handle);
      throw error;
    }
    // Text the server cannot read comes back from this computer: its own sealed copy, then the pending file.
    const key = payload?.work?.producerSealed ? await loadSelfKey(dependencies) : null;
    let work = restoreFromSelfCopy(payload?.work ?? null, key);
    if (work && known) {
      work = { ...work, goal: work.goal ?? known.goal ?? null, status: work.status ?? known.status ?? null, plan: work.plan ? restoredPlan(work.plan, known.copy ?? {}) : work.plan };
    }
    const parked = payload?.parked ?? [];
    const notes = [...drainNotes(drained), "took over the work another session handed off; it is this session's now, and the card goes on"];
    if (adopted) notes.push("a session here handed off this same goal, so this start took it over instead of opening a second card (its plan goes on; --plan was not applied)");
    if (parked.length && payload?.disposition === "taken_over") notes.push("this session's own open work was parked (relo work resume brings it back)");
    const echo = echoOf({ work, parked, disposition: payload?.disposition ?? "taken_over", notes, now, pendingRefusal: undefined });
    await clearPendingHandoff(dependencies, dependencies.cwd, handle);
    await save(ctx, dependencies, { open: work, parked, echo, pendingRefusal: null });
    return result(echo, { disposition: payload?.disposition ?? "taken_over", work, parked });
  }

  if (verb === "start" && options.from !== undefined) return takeOver();

  // A start that names the goal a session of this project just handed off takes that work over: otherwise the handed-off
  // card stays open with nobody behind it while a second card for the same goal runs beside it.
  if (verb === "start" && options.round === undefined && typeof options.goal === "string" && ctx.persist && !dryRun) {
    const pending = await readPendingHandoff(dependencies, dependencies.cwd, now.getTime());
    const same = (a, b) => String(a ?? "").replace(/\s+/gu, " ").trim().toLowerCase() === String(b ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
    if (pending?.handle && pending.goal && same(pending.goal, options.goal)) return takeOver({ adopted: { handle: pending.handle } });
  }

  if (verb === "start") {
    const wantsRound = options.round !== undefined;
    // --round continues the open goal, so it needs no --goal: the open work is read first.
    let existing = wantsRound && options.goal === undefined && ctx.persist ? await current(ctx, api, { sync: !ctx.file || resync, tolerateOffline: true }) : undefined;
    // A follow-up on the goal this session just finished: a fresh work for the same goal (finished work is not reopened).
    const followsFinished = wantsRound && options.goal === undefined && !existing?.open && ctx.file?.finishedGoal ? ctx.file.finishedGoal : null;
    if (wantsRound && options.goal === undefined && !existing?.open && !followsFinished) {
      throw new WorkRefusal("REFUSED_NO_OPEN_WORK", { what: "--round opens the next round of an open goal, and this session has none", state: localState, next: 'relo work start --goal "…" [--plan "A,B,C"]' });
    }
    const goal = followsFinished ? followsFinished : options.goal === undefined && existing?.open ? existing.open.goal : filtered(() => checkText("goal", options.goal, { flag: "--goal" }), localState, 'relo work start --goal "…"');
    const status = options.status === undefined ? undefined : filtered(() => checkText("status", options.status, { goal }), localState, textNext("relo work start", "--status", options.status, FACTS.work.statusMax, `relo work start --goal "${goal}" --status "…"`));
    const spokenName = options["spoken-name"] === undefined ? undefined : filtered(() => checkSpoken("name", checkText("name", options["spoken-name"], { flag: "--spoken-name" }), "--spoken-name"), localState, `relo work start --goal "${goal}" --spoken-name "Notch redesign"`);
    const entries = options.plan === undefined ? undefined : planEntries(options.plan, localState, `relo work start --goal "${goal}" --plan "…"`);
    const labels = entries ? entryLabels(entries) : undefined;
    const splitNotes = labels ? splitWarnings(labels) : [];
    if (options.plan !== undefined && !labels.length) throw new WorkRefusal("CONTENT_REFUSED", { what: "--plan is empty", state: localState, next: `relo work start --goal "${goal}" --plan "Reproduce the bug,Find the cause"` });
    const progress = options.progress === undefined ? undefined : parseCount(options.progress, localState);
    existing ??= ctx.persist ? await current(ctx, api, { sync: !ctx.file || resync, tolerateOffline: true }) : { open: null, parked: [] };
    const open = existing.open?.lifecycle === "open" ? existing.open : null;
    const delivered = Boolean(open) && isDelivered(open) && !options.new;
    if (open && delivered && wantsRound) {
      if (options.goal !== undefined && goal.toLowerCase() !== String(open.goal ?? "").toLowerCase()) {
        throw new WorkRefusal("REFUSED_GOAL_MISMATCH", { what: `--round continues the open goal "${open.goal}", and "${goal}" is a different goal`, state: stateLine(open, existing.parked), next: `relo work start --new --goal "${goal}"  |  relo work start --round "${fitText(String(options.round), 60)}"` });
      }
      return openNextRound({ open, existing, entries, progress });
    }
    if (open && delivered) {
      const round = lastRound(open.plan);
      const title = round.title ?? (round.n === 1 ? open.goal : undefined);
      throw new WorkRefusal("REFUSED_ROUND_REQUIRED", { what: `round ${round.n}${title ? ` "${title}"` : ""} of ${shortId(open.id)} is delivered${round.outcome ? ` ("${round.outcome}")` : ""}, so a follow-up on this goal opens a new round`, state: stateLine(open, existing.parked), next: 'relo work start --round "<the request in a few words>" --plan "…"  |  a new goal: relo work start --new --goal "…"' });
    }
    if (open && !options.new) {
      const notes = drainNotes(drained);
      if (String(open.goal ?? "").toLowerCase() === goal.toLowerCase()) notes.push("this goal is already open; nothing changed.");
      else {
        notes.push(`open work is "${open.goal}". You passed "${goal}". Nothing changed.`);
        notes.push(`same goal → relo work update --goal "${goal}"; new goal → relo work start --new --goal "${goal}"`);
      }
      for (const flag of ["plan", "progress", "status", "spoken-name"]) if (options[flag] !== undefined) notes.push(`--${flag} was ignored on a continuing start; to revise: relo work update --${flag} "…"`);
      if (wantsRound) notes.push(`--round was ignored: round ${lastRound(open.plan).n} is still open; deliver it first (relo work deliver --outcome "…"), then start --round`);
      const echo = echoOf({ work: open, parked: existing.parked, disposition: "continuing", notes, now });
      return result(echo, { disposition: "continuing", work: open, parked: existing.parked });
    }
    const { plan, tree } = startPlan(entries, labels ? progress : undefined, localState);
    const body = { goal: readable(goal), ...(status ? { status: readable(status) } : {}), ...(plan ? { plan: { op: "set", steps: wireEntries(tree) } } : {}), ...(progress ? { progress } : {}), ...(options.new ? { new: true } : {}), context: await context(dependencies) };
    const named = body.context.threadName;
    // ADR 0015: without a spoken name Relo for Mac calls the work by the goal's first words; say which, so the agent can do better.
    const nameNote = spokenName || voice.level === "off" ? [] : [`Relo for Mac calls this work "${nameAloud(goal)}" aloud; a better name: relo work update --spoken-name "<2 to 4 words>"`];
    const notes = [...drainNotes(drained), voiceNote(voice), ...nameNote, ...(options.new && !open ? ["--new had nothing to park"] : []), ...(followsFinished ? [`"${goal}" was finished, so this follow-up starts a new card for it`] : wantsRound ? ["--round was ignored: there was no open goal to continue"] : []), ...splitNotes];
    if (dryRun) {
      const work = { id: "wrk_00000000", goal, ...(spokenName ? { spokenName } : {}), status, plan, progress: plan ? undefined : progress, lifecycle: "open" };
      return result(echoOf({ work, disposition: "started", notes, dryRun: true, now }), { disposition: "started", work });
    }
    const digest = createHash("sha256").update(JSON.stringify([goal, labels ?? null, progress ?? null])).digest("hex");
    const pending = ctx.file?.pendingStart;
    const key = pending && pending.digest === digest && now - new Date(pending.at) < RETRY_WINDOW_MS ? pending.key : newIdempotencyKey();
    if (ctx.persist) await writeSession(ctx.caller, dependencies, { ...(ctx.file ?? {}), open: ctx.file?.open ?? null, parked: ctx.file?.parked ?? [], pendingStart: { digest, key, at: now.toISOString() } });
    // Sealed (when this computer has a phone to seal for): the text rides the card and the self copy; plan
    // entries carry predicted ids; project, topic and computer go as handles whose names ride the card.
    const payload = await lane.write({
      route: WORK_ROUTES.start(), key, seal: "auto", readable: body,
      sealedForm: sealedStart(body, tree ?? []),
      opaque: body.context, withContext: true, named: body.context,
      card: cardText({ goal, spokenName, status, plan }),
      copy: selfCopyText({ goal, spokenName, status, plan }),
    });
    if (named) ctx.sessionName = named;
    if (!payload) {
      // Queued: the local copy is the working copy until the server has it.
      const work = { id: QUEUED_ID, queued: true, version: 0, goal, ...(spokenName ? { spokenName } : {}), status: status ?? null, plan, progress: plan ? null : progress ?? null, lifecycle: "open" };
      const parked = open ? [{ ...open, lifecycle: "paused", pausedReason: "parked" }, ...existing.parked] : existing.parked;
      if (open) notes.push(`parks ${shortId(open.id)} "${open.goal}" once sent`);
      const disposition = open ? "switched" : "started";
      const echo = echoOf({ work, parked, disposition, notes, queued: true, now, pendingRefusal: undefined });
      await save(ctx, dependencies, { open: work, parked, echo, pendingRefusal: null });
      return result(echo, { disposition, work, parked, queued: true });
    }
    const response = view(payload, { id: undefined });
    let work = response.work;
    if (work) work = withLocalLabels(work, { id: work.id, goal, spokenName, status, plan });
    if (open && response.disposition === "switched") notes.push(`parked ${shortId(open.id)} "${open.goal}"; its card left ${onMac ? "the notch" : "the Lock Screen"}.`);
    const handle = handleOf(ctx, work);
    const echo = echoOf({ work, parked: response.parked, disposition: response.disposition ?? "started", notes, handle, now, pendingRefusal: undefined });
    // A new work leaves any refused finish of the parked one behind.
    await save(ctx, dependencies, { open: work, parked: response.parked, echo, pendingRefusal: null });
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
      if (dryRun) return result(echoOf({ work: { ...work, lifecycle: "open" }, disposition: "resumed", dryRun: true, now }), { disposition: "resumed", work });
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
      const echo = echoOf({ work: response.work, parked: response.parked, disposition: "resumed", notes, handle: handleOf(ctx, response.work), queued: !payload, now });
      await save(ctx, dependencies, { open: response.work, parked: response.parked, echo });
      return result(echo, { disposition: "resumed", work: response.work, parked: response.parked, queued: !payload });
    }
  }

  const state = await current(ctx, api, { sync: (!ctx.file || Boolean(ctx.handle) || resync) && !dryRun });
  const sline = stateLine(state.open, state.parked);
  const parkedNext = state.parked[0] ? `  |  relo work resume ${shortId(state.parked[0].id)}` : "";
  const noOpen = () => new WorkRefusal("REFUSED_NO_OPEN_WORK", { what: "this session has no open work", state: state.parked[0] ? `parked: ${shortId(state.parked[0].id)} "${state.parked[0].goal}"` : "nothing open", next: `relo work start --goal "…"${parkedNext}` });

  /** A refused finish or deliver is kept in the session file: every later echo repeats it until an accepted one clears it. An open-steps refusal is a question about the plan, not a failure to chase: it is never kept. */
  async function recorded(name, fn) {
    try { return await fn(); } catch (error) {
      if (error instanceof WorkRefusal && ctx.persist && state.open && !options.work && !["REFUSED_NO_OPEN_WORK", "REFUSED_OPEN_STEPS", "OPEN_STEPS"].includes(error.code)) {
        const refusal = { verb: name, code: error.code, what: error.what, at: now.toISOString(), next: error.next };
        await writeSession(ctx.caller, dependencies, { ...(ctx.file ?? {}), open: state.open, parked: state.parked, pendingRefusal: refusal });
      }
      throw error;
    }
  }

  if (verb === "finish") return recorded("finish", async () => {
    if (options.outcome === undefined) throw new WorkRefusal("REFUSED_NO_OUTCOME", { what: "finishing needs an outcome: what happened, in the owner's words", state: sline, next: 'relo work finish --outcome "…"  |  relo work finish --failed --outcome "…"' });
    if (options.failed && options.dropped) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--failed and --dropped contradict each other", state: sline, next: 'relo work finish --failed --outcome "…"' });
    const command = `relo work finish${options.failed ? " --failed" : options.dropped ? " --dropped" : ""}`;
    const outcome = filtered(() => checkText("outcome", options.outcome, { flag: "--outcome" }), sline, textNext(command, "--outcome", options.outcome, FACTS.work.outcomeMax, 'relo work finish --outcome "0.17 built and tested"'));
    const urgent = options.failed === true;
    const said = options.say === undefined ? undefined : filtered(() => checkSpoken("spoken", checkText("spoken", options.say, { flag: "--say" }), "--say", { urgent }), sline, `${command} --outcome "…" --say "…"`);
    // ADR 0015: the gist Relo for Mac says after "<Kind>: <name>.", the agent's --say or the outcome shortened.
    const spoken = said === undefined ? outcomeGist(outcome, { urgent }) : saidGist(said);
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
    const { plan } = finishPlan(target.plan, resultKind, outcome);
    const finished = { ...target, plan, status: null, waiting: null, lifecycle: "finished", result: resultKind, outcome };
    if (dryRun) return result(echoOf({ work: finished, dryRun: true, now }), { disposition: "finished", work: finished });
    let payload;
    try {
      payload = await lane.write({
        route: WORK_ROUTES.finish(routeId(target)), key: newIdempotencyKey(), seal: sealMode(target),
        readable: { result: resultKind, outcome: readable(outcome) }, sealedForm: { result: resultKind, outcome: SEALED },
        named: await workContext(ctx, dependencies), card: cardText({ ...target, plan }, { status: outcome, spoken }),
        outcomeNotice: { title: target.goal, summary: outcome },
      });
    } catch (error) {
      if (error?.status === 404) throw new WorkRefusal("NOT_FOUND", { what: `no work ${shortId(target.id)} in this session`, state: sline, next: "relo state" });
      throw error;
    }
    const response = payload ? view(payload, target) : { work: null, parked: undefined };
    const work = response.work ? { ...response.work, status: null } : finished;
    const remaining = target === state.open ? null : state.open;
    const parked = response.parked ?? state.parked.filter((p) => p.id !== target.id);
    const says = resultKind === "dropped" ? undefined : macSays(resultKind, target, spoken);
    const echo = renderEcho({ work: { ...work, result: work.result ?? resultKind, outcome: work.outcome ?? outcome }, parked, notes: [...drainNotes(drained), ...unsentSpoken(said, target), ...(says ? sayNudge(said) : [])], queued: !payload, now, saysLine: says, notch: onMac });
    await save(ctx, dependencies, { open: remaining, parked, echo, pendingRefusal: null, finishedGoal: remaining ? undefined : target.goal ?? undefined });
    return result(echo, { disposition: "finished", work, parked, queued: !payload });
  });

  if (!state.open || state.open.lifecycle === "finished") throw noOpen();
  const open = state.open;

  if (verb === "deliver") return recorded("deliver", async () => {
    if (open.lifecycle === "paused") throw new WorkRefusal("REFUSED_PAUSED", { what: `${shortId(open.id)} is paused`, state: sline, next: "relo work resume" });
    if (options.outcome === undefined) throw new WorkRefusal("REFUSED_NO_OUTCOME", { what: "delivering needs an outcome: what this round delivered, in the owner's words", state: sline, next: 'relo work deliver --outcome "…"' });
    if (isDelivered(open)) {
      const round = lastRound(open.plan);
      throw new WorkRefusal("REFUSED_ALREADY_DELIVERED", { what: `round ${round.n} is already delivered${round.outcome ? ` ("${round.outcome}")` : ""}`, state: sline, next: 'relo work start --round "<the request in a few words>" --plan "…"  |  the goal is done: relo work finish --outcome "…"' });
    }
    const outcome = filtered(() => checkText("outcome", options.outcome, { flag: "--outcome" }), sline, textNext("relo work deliver", "--outcome", options.outcome, FACTS.work.outcomeMax, 'relo work deliver --outcome "0.17 built and tested"'));
    const said = options.say === undefined ? undefined : filtered(() => checkSpoken("spoken", checkText("spoken", options.say, { flag: "--say" }), "--say"), sline, 'relo work deliver --outcome "…" --say "…"');
    const spoken = said === undefined ? outcomeGist(outcome) : saidGist(said);
    const dropRest = options["drop-rest"] === true;
    const { plan, notes: dropNotes } = deliverPlan(open.plan, outcome, { dropRest, state: sline });
    const delivered = { ...open, plan, status: null, waiting: null };
    if (dryRun) return result(echoOf({ work: delivered, disposition: "delivered", notes: dropNotes, dryRun: true, now }), { disposition: "delivered", work: delivered });
    const payload = await lane.write({
      route: WORK_ROUTES.deliver(routeId(open)), key: newIdempotencyKey(), seal: sealMode(open),
      readable: { outcome: readable(outcome), ...(dropRest ? { dropRest: true } : {}) }, sealedForm: { outcome: SEALED, ...(dropRest ? { dropRest: true } : {}) },
      named: await workContext(ctx, dependencies), card: cardText(delivered, { status: outcome, spoken }), copy: selfCopyText(delivered),
      outcomeNotice: { title: open.goal, summary: outcome },
    });
    const response = payload ? view(payload, delivered) : { work: delivered, parked: state.parked };
    const work = response.work ? { ...response.work, status: null } : delivered;
    const parked = response.parked ?? state.parked;
    const echo = renderEcho({ work, parked, disposition: "delivered", notes: [...drainNotes(drained), ...dropNotes, ...unsentSpoken(said, open), ...sayNudge(said)], handle: handleOf(ctx, work), queued: !payload, now, saysLine: macSays("yourTurn", open, spoken), notch: onMac });
    await save(ctx, dependencies, { open: work, parked, echo, pendingRefusal: null });
    return result(echo, { disposition: "delivered", work, parked, queued: !payload });
  });

  if (verb === "handoff") return recorded("handoff", async () => {
    if (!ctx.persist) throw new WorkRefusal("REFUSED_NO_SESSION", { what: `handing off needs a session id, and this shell has none (${harnessName(ctx.caller)})`, state: sline, next: "relo state" });
    if (open.lifecycle === "paused") throw new WorkRefusal("REFUSED_PAUSED", { what: `${shortId(open.id)} is paused`, state: sline, next: "relo work resume" });
    if (options.next === undefined) throw new WorkRefusal("REFUSED_NO_NEXT", { what: "a handoff needs a note: what the next session should do", state: sline, next: 'relo work handoff --next "<what to do next, in a few words>"' });
    if (isDelivered(open)) {
      const round = lastRound(open.plan);
      throw new WorkRefusal("REFUSED_ALREADY_DELIVERED", { what: `round ${round.n} is already delivered, so there is nothing to hand off`, state: sline, next: 'a follow-up: relo work start --round "<the request in a few words>" --plan "…"  |  the goal is done: relo work finish --outcome "…"' });
    }
    const limit = FACTS.work.statusMax - HANDOFF_PREFIX.length;
    const next = filtered(() => {
      const length = Array.from(String(options.next).replace(/\s+/gu, " ").trim()).length;
      if (length > limit) throw Object.assign(new UsageError(`Refused: --next is ${length} characters; the limit is ${limit}. Say it shorter.`), { code: "CONTENT_REFUSED" });
      return checkText("status", options.next, { flag: "--next", goal: open.goal });
    }, sline, textNext("relo work handoff", "--next", options.next, limit, 'relo work handoff --next "<what to do next, in a few words>"'));
    const note = `${HANDOFF_PREFIX}${next}`;
    const handed = { ...open, status: note };
    const ownerLine = `Owner sees: "${quoted(note)}"`;
    const nextLine = 'Next: this session no longer owns the work. A new goal here: relo work start --goal "…"';
    if (dryRun) return result(echoOf({ work: handed, parked: state.parked, disposition: "handed_off", dryRun: true, now, ownerLine, nextOverride: nextLine }), { disposition: "handed_off", work: handed });
    if (lane.queued) throw new WorkRefusal("REFUSED_QUEUED", { what: "changes of this session are still queued and not sent, so the order would break", state: sline, next: `relo state   then relo work handoff --next "${quoted(next)}"` });
    // Sent now, never queued: the handle comes back in the answer and a queued handoff could not hand it over.
    let payload;
    try {
      const body = await materialize({
        seal: sealMode(open), readable: { next: readable(note) }, sealedForm: { next: SEALED },
        named: await workContext(ctx, dependencies), card: cardText(handed, { status: note }), copy: selfCopyText(handed),
      }, sealer);
      payload = await api.send(WORK_ROUTES.handoff(routeId(open)), body, newIdempotencyKey());
    } catch (error) {
      if (offline(error)) throw new WorkRefusal("REFUSED_OFFLINE", { what: "a handoff needs the server to give the handle, and it could not be reached", state: "nothing changed", next: `relo work handoff --next "${quoted(next)}"`, exitCode: EXIT.NETWORK });
      if (error?.status === 404) throw new WorkRefusal("NOT_FOUND", { what: `no work ${shortId(open.id)} in this session`, state: sline, next: "relo state" });
      throw error;
    }
    const handle = payload?.handoff?.handle;
    if (!handle) throw new WorkRefusal("HANDOFF_FAILED", { what: "the server answered without a handle (is it older than this CLI?)", state: "the work is unchanged", next: "relo doctor", exitCode: EXIT.API });
    const work = payload.work ? withLocalLabels(payload.work, handed) : handed;
    const round = lastRound(work.plan);
    const stored = await writePendingHandoff(dependencies, dependencies.cwd, {
      handle, workId: work.id, goal: work.goal ?? open.goal ?? null, round: { n: round.n, ...(round.title ? { title: round.title } : {}) },
      next, status: note, fromSession: sessionHash(ctx.caller.sessionKey), createdAt: now.toISOString(),
      expiresAt: payload.handoff.expiresAt ?? new Date(now.getTime() + 24 * 3_600_000).toISOString(), copy: selfCopyText(work),
    });
    const parked = payload.parked ?? state.parked;
    const handoffLine = `Handoff: in the next session on this computer, run: relo work start --from ${handle}`;
    const echo = echoOf({ work, parked, disposition: "handed_off", notes: [...drainNotes(drained), ...(stored ? [] : ["could not save the handoff on this computer; pass the handle to the next session yourself"])], now, handoffLine, ownerLine, nextOverride: nextLine, pendingRefusal: undefined });
    // The old session no longer owns the work.
    await save(ctx, dependencies, { open: null, parked, echo, pendingRefusal: null });
    return result(echo, { disposition: "handed_off", work, parked, extra: { handoff: { handle, expiresAt: payload.handoff.expiresAt } } });
  });

  if (verb === "pause") {
    if (open.lifecycle === "paused") throw new WorkRefusal("REFUSED_PAUSED", { what: `${shortId(open.id)} is already paused`, state: `paused: "${open.status ?? ""}"`, next: "relo work resume" });
    if (options.status === undefined) throw new WorkRefusal("REFUSED_NO_REASON", { what: "pausing needs a reason: --status says why", state: sline, next: 'relo work pause --status "…"' });
    const status = filtered(() => checkText("status", options.status, { goal: open.goal }), sline, textNext("relo work pause", "--status", options.status, FACTS.work.statusMax, 'relo work pause --status "…"'));
    if (dryRun) return result(echoOf({ work: { ...open, status, lifecycle: "paused" }, disposition: "paused", dryRun: true, now }), { disposition: "paused", work: open });
    const paused = { ...open, status, lifecycle: "paused", pausedReason: "declared" };
    const payload = await lane.write({
      route: WORK_ROUTES.pause(routeId(open)), key: newIdempotencyKey(), seal: sealMode(open),
      readable: { status: readable(status) }, sealedForm: { status: SEALED }, named: await workContext(ctx, dependencies),
      card: cardText(open, { status }), copy: selfCopyText(paused),
    });
    const response = payload ? view(payload, paused) : { work: paused, parked: state.parked };
    const work = response.work ?? paused;
    const echo = echoOf({ work, parked: response.parked, disposition: "paused", notes: drainNotes(drained), handle: handleOf(ctx, work), queued: !payload, now });
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
    ...(options.plan !== undefined ? { plan: planEntries(options.plan, sline, 'relo work update --plan "…"') } : {}),
    ...(options.add !== undefined ? { add: planEntries(options.add, sline, 'relo work update --add "…"') } : {}),
    ...(options.under !== undefined ? { under: String(options.under).trim() } : {}),
    ...(options.after !== undefined ? { after: String(options.after).trim() } : {}),
    ...(options.detail !== undefined ? { detail: filtered(() => checkText("stepDetail", options.detail, { flag: "--detail", words: false }), sline, textNext("relo work update", "--detail", options.detail, FACTS.work.detailMax, 'relo work update --detail "…"')) } : {}),
    ...(stepValue !== undefined ? { step: String(stepValue).trim() } : {}),
    ...(options.progress !== undefined ? { progress: parseCount(options.progress, sline) } : {}),
  };
  if (change.under !== undefined && !change.add) throw new WorkRefusal("REFUSED_UNDER_WITHOUT_ADD", { what: "--under says where --add puts new steps, and there is no --add", state: sline, next: 'relo work update --add "…" --under s3' });
  if (change.after !== undefined && !change.add) throw new WorkRefusal("REFUSED_UNDER_WITHOUT_ADD", { what: "--after says where --add puts new steps, and there is no --add", state: sline, next: 'relo work update --add "…" --after s3' });
  if (change.plan && !change.plan.length) throw new WorkRefusal("CONTENT_REFUSED", { what: "--plan is empty", state: sline, next: 'relo work update --plan "…"' });
  const goal = options.goal === undefined ? undefined : filtered(() => checkText("goal", options.goal, { flag: "--goal" }), sline, 'relo work update --goal "…"');
  const status = options.status === undefined ? undefined : filtered(() => checkText("status", options.status, { goal: goal ?? open.goal }), sline, textNext("relo work update", "--status", options.status, FACTS.work.statusMax, 'relo work update --status "…"'));
  const waiting = options.waiting === undefined ? undefined : filtered(() => checkText("waiting", options.waiting, { flag: "--waiting" }), sline, 'relo work update --waiting "CI"');
  const spokenName = options["spoken-name"] === undefined ? undefined : filtered(() => checkSpoken("name", checkText("name", options["spoken-name"], { flag: "--spoken-name" }), "--spoken-name"), sline, 'relo work update --spoken-name "Notch redesign"');
  if (!Object.keys(change).length && goal === undefined && status === undefined && waiting === undefined && spokenName === undefined && !options["not-waiting"]) {
    throw new WorkRefusal("REFUSED_NO_CHANGE", { what: "relo work update needs at least one change", state: sline, next: 'relo work update --status "…"  |  relo work update --next-step' });
  }
  const planned = Boolean(open.plan?.steps?.length) || Boolean(change.plan) || Boolean(change.add);
  const build = (base) => {
    const labelsKnown = !base.plan?.steps?.some((s) => s.label == null);
    const planChange = { ...change, ...(planned ? {} : { progress: undefined }) };
    const outcome = Object.keys(planChange).some((k) => planChange[k] !== undefined) ? applyChange(base.plan ?? null, planChange, labelsKnown, sline) : { plan: base.plan ?? null, notes: [], moved: { added: [] } };
    const notes = [...outcome.notes, ...splitWarnings([...entryLabels(change.plan ?? []), ...entryLabels(change.add ?? [])]), ...(outcome.moved.added ?? []).filter(() => base.plan?.steps?.length).map((id) => `added ${id} ${outcome.plan.steps.find((s) => s.id === id)?.label ?? ""}`.trim())];
    // The server takes one plan command per request: one PATCH per plan change, text on the first,
    // progress on the last (it lands on the current step when the work has a plan).
    const stepId = change.step === undefined ? undefined
      : /^s\d+$/u.test(change.step) ? change.step : outcome.plan?.steps?.find((s) => s.state === "current")?.id;
    const commands = planCommands(change, stepId, { trees: outcome.trees, sealed: sealMode(base) === "always", under: outcome.moved?.under, after: outcome.moved?.after });
    const text = {
      ...(goal !== undefined ? { goal: readable(goal) } : {}),
      ...(status !== undefined ? { status: readable(status) } : {}),
      ...(waiting !== undefined ? { waiting: { reason: readable(waiting) } } : options["not-waiting"] ? { waiting: null } : {}),
    };
    const body = planBodies(commands, { baseVersion: base.version, ...text }, change.progress);
    const next = { ...base, ...(goal !== undefined ? { goal } : {}), ...(spokenName !== undefined ? { spokenName } : {}), ...(status !== undefined ? { status } : {}), ...(waiting !== undefined ? { waiting } : options["not-waiting"] ? { waiting: null } : {}), plan: outcome.plan, ...(change.progress && !planned ? { progress: change.progress } : {}) };
    return { body, next, notes, trees: outcome.trees ?? {} };
  };
  if (dryRun) {
    const { next, notes } = build(open);
    return result(echoOf({ work: next, parked: state.parked, disposition: "updated", notes, dryRun: true, now }), { disposition: "updated", work: next });
  }
  let notes = [];
  let local;
  let queued = false;
  const name = renamed(ctx, dependencies);
  const named = await workContext(ctx, dependencies, name);
  const response = await withRetry(async (fresh) => {
    const base = fresh ?? open;
    const built = build(base);
    notes = built.notes;
    local = built.next;
    const seal = sealMode(base);
    let payload;
    for (const [i, body] of built.body.entries()) {
      // A renamed session refreshes the card's topic (plan 3.7), on the first request of the update.
      const readableBody = i === 0 && name !== undefined ? { ...body, context: { threadName: name } } : body;
      const sealedBody = sealedUpdate(body, { trees: built.trees });
      const sent = await lane.write({
        route: WORK_ROUTES.update(routeId(base)), key: newIdempotencyKey(), seal, readable: readableBody, sealedForm: sealedBody,
        ...(name !== undefined ? { opaque: { threadName: name }, withContext: i === 0 } : {}),
        named, card: cardText(built.next), copy: selfCopyText(built.next),
      });
      if (sent) payload = sent; else queued = true;
    }
    return queued ? { work: null } : view(payload, local);
  }, async () => (await current(ctx, api, { sync: true })).open ?? open, sline, argv);
  if (name) ctx.sessionName = name;
  const work = response.work ? withLocalLabels(response.work, local) : local;
  const parked = response.parked ?? state.parked;
  const nameNote = spokenName !== undefined && sealMode(open) === "never"
    ? [onMac ? "--spoken-name was not sent: a custom spoken name is not supported on this Mac yet"
      : "--spoken-name was not sent: this work is readable, and the spoken name travels only inside the end-to-end encrypted card"] : [];
  const echo = echoOf({ work, parked, disposition: response.disposition ?? "updated", notes: [...drainNotes(drained), ...notes, ...nameNote], handle: handleOf(ctx, work), queued, now });
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
  if (!sync && ctx.file?.writtenAt && Date.now() - new Date(ctx.file.writtenAt) > T_RETIRE_MS) {
    const at = new Date(ctx.file.writtenAt);
    lines.push(`Local copy from ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}, possibly stale: relo state --sync`);
  }
  lines.push(renderEcho({ pendingRefusal: ctx.file?.pendingRefusal, work: state.open, parked: state.parked, notes: drainNotes(drained), lane: await laneSummary(dependencies), notch: isLoopbackApiUrl(command.config?.apiUrl) && command.config?.local === true, handle: ctx.token && state.open ? printHandle(state.open.id, ctx.token) : undefined }));
  const waiting = ctx.persist ? await readPendingHandoff(dependencies, dependencies.cwd) : undefined;
  if (waiting && waiting.fromSession !== sessionHash(ctx.caller.sessionKey)) {
    lines.push(`Handoff waiting for this project: "${quoted(waiting.goal ?? "a work")}", next: "${quoted(waiting.next)}". Continue it: relo work start --from ${waiting.handle}`);
  }
  const echo = lines.join("\n");
  if (sync) await save(ctx, dependencies, { open: state.open, parked: state.parked, echo });
  return result(echo, { disposition: undefined, work: state.open, parked: state.parked });
}
