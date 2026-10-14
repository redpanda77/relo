// Refusals for the agent module, before any request (plan 04 §2.3 R-1…R-5, R-12; §2.8 owner-only).
import { WorkRefusal } from "../work/refusal.mjs";

const TIMING = ["expires-in", "stale-after", "dismiss-after"];
const RETIRED = ["topic", "thread-name", "task-title", "title", "steps", "step-current"];

const harnessName = (caller) => caller?.type === "agent_session"
  ? ({ "claude-code": "Claude Code", codex: "Codex", mcp: "MCP" }[caller.harness] ?? caller.harness)
  : caller?.agent ?? "an agent harness";

export const without = (argv, flag) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${flag}`) { if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) i += 1; continue; }
    if (argv[i].startsWith(`--${flag}=`)) continue;
    out.push(argv[i]);
  }
  return `relo ${out.map((w) => (/[\s"]/u.test(w) ? JSON.stringify(w) : w)).join(" ")}`;
};

export function guardWorkFlags({ verb, options, positionals, argv, caller, state }) {
  if (options.name !== undefined) throw new WorkRefusal("REFUSED_FLAG", { what: "--name is not used in a session; this session's work is found automatically", state, next: without(argv, "name") });
  if (options.producer !== undefined) throw new WorkRefusal("REFUSED_FLAG", { what: `--producer is for scripts; this shell belongs to a ${harnessName(caller)} session, which names its own work`, state, next: without(argv, "producer") });
  if (options["idempotency-key"] !== undefined) throw new WorkRefusal("REFUSED_FLAG", { what: "--idempotency-key is set by relo itself on work commands", state, next: without(argv, "idempotency-key") });
  if (options.lease !== undefined || verb === "heartbeat") throw new WorkRefusal("REFUSED_HEARTBEAT", { what: "heartbeats are for scripts and apps; a session shows it is alive through its own updates", state, next: 'relo work update --status "…"' });
  for (const flag of TIMING) if (options[flag] !== undefined) throw new WorkRefusal("REFUSED_FLAG", { what: `--${flag} is not set by producers; Relo times every card the same way`, state, next: without(argv, flag) });
  for (const flag of RETIRED) {
    const value = options[flag];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      const hint = { title: "--goal", steps: "--plan", "step-current": "--step" }[flag];
      throw new WorkRefusal("REFUSED_FLAG", { what: `--${flag} is not a relo work flag${hint ? `; use ${hint}` : ""}`, state, next: without(argv, flag) });
    }
  }
  if ((verb === "update" || verb === "pause") && positionals.length) {
    throw new WorkRefusal("REFUSED_POSITIONAL", { what: `relo work ${verb} always acts on this session's open work; it takes no id`, state, next: `relo work ${verb} …` });
  }
  if (caller.type === "agent_session" && options.work !== undefined && ["start", "update", "pause"].includes(verb)) {
    throw new WorkRefusal("REFUSED_WORK_FLAG", { what: "--work is only for finishing or resuming a parked work of this session", state, next: 'relo work finish --work wrk_… --outcome "…"  |  relo work resume wrk_…' });
  }
}

export const OWNER_ONLY = new Set(["sessions", "listen", "activity list", "activity diagnose", "activity get", "activity status"]);

export function guardOwnerOnly({ group, action, caller }) {
  const key = OWNER_ONLY.has(group) ? group : `${group} ${action}`;
  if (!OWNER_ONLY.has(key)) return;
  const where = caller.type === "agent_session" ? `this shell belongs to a ${harnessName(caller)} session` : `this shell runs inside ${harnessName(caller)} (no session id)`;
  throw new WorkRefusal("OWNER_ONLY", { what: `relo ${key} shows every session; it is for the owner, not for an agent inside a session`, state: where, next: "relo state   (this session's own work)" });
}

export { harnessName };
