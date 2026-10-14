// Local hook roles (plan 05 §3.12) for the reminders level: `relo hook <role>`. Everything is local (no
// network) and fails open (no output, exit 0). A role returns a neutral outcome ({ context }); the
// adapter renders it in its harness's own output format, or not at all if it lacks the capability.
import { join } from "node:path";
import { readStateFile, stateRoot } from "../../work/state-file.mjs";
import { readBookkeeping, writeBookkeeping } from "./bookkeeping.mjs";
import { normalize } from "./events.mjs";
import { remind } from "./remind.mjs";
import { restore } from "./restore.mjs";

/** Roles handled locally rather than by the observed state machine. `guard`, `await`, `release` are accepted no-ops for now. */
export const HARNESS_ROLES = Object.freeze(["remind", "restore", "turn", "guard", "await", "release"]);
// The canonical event each role is installed on, for harnesses that do not name the event on stdin.
const ROLE_EVENTS = { remind: "stop", restore: "start", turn: "prompt", guard: "tool_start", await: "tool_end", release: "end" };

function declaredStatePath(dependencies, session) {
  return join(stateRoot(dependencies.env ?? process.env, dependencies.home), "sessions", `${session}.json`);
}

/** Returns { printed, role, reason? }. Never throws. */
export async function runHarnessRole({ adapter, role, input, dependencies }) {
  try {
    const event = normalize({ adapter, input, named: ROLE_EVENTS[role] });
    if (event.drop) return { printed: false, role, reason: event.drop };
    const now = dependencies.now();
    const directory = dependencies.hookStateDirectory;
    if (role === "turn") {
      if (!event.subagent) await writeBookkeeping(directory, event.session, { turnStartedAt: now });
      return { printed: false, role };
    }
    if (role !== "remind" && role !== "restore") return { printed: false, role, reason: "not_built" };
    const state = await readStateFile(declaredStatePath(dependencies, event.session));
    const print = dependencies.emit ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
    let outcome;
    if (role === "remind") {
      const bookkeeping = await readBookkeeping(directory, event.session);
      outcome = remind({ event, now, state, bookkeeping });
      await writeBookkeeping(directory, event.session, { lastStopAt: now, ...(outcome ? { reminded: outcome.reminded } : {}) });
    } else {
      outcome = restore({ event, now, state });
    }
    const output = outcome ? adapter.render?.({ role, context: outcome.context }) : undefined;
    if (!output) return { printed: false, role };
    print(output);
    if (role === "restore") await writeBookkeeping(directory, event.session, { restoredAt: now });
    return { printed: true, role };
  } catch {
    return { printed: false, role, reason: "error" };
  }
}
