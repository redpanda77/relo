import { assertNoExtra } from "../shared/validate.mjs";
import { result } from "../shared/outcome.mjs";

/** The phases that need a look now: working, or waiting for the owner. */
const LIVE_PHASES = ["working", "waiting"];

/**
 * `relo sessions [--live]`: the sessions the server knows (hooks report them; see `relo setup --hooks`).
 * --live lists only working and waiting sessions; the counts always cover every phase.
 */
export async function runSessionsCommand(command) {
  const { options, group, action, rest, client } = command;
  if (group !== "sessions") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, "Usage: relo sessions [--live]");
  const live = options.live === true;
  return result("sessions", await client.listAgentSessions(live ? { phases: LIVE_PHASES } : {}));
}
