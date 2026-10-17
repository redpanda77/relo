// This computer's name, as cards and session rows show it.
import { execFileSync } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { cleanLabel } from "./label.mjs";
import { envSetting } from "./settings.mjs";

/**
 * The name of this computer: RELO_COMPUTER, else the macOS ComputerName ("Studio MacBook Pro"),
 * else the hostname without its domain. Probes are injectable for tests.
 */
export function detectComputerName(env = process.env, probes = {}) {
  const fromEnv = cleanLabel(envSetting("computer", env), 120);
  if (fromEnv) return fromEnv;
  if ((probes.platform ?? process.platform) === "darwin") {
    try {
      const scutil = probes.scutil
        ?? (() => execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }));
      const name = cleanLabel(scutil(), 120);
      if (name) return name;
    } catch {
      // Fall through to the hostname.
    }
  }
  try {
    const host = String((probes.hostname ?? osHostname)() ?? "").trim();
    return cleanLabel(host.split(".")[0], 120);
  } catch {
    return undefined;
  }
}

/**
 * The one precedence for this computer's name, for cards, session rows and credentials alike:
 * RELO_COMPUTER, else the name stored at login (a hook never probes the machine when it is known),
 * else what `detect` finds. `cached` and `detect` are thunks so nothing is read that is not needed.
 */
export function resolveComputerName(env, { cached, detect } = {}) {
  const fromEnv = cleanLabel(envSetting("computer", env), 120);
  if (fromEnv) return fromEnv;
  const stored = cleanLabel(cached?.(), 120);
  if (stored) return stored;
  try { return cleanLabel(detect?.(), 120); } catch { return undefined; }
}
