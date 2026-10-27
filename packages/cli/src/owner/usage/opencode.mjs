// The OpenCode account for `relo usage`: present only where OpenCode has been used. A Go plan (or an OpenCode sign-in)
// shows its 5-hour, weekly and monthly windows; a machine with only API keys shows no windows, "API keys" and, when
// cheap, the tokens its local database counted. Cached 5 minutes by the adapter.
import { dataDirectory, opencodePresent, opencodeReading } from "../../harness/adapters/opencode/usage-go.mjs";
import descriptor from "../../harness/adapters/opencode/descriptor.mjs";
import { displayName } from "../../shared/usage-cache.mjs";

/** The OpenCode account row, or undefined when OpenCode is not on this computer. `io`: { run, fetch } (injectable). */
export async function opencodeAccount({ env, home, stateDirectory, now, io }) {
  if (!(await opencodePresent({ env, home }))) return undefined;
  const folder = dataDirectory(env, home);
  const reading = await opencodeReading({ folder, stateDirectory, now, io });
  return {
    id: descriptor.id, plan: descriptor.id, displayName: displayName("OpenCode", null), profile: null, configDir: folder,
    email: null, planName: reading.planName, connected: reading.connected, hint: reading.hint, readAt: reading.readAt,
    source: reading.windows.length > 0 ? "endpoint" : reading.activity ? "local" : null, windows: reading.windows,
    ...(reading.activity ? { activity: reading.activity } : {}),
  };
}
