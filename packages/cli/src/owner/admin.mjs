// `relo admin …`: the owner's cross-session surface (ADR 0008, "Owner administration"). Normal use keeps every
// session to its own work and cards; administration is a deliberate switch the owner makes from their own
// terminal, or an agent makes only when the owner asks it for help (cleaning up a hanging or test card,
// checking what every session is showing). It runs as the owner's terminal does, never as the calling session.
import { T_FRESH_MS } from "../work/state-file.mjs";
import { EXIT, UsageError } from "../shared/errors.mjs";
import { checkText } from "../work/content-filter.mjs";
import { materialize } from "../work/declared-lane.mjs";
import { finishPlan } from "../work/plan.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { SEALED, workCardText, workSealer } from "../crypto/seal-work.mjs";
import { loadSelfKey, restoreFromSelfCopy } from "../crypto/self-copy.mjs";
import { harnessName } from "../agent/guards.mjs";

const STATE = "relo admin: the owner's cross-session view";

const ago = (iso, now) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : minutes < 1_440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1_440)}d ago`;
};

function stepOf(work) {
  const steps = work?.plan?.steps?.filter((step) => step.state !== "skipped") ?? [];
  const index = steps.findIndex((step) => step.state === "current");
  return index === -1 ? null : `${index + 1}/${steps.length}`;
}

/** Every work of the account, its words restored where this computer sealed them. */
async function accountWorks(client, dependencies, { all = false } = {}) {
  const payload = await client.request("GET", "/api/works", { query: all ? {} : { state: "live" } });
  const works = Array.isArray(payload?.works) ? payload.works : [];
  const key = works.some((work) => work.producerSealed) ? await loadSelfKey(dependencies) : null;
  return works.map((work) => restoreFromSelfCopy(work, key));
}

const quiet = (work, now) => work.lifecycle === "paused" || (work.updatedAt && now - Date.parse(work.updatedAt) >= T_FRESH_MS);

async function listWorks({ options, client, dependencies }) {
  const now = Date.now();
  const works = await accountWorks(client, dependencies, { all: Boolean(options.all) });
  const lines = works.map((work) => [
    work.id,
    work.lifecycle,
    work.producer?.type === "agent_session" ? harnessName({ type: "agent_session", harness: work.producer.harness }) : "Script or app",
    work.goal ? `"${work.goal}"` : "(sealed on another computer)",
    stepOf(work) ? `step ${stepOf(work)}` : null,
    work.updatedAt ? `updated ${ago(work.updatedAt, now)}` : null,
    ["open", "paused"].includes(work.lifecycle) ? (quiet(work, now) ? "hanging" : "moving") : null,
  ].filter(Boolean).join("  "));
  const echo = [
    works.length ? `${works.length} ${options.all ? "" : "open or paused "}work${works.length === 1 ? "" : "s"} on the account:` : "No open or paused work on the account.",
    ...lines,
    works.some((work) => ["open", "paused"].includes(work.lifecycle) && quiet(work, now))
      ? 'End a hanging one: relo admin finish wrk_… --dropped --outcome "…"' : null,
  ].filter(Boolean).join("\n");
  return { exitCode: EXIT.OK, command: "admin.works", echo, data: { ok: true, works: works.map((work) => ({
    id: work.id, lifecycle: work.lifecycle, goal: work.goal ?? null, producer: work.producer ?? null,
    step: stepOf(work), updatedAt: work.updatedAt ?? null, hanging: ["open", "paused"].includes(work.lifecycle) && Boolean(quiet(work, now)),
  })), echo } };
}

async function finishWork({ options, rest, client, config, dependencies }) {
  const ref = rest[0];
  if (rest.length !== 1 || !/^wrk_[A-Za-z0-9-]{8,}$/u.test(String(ref))) {
    throw new WorkRefusal("REFUSED_ID", { what: "admin finish takes one work id, as relo admin works prints it", state: STATE, next: "relo admin works" });
  }
  if (options.outcome === undefined) throw new WorkRefusal("REFUSED_NO_OUTCOME", { what: "ending a work needs an outcome the owner will read", state: STATE, next: `relo admin finish ${ref} --dropped --outcome "Test card, no longer needed"` });
  if (options.dropped && options.failed) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--failed and --dropped contradict each other", state: STATE, next: `relo admin finish ${ref} --dropped --outcome "…"` });
  let outcome;
  try { outcome = checkText("outcome", options.outcome, { flag: "--outcome" }); } catch (error) {
    if (error instanceof UsageError) throw new WorkRefusal("CONTENT_REFUSED", { what: error.message.replace(/^Refused:\s*/u, "").replace(/\.$/u, ""), state: STATE, next: `relo admin finish ${ref} --outcome "…"` });
    throw error;
  }
  const matches = (await accountWorks(client, dependencies)).filter((work) => work.id === ref || String(work.id).startsWith(ref));
  if (matches.length > 1) throw new WorkRefusal("REFUSED_AMBIGUOUS_ID", { what: `${ref} matches ${matches.length} works`, state: STATE, next: "relo admin works   (use the full id)" });
  const work = matches[0];
  if (!work) throw new WorkRefusal("NOT_FOUND", { what: `no open or paused work ${ref}`, state: STATE, next: "relo admin works" });
  const result = options.failed ? "failed" : options.dropped ? "dropped" : "finished";
  const { plan } = finishPlan(work.plan, result);
  let sealerPromise;
  const sealer = () => (sealerPromise ??= workSealer({ client, config, dependencies, notes: [] }));
  const body = await materialize({
    seal: work.sealed ? "always" : "never",
    readable: { result, outcome: { readable: outcome } },
    sealedForm: { result, outcome: SEALED },
    card: workCardText({ ...work, plan }, { status: outcome }),
  }, sealer);
  let payload;
  try {
    payload = await client.request("POST", `/api/works/${encodeURIComponent(work.id)}/finish`, { body });
  } catch (error) {
    const code = error?.details?.error ?? error?.code;
    if (code === "work_running" || /still moving/u.test(String(error?.message))) {
      throw new WorkRefusal("WORK_RUNNING", { what: `${work.id} is still moving; its own session or script finishes it`, state: STATE, next: "relo admin works   (paused work, or work quiet for 20 minutes, can be ended)" });
    }
    throw error;
  }
  const ended = payload?.work ?? { ...work, lifecycle: result };
  const echo = `Ended ${ended.id} (${ended.lifecycle}): "${outcome}"${work.goal ? ` · was "${work.goal}"` : ""}\nNext: relo admin works`;
  return { exitCode: EXIT.OK, command: "admin.finish", echo, data: { ok: true, work: { id: ended.id, lifecycle: ended.lifecycle }, echo } };
}

/** `relo admin works` and `relo admin finish`: administration's own commands (the dispatcher makes the caller the owner). */
export async function runAdminCommand(command) {
  return command.action === "works" ? listWorks(command) : finishWork(command);
}
