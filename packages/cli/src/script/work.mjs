// `relo work …` and `relo state` for scripts and apps (plan 04 §2.9): the same verbs scoped to a producer
// key, plus `heartbeat`. Wire: /api/producers/<sha256("producer:"+KEY) base64url>/works… (server 2.9).
// A script seals like an agent (ADR 0005): with a trusted phone its text rides the sealed card and its own
// self copy, and the server stores {sealed: true} (work/sealed-form.mjs, work/declared-lane.mjs materialize).
import { randomUUID } from "node:crypto";
import { SEALED, workCardText, workSealer } from "../crypto/seal-work.mjs";
import { loadSelfKey, restoreFromSelfCopy, selfCopyText } from "../crypto/self-copy.mjs";
import { dryRunResult, result } from "../shared/outcome.mjs";
import { parseDuration } from "../shared/validate.mjs";
import { FACTS } from "../shared/facts.generated.mjs";
import { materialize } from "../work/declared-lane.mjs";
import { applyChange, finishPlan, parseCount, planBodies, planCommands, splitLabels, startPlan } from "../work/plan.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { readable, sealedStart, sealedText, sealedUpdate } from "../work/sealed-form.mjs";
import { producerPathKey, resolveProducer } from "./producer.mjs";

const { minSeconds: LEASE_MIN, maxSeconds: LEASE_MAX, defaultSeconds: LEASE_DEFAULT_SECONDS } = FACTS.lease;

/** `--lease 15m` → seconds within the lease bounds (at most T_retire); the default from the facts. */
export function leaseSeconds(value) {
  if (value === undefined) return LEASE_DEFAULT_SECONDS;
  let seconds;
  try { seconds = parseDuration(value, { minimumSeconds: LEASE_MIN, maximumSeconds: LEASE_MAX }); } catch { seconds = undefined; }
  if (seconds === undefined) {
    throw new WorkRefusal("LEASE_INVALID", { what: `--lease is ${LEASE_MIN / 60}m to ${LEASE_MAX / 60}m (a dead producer is retired within an hour)`, state: `--lease ${value}`, next: "relo work heartbeat --lease 15m" });
  }
  return seconds;
}

function text(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new WorkRefusal("TEXT_REQUIRED", { what: `${flag} needs text`, state: "nothing sent", next: `relo work … ${flag} "…"` });
  return value.trim();
}

const norm = (label) => String(label ?? "").trim().replace(/\s+/gu, " ").toLowerCase();

/** `--step X`: an id as given, or the step of the work's plan with that label. */
function stepId(value, work, state) {
  const wanted = String(Array.isArray(value) ? value[0] : value).trim();
  if (/^s\d+$/u.test(wanted)) return wanted;
  const step = (work?.plan?.steps ?? []).find((candidate) => norm(candidate.label) === norm(wanted));
  if (!step) throw new WorkRefusal("STEP_NOT_FOUND", { what: `no step "${wanted}" in this work's plan`, state, next: 'relo work update --step s2  |  relo work update --add "…"' });
  return step.id;
}

/**
 * The requests one verb makes: [{ method, path, body, idempotencyKey?, seal, sealedForm?, card?, copy? }], sent
 * in order. `body` is the readable form; `seal` says when the sealed form goes instead ("auto" for a start,
 * "always" for a sealed work, "never" for a readable one). Pure, so tests need no server. An update sends one
 * request per plan command (the server applies one per request), text on the first and progress on the last.
 */
export function scriptRequests(action, options, { producer, work, stdinIsTTY = false }) {
  const base = `/api/producers/${producerPathKey(producer)}/works`;
  const state = `producer ${producer}`;
  const workPath = `${base}/${work?.id}`;
  const seal = work?.sealed ? "always" : "never";
  switch (action) {
    case "start": {
      let key = options["idempotency-key"];
      if (!key) {
        if (!stdinIsTTY) {
          throw new WorkRefusal("IDEMPOTENCY_REQUIRED", {
            what: "a script must name this start with --idempotency-key, so a retry never makes a second work",
            state: `${state}, no open work`,
            next: `relo work start --producer ${producer} --goal "…" --idempotency-key "$CI_PIPELINE_ID-deploy"`,
          });
        }
        key = randomUUID();
      }
      const goal = text(options.goal, "--goal");
      const status = options.status === undefined ? undefined : text(options.status, "--status");
      const labels = options.plan === undefined ? undefined : splitLabels(options.plan, state);
      const progress = options.progress === undefined ? undefined : parseCount(options.progress, state);
      const { plan } = startPlan(labels, labels ? progress : undefined, state);
      const body = { goal: readable(goal) };
      if (status !== undefined) body.status = readable(status);
      if (labels) body.plan = { op: "set", steps: labels.map((label) => ({ label })) };
      if (progress) body.progress = progress;
      if (options.lease !== undefined) body.leaseSeconds = leaseSeconds(options.lease);
      if (options.new) body.new = true;
      return [{ method: "POST", path: base, body, idempotencyKey: String(key), seal: "auto", sealedForm: sealedStart(body, labels ?? []),
        card: workCardText({ goal, status, plan }), copy: selfCopyText({ goal, status, plan }) }];
    }
    case "update": {
      const step = Array.isArray(options.step) ? options.step[0] : options.step;
      if (options["next-step"] && step !== undefined) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--next-step and --step contradict each other", state, next: `relo work update --producer ${producer} --next-step` });
      if (options.waiting !== undefined && options["not-waiting"]) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--waiting and --not-waiting contradict each other", state, next: `relo work update --producer ${producer} --waiting "…"` });
      const change = {
        nextStep: Boolean(options["next-step"]),
        plan: options.plan === undefined ? undefined : splitLabels(options.plan, state),
        add: options.add === undefined ? undefined : splitLabels(options.add, state),
      };
      const id = step === undefined ? undefined : stepId(step, work, state);
      const goal = options.goal === undefined ? undefined : text(options.goal, "--goal");
      const status = options.status === undefined ? undefined : text(options.status, "--status");
      const waiting = options.waiting === undefined ? undefined : text(options.waiting, "--waiting");
      const first = {};
      if (goal !== undefined) first.goal = readable(goal);
      if (status !== undefined) first.status = readable(status);
      if (waiting !== undefined) first.waiting = { reason: readable(waiting) };
      if (options["not-waiting"]) first.waiting = null;
      const progress = options.progress === undefined ? undefined : parseCount(options.progress, state);
      // The work as it will stand: the contracts plan engine applies the change locally (as the server will),
      // its trees name the ids every wire command carries, and the sealed card and self copy carry the text.
      const planned = Boolean(work?.plan?.steps?.length) || Boolean(change.plan) || Boolean(change.add);
      const planChange = { ...change, ...(id ? { step: id } : {}), ...(planned && progress ? { progress } : {}) };
      const labelsKnown = !work?.plan?.steps?.some((entry) => entry.label == null);
      const planWork = change.nextStep || change.plan || change.add || id || (planned && progress);
      const applied = planWork ? applyChange(work?.plan ?? null, planChange, labelsKnown, state) : undefined;
      const commands = planCommands(change, id, { trees: applied?.trees, under: applied?.moved?.under });
      if (!commands.length && !Object.keys(first).length && !progress) throw new WorkRefusal("NOTHING_TO_UPDATE", { what: "update needs at least one change", state, next: `relo work update --producer ${producer} --status "…"` });
      const moved = applied ? applied.plan : work?.plan ?? null;
      const next = { ...work, ...(goal !== undefined ? { goal } : {}), ...(status !== undefined ? { status } : {}),
        ...(waiting !== undefined ? { waiting } : options["not-waiting"] ? { waiting: null } : {}), plan: moved };
      return planBodies(commands, first, progress).map((body) => ({ method: "PATCH", path: workPath, body, seal,
        sealedForm: sealedUpdate(body, { trees: applied?.trees ?? {} }), card: workCardText(next), copy: selfCopyText(next) }));
    }
    case "pause": {
      const status = options.status === undefined ? undefined : text(options.status, "--status");
      if (status === undefined) return [{ method: "POST", path: `${workPath}/pause`, body: {}, seal: "never" }];
      const paused = { ...work, status };
      return [{ method: "POST", path: `${workPath}/pause`, body: { status: readable(status) }, seal, sealedForm: { status: SEALED },
        card: workCardText(work, { status }), copy: selfCopyText(paused) }];
    }
    case "resume": return [{ method: "POST", path: `${workPath}/resume`, body: {}, seal: "never" }];
    case "finish": {
      const resultName = options.failed ? "failed" : options.dropped ? "dropped" : "finished";
      const outcome = text(options.outcome, "--outcome");
      const body = { outcome: readable(outcome), result: resultName };
      const { plan } = finishPlan(work?.plan ?? null, resultName);
      return [{ method: "POST", path: `${workPath}/finish`, body, seal, sealedForm: sealedText(body), card: workCardText({ ...work, plan }, { status: outcome }), outcomeNotice: { title: work?.goal, summary: outcome } }];
    }
    case "heartbeat": return [{ method: "POST", path: `${workPath}/heartbeat`, body: { leaseSeconds: leaseSeconds(options.lease) }, seal: "never" }];
    default: throw new WorkRefusal("UNKNOWN_VERB", { what: `relo work ${action} is not a script verb`, state, next: "relo work start|update|pause|resume|finish|heartbeat --producer KEY" });
  }
}

/** The producer's works, with a sealed work's text read back from this computer's self copy. */
async function listWorks(client, producer, state, dependencies) {
  const listed = await client.request("GET", `/api/producers/${producerPathKey(producer)}/works`, { query: { state } });
  const works = listed?.works ?? [];
  const key = works.some((work) => work?.producerSealed) ? await loadSelfKey(dependencies) : null;
  return works.map((work) => restoreFromSelfCopy(work, key));
}

/** The producer's open (or, for resume, newest paused) work; R-6-style refusal when none. */
async function targetWork(client, producer, action, options, dependencies) {
  const lifecycle = action === "resume" ? "paused" : action === "finish" ? "all" : "open";
  const works = await listWorks(client, producer, options.work ? "all" : lifecycle, dependencies);
  const work = options.work ? works.find((row) => row.id === String(options.work)) ?? { id: String(options.work) }
    : works.find((row) => action !== "finish" || row.lifecycle === "open" || row.lifecycle === "paused");
  if (!work) {
    throw new WorkRefusal("NO_OPEN_WORK", { what: `there is no ${action === "resume" ? "paused" : "open"} work for this producer`, state: `producer ${producer}, no open work`, next: `relo work start --producer ${producer} --goal "…" --idempotency-key "…"` });
  }
  return work;
}

export async function runScriptWork(command) {
  const { action, options, dependencies, client } = command;
  const producer = resolveProducer(options, dependencies.caller);
  if (action === "deliver") {
    throw new WorkRefusal("REFUSED_DELIVER", { what: "relo work deliver closes one request of an agent session's goal; a script's work has no rounds", state: `producer ${producer}`, next: `relo work finish --producer ${producer} --outcome "…"` });
  }
  if (command.group === "state" || action === "state") {
    return result("state", { ok: true, producer, works: await listWorks(client, producer, "all", dependencies) });
  }
  const context = { producer, stdinIsTTY: dependencies.stdinIsTTY };
  if (options["dry-run"]) {
    const requests = scriptRequests(action, options, { ...context, work: { id: options.work ?? "<open work>" } });
    return dryRunResult(`work.${action}`, requests.length === 1 ? requests[0].body : requests.map((request) => request.body));
  }
  const work = action === "start" ? undefined : await targetWork(client, producer, action, options, dependencies);
  let sealing;
  const sealer = () => (sealing ??= workSealer({ client, config: command.config, dependencies }));
  let response;
  for (const request of scriptRequests(action, options, { ...context, work })) {
    const body = await materialize({ seal: request.seal, readable: request.body, sealedForm: request.sealedForm, card: request.card, copy: request.copy, outcomeNotice: request.outcomeNotice }, sealer);
    response = await client.request(request.method, request.path, { body, idempotencyKey: request.idempotencyKey });
  }
  const key = response?.work?.producerSealed ? await loadSelfKey(dependencies) : null;
  const data = { ok: true, disposition: response?.disposition ?? action, work: restoreFromSelfCopy(response?.work ?? null, key), lease: response?.leaseUntil ?? null };
  const message = action === "heartbeat" && response?.leaseUntil
    ? `Lease: moving until ${new Date(response.leaseUntil).toISOString().slice(11, 16)} UTC without updates (renew before then).`
    : undefined;
  return result(`work.${action}`, data, { message });
}
