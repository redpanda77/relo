// The USER Path on Windows (HKCU\Environment, Path, REG_EXPAND_SZ). Read raw with `reg query` so %VAR% entries survive
// (GetEnvironmentVariable would expand them and the rewrite would freeze them), written with `reg add ... /t
// REG_EXPAND_SZ`, then WM_SETTINGCHANGE is broadcast so new terminals see it. The machine Path is never touched.
// `run(file, args) -> { code, stdout }` is injectable: tests never reach the real registry.
import { execFile } from "node:child_process";

const KEY = "HKCU\\Environment";
const BROADCAST = [
  "Add-Type -Namespace Relo -Name Native -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);';",
  "$r=[UIntPtr]::Zero; [void][Relo.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",
].join(" ");

// RELO_NO_REGISTRY_WRITES (the hermetic test environment sets it): a test that reaches the real registry, as the schema
// sweep of `setup --path` once did, fails that write instead of changing the developer's own Path.
export const defaultRun = (file, args) => new Promise((done) => {
  if (process.env.RELO_NO_REGISTRY_WRITES === "1" && file === "reg" && args[0] !== "query") return done({ code: 1, stdout: "" });
  execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") });
  });
});

/** { value, type } of the raw user Path, or undefined when the value does not exist. */
export async function readUserPath(run) {
  const result = await run("reg", ["query", KEY, "/v", "Path"]);
  if (result.code !== 0) return undefined;
  const match = /^\s*Path\s+(REG_\w+)\s*(.*?)\r?$/imu.exec(result.stdout);
  return match ? { type: match[1], value: match[2] } : undefined;
}

const normal = (entry, env) => entry.trim().replace(/%([^%]+)%/gu, (all, name) => env[Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())] ?? all)
  .replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();

async function writeUserPath(run, entries) {
  const set = await run("reg", ["add", KEY, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", entries.join(";"), "/f"]);
  if (set.code !== 0) throw new Error("The user Path could not be written.");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", BROADCAST]);
}

/** Adds `dir` to the user Path unless it is there (compared expanded, case-insensitive). { changed } */
export async function addToUserPath(dir, { run = defaultRun, env = process.env, dryRun = false } = {}) {
  const current = await readUserPath(run);
  const entries = (current?.value ?? "").split(";").filter((entry) => entry.trim() !== "");
  if (entries.some((entry) => normal(entry, env) === normal(dir, env))) return { changed: false };
  if (!dryRun) await writeUserPath(run, [...entries, dir]);
  return { changed: true };
}

/** Removes only `dir`'s entry, every other entry (and its %VAR%) kept as it was. { changed } */
export async function removeFromUserPath(dir, { run = defaultRun, env = process.env, dryRun = false } = {}) {
  const current = await readUserPath(run);
  if (!current) return { changed: false };
  const entries = current.value.split(";").filter((entry) => entry.trim() !== "");
  const kept = entries.filter((entry) => normal(entry, env) !== normal(dir, env));
  if (kept.length === entries.length) return { changed: false };
  if (!dryRun) await writeUserPath(run, kept);
  return { changed: true };
}
