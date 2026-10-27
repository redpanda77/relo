// The local-install section of `relo doctor`: only when the active account is Relo for Mac's or Relo for Windows' own
// (local, loopback). Facts come through one injectable reader (dependencies.localFacts) so tests touch no disk, network
// or process.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLoopbackApiUrl } from "../shared/config.mjs";

export const isLocalAccount = (config) => config?.local === true && isLoopbackApiUrl(config.apiUrl);

const LAUNCHER = (home) => join(home, ".local", "bin", "relo");
const APP_NODE = /"([^"]*?\.app)\/Contents\/Resources\/server\/node"/u;
// Relo for Windows writes %LOCALAPPDATA%\Relo\bin\relo.cmd, whose command line is "<app dir>\server\node.exe" "<cli>" %*
// The files are read on this computer, so its own joins (Windows' on Windows).
const WINDOWS_LAUNCHER = (localAppData) => join(localAppData, "Relo", "bin", "relo.cmd");
const WINDOWS_APP_NODE = /^"([^"]*?)\\server\\node\.exe"/iu;

/** The app's name for the owner: Windows runs Relo for Windows, everything else Relo for Mac. */
export const appName = (platform) => (platform === "win32" ? "Relo for Windows" : "Relo for Mac");

function plistValue(plist, key) {
  try { return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim(); } catch { return undefined; }
}

/** What the machine says: server health, the app the launcher points at, and the CLI bundled in it. Never throws. */
export async function readLocalFacts({ apiUrl, home, fetchImpl = globalThis.fetch, platform = process.platform, env = process.env }) {
  const facts = { health: null, app: null, bundledCli: null, platform };
  try {
    const response = await fetchImpl(new URL("/health/ready", apiUrl), { signal: AbortSignal.timeout(3000) });
    const body = response.ok ? await response.json() : null;
    if (body?.status === "ok") facts.health = { release: typeof body.release === "string" ? body.release : null };
  } catch { /* unreachable */ }
  if (platform === "win32") return readWindowsAppFacts(facts, { home, env });
  try {
    const path = APP_NODE.exec(readFileSync(LAUNCHER(home), "utf8"))?.[1];
    if (path) {
      const plist = join(path, "Contents", "Info.plist");
      const short = plistValue(plist, "CFBundleShortVersionString");
      const build = plistValue(plist, "CFBundleVersion");
      facts.app = { path, version: short && build ? `${short}+${build}` : null };
      try { facts.bundledCli = JSON.parse(readFileSync(join(dirname(plist), "Resources", "server", "cli", "package.json"), "utf8")).version ?? null; } catch { /* not bundled */ }
    }
  } catch { /* no launcher */ }
  return facts;
}

/**
 * Relo for Windows: the launcher names the app's folder (`<app dir>\server\node.exe`); the payload's release-identity.txt
 * is the app's version, the same value the server reports as its release (no plutil: there is no Info.plist).
 */
export function readWindowsAppFacts(facts, { home, env }) {
  try {
    const localAppData = env?.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : undefined);
    if (!localAppData) return facts;
    const text = readFileSync(WINDOWS_LAUNCHER(localAppData), "utf8");
    const line = text.split(/\r?\n/u).find((candidate) => WINDOWS_APP_NODE.test(candidate));
    const appDir = line ? WINDOWS_APP_NODE.exec(line)?.[1] : undefined;
    if (!appDir) return facts;
    const folder = join(appDir, "server");
    let version = null;
    for (const file of [join(folder, "release-identity.txt"), join(appDir, "release-identity.txt")]) {
      try { version = readFileSync(file, "utf8").trim() || null; } catch { /* not there */ }
      if (version) break;
    }
    facts.app = { path: appDir, version };
    try { facts.bundledCli = JSON.parse(readFileSync(join(folder, "cli", "package.json"), "utf8")).version ?? null; } catch { /* not bundled */ }
  } catch { /* no launcher */ }
  return facts;
}

/** The `checks.local` entry. ok is false only when the server is unreachable; mismatches are warnings (see mismatchWarning). */
export function evaluateLocal(facts, { version, updateMode }) {
  const up = Boolean(facts.health);
  const release = facts.health?.release ?? null;
  const appVersion = facts.app?.version ?? null;
  const versionsMatch = release && appVersion ? release === appVersion : null;
  const name = appName(facts.platform);
  return {
    ok: up,
    state: up ? "ready" : "unreachable",
    server: up ? "ready" : "unreachable",
    release,
    app: facts.app ? { path: facts.app.path, version: appVersion } : null,
    versionsMatch,
    cli: { running: version, bundled: facts.bundledCli, match: facts.bundledCli ? facts.bundledCli === version : null },
    updates: updateMode,
    ...(facts.platform === "win32" ? { appName: name } : {}),
    ...(up ? {} : { hint: `Open ${name}: it starts its server` }),
  };
}

export function mismatchWarning(local) {
  if (local?.versionsMatch !== false) return undefined;
  return { ok: false, state: `server ${local.release}, app ${local.app.version}`, hint: `Quit and reopen ${local.appName ?? appName()} to restart its server` };
}
