// `relo work …` and `relo state` for scripts and apps (plan 04 §2.9): the same verbs scoped to a producer
// key, plus `heartbeat`. Wire: /api/producers/<sha256("producer:"+KEY) base64url>/works… (server 2.9).
import { randomUUID } from "node:crypto";
import { dryRunResult, result } from "../support.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { parseCount, splitLabels } from "../work/plan.mjs";
import { parseDuration, producerPathKey, resolveProducer } from "./producer.mjs";

export const SCRIPT_ALLOWED = {
  start: ["producer", "goal", "status", "plan", "progress", "new", "lease", "idempotency-key", "dry-run"],
  update: ["producer", "goal", "status", "next-step", "step", "plan", "add", "progress", "waiting", "not-waiting", "work", "dry-run"],
  pause: ["producer", "status", "work", "dry-run"],
  resume: ["producer", "work", "dry-run"],
  finish: ["producer", "outcome", "failed", "dropped", "work", "dry-run"],
  heartbeat: ["producer", "lease", "work", "dry-run"],
};
export const LEASE_DEFAULT_SECONDS = 900;

/** `--lease 15m` → seconds within 60..3600 (T_retire); default 900. */
export function leaseSeconds(value) {
  if (value === undefined) return LEASE_DEFAULT_SECONDS;
  const seconds = parseDuration(value);
  if (seconds === undefined || seconds < 60 || seconds > 3600) {
    throw new WorkRefusal("LEASE_INVALID", { what: "--lease is 1m to 60m (a dead producer is retired within an hour)", state: `--lease ${value}`, next: "relo work heartbeat --lease 15m" });
  }
  return seconds;
}

function text(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new WorkRefusal("TEXT_REQUIRED", { what: `${flag} needs text`, state: "nothing sent", next: `relo work … ${flag} "…"` });
  return value.trim();
}

/** The request one verb makes: { method, path, body?, idempotencyKey? }; pure, so tests need no server. */
export function scriptRequest(action, options, { producer, workId, stdinIsTTY = false }) {
  const base = `/api/producers/${producerPathKey(producer)}/works`;
  const state = `producer ${producer}`;
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
      const body = { goal: text(options.goal, "--goal") };
      if (options.status !== undefined) body.status = text(options.status, "--status");
      if (options.plan !== undefined) body.plan = { op: "set", steps: splitLabels(options.plan, state).map((label) => ({ label })) };
      if (options.progress !== undefined) body.progress = parseCount(options.progress, state);
      if (options.lease !== undefined) body.leaseSeconds = leaseSeconds(options.lease);
      if (options.new) body.new = true;
      return { method: "POST", path: base, body, idempotencyKey: String(key) };
    }
    case "update": {
      const body = {};
      if (options.goal !== undefined) body.goal = text(options.goal, "--goal");
      if (options.status !== undefined) body.status = text(options.status, "--status");
      if (options.plan !== undefined) body.plan = { op: "set", steps: splitLabels(options.plan, state).map((label) => ({ label })) };
      if (options.progress !== undefined) body.progress = parseCount(options.progress, state);
      if (options.waiting !== undefined) body.waiting = { reason: text(options.waiting, "--waiting") };
      if (options["not-waiting"]) body.waiting = null;
      if (!Object.keys(body).length) throw new WorkRefusal("NOTHING_TO_UPDATE", { what: "update needs at least one change", state, next: `relo work update --producer ${producer} --status "…"` });
      return { method: "PATCH", path: `${base}/${workId}`, body };
    }
    case "pause": case "resume": return { method: "POST", path: `${base}/${workId}/${action}`, body: {} };
    case "finish": {
      const resultName = options.failed ? "failed" : options.dropped ? "dropped" : "finished";
      return { method: "POST", path: `${base}/${workId}/finish`, body: { outcome: text(options.outcome, "--outcome"), result: resultName } };
    }
    case "heartbeat": return { method: "POST", path: `${base}/${workId}/heartbeat`, body: { leaseSeconds: leaseSeconds(options.lease) } };
    default: throw new WorkRefusal("UNKNOWN_VERB", { what: `relo work ${action} is not a script verb`, state, next: "relo work start|update|pause|resume|finish|heartbeat --producer KEY" });
  }
}

/** The producer's open (or, for resume, newest paused) work id; R-6-style refusal when none. */
async function targetWork(client, producer, action, options) {
  if (options.work) return String(options.work);
  const lifecycle = action === "resume" ? "paused" : action === "finish" ? "all" : "open";
  const listed = await client.request("GET", `/api/producers/${producerPathKey(producer)}/works`, { query: { state: lifecycle } });
  const work = (listed?.works ?? []).find((row) => action !== "finish" || row.lifecycle === "open" || row.lifecycle === "paused");
  if (!work) {
    throw new WorkRefusal("NO_OPEN_WORK", { what: `there is no ${action === "resume" ? "paused" : "open"} work for this producer`, state: `producer ${producer}, no open work`, next: `relo work start --producer ${producer} --goal "…" --idempotency-key "…"` });
  }
  return work.id;
}

export async function runScriptWork(command) {
  const { action, options, dependencies, client } = command;
  const producer = resolveProducer(options, dependencies.caller);
  if (command.group === "state" || action === "state") {
    const listed = await client.request("GET", `/api/producers/${producerPathKey(producer)}/works`, { query: { state: "all" } });
    return result("state", { ok: true, producer, works: listed?.works ?? [] });
  }
  if (options["dry-run"]) {
    const request = scriptRequest(action, options, { producer, workId: options.work ?? "<open work>", stdinIsTTY: dependencies.stdinIsTTY });
    return dryRunResult(`work.${action}`, request.body);
  }
  // TODO(2.9): --next-step, --step, --add and pause --status are accepted for parity but not yet sent (server takes plan "set").
  const workId = action === "start" ? undefined : await targetWork(client, producer, action, options);
  const request = scriptRequest(action, options, { producer, workId, stdinIsTTY: dependencies.stdinIsTTY });
  const response = await client.request(request.method, request.path, { body: request.body, idempotencyKey: request.idempotencyKey });
  const data = { ok: true, disposition: response?.disposition ?? action, work: response?.work ?? null, lease: response?.leaseUntil ?? null };
  const message = action === "heartbeat" && response?.leaseUntil
    ? `Lease: moving until ${new Date(response.leaseUntil).toISOString().slice(11, 16)} UTC without updates (renew before then).`
    : undefined;
  return result(`work.${action}`, data, { message });
}
