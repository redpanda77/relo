import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

/** The phases that need a look now: working, or waiting for the owner. */
export const LIVE_PHASES = ["working", "waiting"];

/**
 * `relo sessions [--live]`: the agent sessions the server knows (hooks report them; see `relo setup --hooks`).
 * --live lists only working and waiting sessions; the counts always cover every phase.
 */
export async function runSessionsCommand(command) {
  const { options, group, action, rest, client } = command;
  if (group !== "sessions") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, "Usage: relo sessions [--live]");
  assertAllowedOptions(options, ["live"]);
  const live = options.live === true;
  const listed = await client.listAgentSessions(live ? { phases: LIVE_PHASES } : {});
  // A server before phases ignores the filter and sends no phase: --live keeps the mid-turn ones.
  if (live && Array.isArray(listed?.sessions) && listed.sessions.some((session) => session?.phase === undefined)) {
    return result("sessions", { ...listed, sessions: listed.sessions.filter((session) => session?.state === "active") });
  }
  return result("sessions", listed);
}
