import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

/** `relo sessions`: the agent sessions the server knows (hooks report them; see `relo setup --hooks`). */
export async function runSessionsCommand(command) {
  const { options, group, action, rest, client } = command;
  if (group !== "sessions") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, "Usage: relo sessions");
  assertAllowedOptions(options, []);
  return result("sessions", await client.listAgentSessions());
}
