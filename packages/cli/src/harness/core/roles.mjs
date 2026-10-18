// Local hook roles (plan 05 §3.12) in the presence set: `relo hook <role>`. Everything is local (no
// network) and fails open (no output, exit 0). A role returns a neutral outcome ({ context }); the
// adapter renders it in its harness's own output format, or not at all if it lacks the capability.
import { readSessionFile } from "../../work/session-store.mjs";
import { readBookkeeping, readContext, writeBookkeeping } from "./bookkeeping.mjs";
import { normalize } from "./events.mjs";
import { remind } from "./remind.mjs";
import { restore } from "./restore.mjs";

/** Roles handled locally rather than by the observed state machine. `await` is an accepted no-op for now. */
export const HARNESS_ROLES = Object.freeze(["remind", "restore", "turn", "guard", "await", "release", "permission"]);
// The canonical event each role is installed on, for harnesses that do not name the event on stdin.
const ROLE_EVENTS = { remind: "stop", restore: "start", turn: "prompt", guard: "tool_start", await: "tool_end", release: "end" };

/** Returns { printed, role, reason? }. Never throws. */
export async function runHarnessRole({ adapter, role, input, dependencies }) {
  // The approvals level: ask the owner, answer the harness. It reads the tool's request; see approve.mjs.
  if (role === "permission") {
    // Loaded only here: every other hook stays inside its module budget (test/startup-budget).
    const { runPermission } = await import("./approve.mjs");
    const outcome = await runPermission({ adapter, input, dependencies });
    return { printed: outcome.decision !== "none", role, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  try {
    const event = normalize({ adapter, input, named: ROLE_EVENTS[role] });
    if (event.drop) return { printed: false, role, reason: event.drop };
    const now = dependencies.now();
    const directory = dependencies.hookStateDirectory;
    if (role === "turn") {
      if (event.subagent) return { printed: false, role };
      // The prompt-time decision: the session's open work as context (loaded only here, like approve.mjs).
      const { turnContext, handoffNudge, handoffThreshold } = await import("./turn.mjs");
      const state = await readSessionFile(dependencies, event.session);
      const outcome = turnContext({ event, now, state });
      // Optimize: past the threshold, one line per round (only a status line wrapper writes the reading it reads).
      const nudge = handoffNudge({ context: await readContext(directory, event.session), threshold: handoffThreshold(dependencies.env), state,
        bookkeeping: await readBookkeeping(directory, event.session) });
      const text = [outcome?.context, nudge?.line].filter(Boolean).join("\n");
      const output = text ? adapter.render?.({ role, context: text }) : undefined;
      if (output) (dependencies.emit ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`)))(output);
      await writeBookkeeping(directory, event.session, { turnStartedAt: now, ...(nudge && output ? { handoffNudgeKey: nudge.key } : {}) });
      return { printed: Boolean(output), role };
    }
    if (role === "guard") {
      if (event.subagent) return { printed: false, role };
      const emit = dependencies.emit ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
      const checked = adapter.guardCall?.(input);
      // A relo command whose reply the agent would never read is refused: it runs it again, alone.
      if (checked?.hiddenReply) {
        const { HIDDEN_REPLY } = await import("./guard.mjs");
        const output = adapter.render?.({ role, deny: HIDDEN_REPLY });
        if (output) emit(output);
        return { printed: Boolean(output), role };
      }
      // Before an edit: one line when the card cannot be right (no card, a delivered round, a step left behind).
      if (checked?.edit) {
        const { editGuard } = await import("./guard.mjs");
        const found = editGuard({ now, state: await readSessionFile(dependencies, event.session), bookkeeping: await readBookkeeping(directory, event.session) });
        const output = found ? adapter.render?.({ role, context: found.context }) : undefined;
        if (!output) return { printed: false, role };
        emit(output);
        await writeBookkeeping(directory, event.session, { guardKey: found.key });
        return { printed: true, role };
      }
      // Optimize's Agent|Task entry: a subagent call that names no model gets one line.
      const call = adapter.subagentCall?.(input);
      if (!call || call.named || call.pinned) return { printed: false, role };
      const { SUBAGENT_NUDGE } = await import("./turn.mjs");
      const output = adapter.render?.({ role, context: SUBAGENT_NUDGE });
      if (output) emit(output);
      return { printed: Boolean(output), role };
    }
    if (role === "release") {
      // SessionEnd with /clear: hand the open work off so the cleared session's start offers it (loaded only here).
      if (event.reason !== "clear") return { printed: false, role };
      const { release } = await import("./release.mjs");
      const outcome = await release({ adapter, event, session: adapter.identity(input)?.id, now, state: await readSessionFile(dependencies, event.session), dependencies });
      return { printed: false, role, ...(outcome.handoff ? { handoff: true } : { reason: outcome.reason }) };
    }
    if (role !== "remind" && role !== "restore") return { printed: false, role, reason: "not_built" };
    const state = await readSessionFile(dependencies, event.session);
    const print = dependencies.emit ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
    let outcome;
    if (role === "remind") {
      const bookkeeping = await readBookkeeping(directory, event.session);
      outcome = remind({ event, now, state, bookkeeping });
      await writeBookkeeping(directory, event.session, { lastStopAt: now, ...(outcome ? { reminded: outcome.reminded } : {}) });
    } else {
      outcome = restore({ event, now, state });
      // A handoff another session left for this project (loaded only for the start sources that can offer it).
      if (["startup", "clear", "resume"].includes(event.source)) {
        const { handoffOffer } = await import("./handoff-offer.mjs");
        const offer = await handoffOffer({ event, now, state, dependencies });
        if (offer) outcome = { context: [outcome?.context, offer.context].filter(Boolean).join("\n") };
      }
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
