import { OWNER_STATE_TIMING,type OwnerState } from "@relo/notification-contracts";
import { loadOwnerStateInputs } from "../derive/load.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import { refusal,type WorkRefusal } from "./declared.js";
import { activeCardFor,type Queryable,type WorkRow } from "./store.js";

/** The owner states of an open work that is alive: its own session or script moves it, so the owner cannot end it. */
const LIVE_STATES: ReadonlySet<OwnerState> = new Set(["moving","working_quietly","needs_you"]);

/**
 * The one rule for "hanging" (12b-plan-ux 4.11): a work the owner may end is paused, or open and not live by the
 * derivation: quiet (no update, session idle, session ended), left unfinished, or delivered (the owner's turn or
 * History). Admin finish and the owner's End share it, so the CLI, the phone and the Dashboard never disagree.
 * The work's own state is derived without its question: a question needs the owner, it does not move the work.
 */
export async function liveRefusal(query: Queryable,work: WorkRow,now = new Date()): Promise<WorkRefusal | null> {
  if (work.lifecycle !== "open") return null;
  const card = await activeCardFor(query,work.id);
  let live: boolean;
  if (card) {
    const loaded = (await loadOwnerStateInputs(query as never,work.principal_id,[`act_${card.id}`],now))[0];
    live = loaded ? LIVE_STATES.has(deriveOwnerState({ ...loaded.input,question: null }).state) : false;
  } else {
    // No card yet (never projected): only the declared clock speaks.
    live = now.getTime() - work.declared_at.getTime() < OWNER_STATE_TIMING.freshSeconds * 1000;
  }
  if (!live) return null;
  return refusal("work_running",409,"This work is still moving; its own session or script finishes it. Paused work, "
    + "and open work that went quiet, was left open or was delivered, can be ended.");
}
