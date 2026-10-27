// The Antigravity account for `relo usage`: present only where Antigravity (the IDE or the agy CLI) is installed, its
// quota read from Antigravity's language server by the adapter (a running one, else one Relo starts; cached 2 minutes).
import { antigravityEmail, antigravityPresent, antigravityReading } from "../../harness/adapters/antigravity/usage-bridge.mjs";
import descriptor from "../../harness/adapters/antigravity/descriptor.mjs";
import { displayName } from "../../shared/usage-cache.mjs";
import { pathExists, pause, spawnDetached } from "./io.mjs";

/** The Antigravity account row, or undefined when Antigravity is not on this computer. `io`: { run, post, spawnDetached, exists, sleep } (injectable). */
export async function antigravityAccount({ env, home, stateDirectory, now, io: given }) {
  const io = { exists: pathExists, spawnDetached, sleep: pause, ...given };
  if (!(await antigravityPresent({ env, home, exists: io.exists }))) return undefined;
  const reading = await antigravityReading({ stateDirectory, now, home, io });
  return {
    id: descriptor.id, plan: descriptor.id, displayName: displayName("Antigravity", null), profile: null, configDir: null,
    email: await antigravityEmail(home), planName: reading.planName, connected: reading.windows.length > 0,
    hint: reading.hint, readAt: reading.readAt, source: reading.windows.length > 0 ? "language-server" : null, windows: reading.windows,
  };
}
