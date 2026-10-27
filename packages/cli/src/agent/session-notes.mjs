import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CALLER_TYPES } from "../caller.mjs";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { statePath } from "../work/state-file.mjs";
import { skillAdvice, skillStamp } from "../install/skill.mjs";
import { latestCliSeen } from "../shared/api-client.mjs";
import { launcherManaged, updateMode } from "../owner/auto-update.mjs";
import { isTrustNote } from "../crypto/trust.mjs";

// Once per session (DOGFOOD #1, #2): an agent session sees each trust note once per change and the
// skill-vs-CLI version warning once; `relo keys status` and `relo doctor` always show everything.
// The seen-set is local: <state>/relo/seen-notes.json, { sessionKey: { noteHash: seenAtMs } }.
const SEEN_DAYS = 7;

const ALWAYS_EVERYTHING = new Set(["help", "version", "schema", "doctor", "keys.status", "update", "setup", "dry-run"]);

const seenNotesPath = (place) => statePath(place, "seen-notes.json");

const noteHash = (note) => createHash("sha256").update(note).digest("base64url").slice(0, 22);

/**
 * The installed skill differs from this CLI: one line, or undefined (missing is not drift; doctor says that).
 * The full digest (recursive read and SHA-256 of the bundled skill and every copy) runs only when the cheap
 * stamp changes; the verdict is cached in <state>/hooks/skill-drift.json so every other agent command skips it.
 */
async function skillDriftNote(dependencies) {
  try {
    const place = { env: dependencies.env ?? {}, home: dependencies.home, cliVersion: dependencies.version };
    const stamp = skillStamp(place);
    const path = statePath(dependencies, "hooks", "skill-drift.json");
    try {
      const cached = JSON.parse(await readFile(path, "utf8"));
      if (cached?.stamp === stamp) return typeof cached.hint === "string" ? cached.hint : undefined;
    } catch { /* no cache yet */ }
    const advice = skillAdvice(place);
    const hint = advice.state === "outdated" ? advice.hint : undefined;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, JSON.stringify({ stamp, ...(hint ? { hint } : {}) }));
    } catch { /* a read-only state folder only costs the digest next time */ }
    return hint;
  } catch {
    return undefined;
  }
}

/** The server hands out a newer CLI than this one: one line naming the command that brings everything up to date. */
function cliBehindNote(dependencies) {
  const latest = latestCliSeen();
  const mine = dependencies.version;
  // compareVersions lives with relo update; a plain x.y.z compare here keeps this module's imports small.
  const parts = (version) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(version))?.slice(1).map(Number);
  const [a, b] = [parts(latest), parts(mine)];
  if (!a || !b || dependencies.autoUpdating || launcherManaged(dependencies) || updateMode({ home: dependencies.home, env: dependencies.env ?? {}, entrypoint: dependencies.entrypoint }) === "managed") return undefined;
  const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (newer <= 0) return undefined;
  return `Relo CLI ${mine} is behind your server's ${latest}: run relo update (it also brings the skill, instructions and hooks up to date).`;
}

/**
 * The command's output with trust notes this agent session has already seen removed and, the first
 * time, the skill version warning added. Other callers (the owner's shell, scripts) are unchanged.
 */
export async function withSessionNotes(output, dependencies) {
  const caller = dependencies.caller;
  if (caller?.type !== CALLER_TYPES.AGENT_SESSION || !caller.sessionKey || ALWAYS_EVERYTHING.has(output?.command)) return output;
  const drift = await skillDriftNote(dependencies);
  const behind = cliBehindNote(dependencies);
  const candidates = [...(output.notes ?? []).filter(isTrustNote), ...(behind ? [behind] : drift ? [drift] : [])];
  if (candidates.length === 0) return output;
  const path = seenNotesPath(dependencies);
  let seen = {};
  try { seen = JSON.parse(await readFile(path, "utf8")); } catch { seen = {}; }
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
  const now = dependencies.now?.() ?? Date.now();
  for (const [scope, entries] of Object.entries(seen)) {
    const kept = Object.fromEntries(Object.entries(entries ?? {}).filter(([, at]) => now - at < SEEN_DAYS * 86_400_000));
    if (Object.keys(kept).length) seen[scope] = kept; else delete seen[scope];
  }
  const mine = seen[caller.sessionKey] ??= {};
  const fresh = new Set(candidates.filter((note) => mine[noteHash(note)] === undefined));
  for (const note of fresh) mine[noteHash(note)] = now;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, JSON.stringify(seen));
  } catch {
    // A read-only state directory means notes repeat; never a failed command.
  }
  const notes = [...(output.notes ?? []).filter((note) => !isTrustNote(note) || fresh.has(note)),
    ...(drift && fresh.has(drift) ? [drift] : [])];
  const { notes: _old, ...rest } = output;
  return { ...rest, ...(notes.length ? { notes } : {}) };
}
