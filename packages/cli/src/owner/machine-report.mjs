// The machine report (ADR 0011, plan 11 phase 4): what this computer's Relo setup looks like, sent to the
// server when it changes so the Dashboard can show it. Observed device facts only, never a way to change
// anything. It carries no environment variable value, no path and no value of a setting that is a name
// (project, account, topic, computer, source); `settings[].value` is left out for those and for any setting a
// variable set. Owner type module: a hook never reaches it and never sends it (reachability.test.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { release as osRelease } from "node:os";
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { HARNESSES } from "../harness/catalog.mjs";
import { isInstalled } from "../harness/installed.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { depthOf, shortPath } from "../install/block.mjs";
import { inspectBlocks, inspectMcpInstall } from "../install/inspect.mjs";
import { findHooks } from "../install/hooks.mjs";
import { findSkillCopies } from "../install/skill.mjs";
import { harnessPath } from "../harness/paths.mjs";
import { pending } from "../outbox/index.mjs";
import { COMPUTER_ICONS } from "../shared/computers.generated.mjs";
import { FACTS } from "../shared/facts.generated.mjs";
import { SETTINGS } from "../shared/settings.mjs";
import { readStateFile, statePath, writeStateFile } from "../work/state-file.mjs";
import { currentSettings } from "./config.mjs";
import { cachedUpdateAdvice } from "./releases.mjs";

const DAY_MS = 24 * 3600_000;
/** The flusher asks again at most this often (it runs after every burst of hook activity). */
export const FLUSH_INTERVAL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 500;

const REPORT_FILE = "machine-report.json";
const DOCTOR_FILE = "doctor-last.json";

const tried = (probe) => { try { return probe() ?? undefined; } catch { return undefined; } };

function probeCommand(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

/**
 * The CLI's guess at what kind of machine this is (the icon when the owner chose none), or null:
 * CI → build; a Mac by its model (MacBook* laptop; iMac, Mac mini, Mac Pro desktop; the newer "Mac14,2" names say
 * nothing, so a battery decides); Linux with no display → server. Probes are injectable and time out at 500 ms.
 */
export function machineKind(env = process.env, probes = {}) {
  const platform = probes.platform ?? process.platform;
  let kind = null;
  if (env.CI) kind = "build";
  else if (platform === "darwin") {
    const model = String(tried(probes.hwModel ?? (() => probeCommand("sysctl", ["-n", "hw.model"]))) ?? "").trim();
    if (/^MacBook/u.test(model)) kind = "laptop";
    else if (/^(iMac|Macmini|MacPro|Mac ?Studio)/u.test(model)) kind = "desktop";
    else if (model) {
      const battery = String(tried(probes.battery ?? (() => probeCommand("pmset", ["-g", "batt"]))) ?? "");
      kind = battery.includes("InternalBattery") ? "laptop" : "desktop";
    }
  } else if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) kind = "server";
  return COMPUTER_ICONS.includes(kind) ? kind : null;
}

const PLATFORMS = new Set(["darwin", "linux", "win32"]);

/** The hook level a harness's global settings files hold, and whether they are older entries. */
function hooksOf(harness, hookFiles) {
  const adapter = ADAPTERS[harness.id];
  if (!adapter) return { hooks: "off", hooksOutdated: false };
  const levels = hookFiles.filter((file) => file.agent === harness.id)
    .map((file) => ({ ...inferLevel(file.settings, adapter), place: file.place }));
  if (levels.length === 0) return { hooks: "off", hooksOutdated: false };
  // Optimize's "+lean" sets report as their base set: the depth already says optimize.
  const distinct = [...new Set(levels.map((entry) => entry.level.replace(/\+lean$/u, "")))];
  const hooks = distinct.length === 1 ? distinct[0] : "custom";
  return { hooks, hooksOutdated: levels.some((entry) => entry.level === "legacy" || (entry.level === "custom" && entry.nearest !== undefined)) };
}

/** Per harness with anything to install: is it here, and what of Relo's is installed and current. */
export function harnessesOf(dependencies, probe) {
  const blocks = tried(() => inspectBlocks(probe))?.files ?? [];
  const hookFiles = tried(() => findHooks(probe).filter((file) => file.place === "global")) ?? [];
  const skills = tried(() => findSkillCopies({ ...probe, cliVersion: dependencies.version })) ?? [];
  const mcp = tried(() => inspectMcpInstall(probe, { nodePath: dependencies.nodePath, entrypoint: dependencies.entrypoint }))?.files ?? [];
  return HARNESSES.filter((harness) => harness.instructions || harness.skills || harness.hooks || harness.mcp).map((harness) => {
    const instructionFile = harness.instructions?.global
      ? shortPath(harnessPath(harness, harness.instructions.global, probe) ?? "", probe.home) : undefined;
    const block = instructionFile === undefined ? undefined : blocks.find((file) => file.file === instructionFile);
    const copies = skills.filter((copy) => copy.agent === harness.id);
    const mcpFiles = mcp.filter((file) => file.agent === harness.id);
    return {
      id: harness.id,
      detected: isInstalled(harness, probe),
      instructions: block === undefined ? "none" : block.state === "current" ? "set" : block.state,
      // The depth the global block's marker names (notify|track|guide|optimize|custom), none without a block.
      level: block === undefined ? "none" : depthOf(block.modules),
      modules: block?.modules ?? [],
      skill: copies.length === 0 ? "none" : copies.every((copy) => copy.current) ? "current" : "outdated",
      ...hooksOf(harness, hookFiles),
      mcp: mcpFiles.length === 0 ? "none" : mcpFiles.some((file) => file.state === "stale") ? "stale" : "set",
    };
  });
}

/** A setting as the report carries it: its variable's name always, its value only when it is none of the secrets. */
export function reportedSetting(row) {
  const setting = SETTINGS.find((candidate) => candidate.key === row.key);
  // A value that came straight from a variable never leaves the machine; `derived` ones (on/off) are not the variable's text.
  const sendable = !setting.name && !setting.path && (row.source !== "env" || setting.derived === true) && row.value !== undefined;
  return { key: row.key, source: row.source, ...(row.env ? { env: row.env } : {}), ...(sendable ? { value: row.value.slice(0, 200) } : {}) };
}

async function profilesOf(dependencies) {
  try {
    const stored = await dependencies.loadStoredConfig(dependencies.configPath());
    return { count: Array.isArray(stored.profiles) ? stored.profiles.length : 1, active: String(stored.activeProfile ?? stored.profile ?? "default").slice(0, 40) };
  } catch {
    return { count: 0, active: "default" };
  }
}

/** The last `relo doctor` here: { at, ok, failing: [check names] }, or null when none ran. */
async function lastDoctor(dependencies) {
  const saved = await readStateFile(statePath(dependencies, DOCTOR_FILE));
  if (typeof saved?.at !== "string" || typeof saved.ok !== "boolean" || !Array.isArray(saved.failing)) return null;
  return { at: saved.at.slice(0, 40), ok: saved.ok, failing: saved.failing.filter((name) => typeof name === "string").slice(0, 20).map((name) => name.slice(0, 40)) };
}

/** Remembers a doctor run for the report: when, whether it passed, and the names (never the details) of what failed. */
export async function recordDoctor(dependencies, checks) {
  try {
    const failing = Object.entries(checks ?? {}).filter(([, check]) => check?.ok === false && check?.state !== "skipped").map(([name]) => name);
    await writeStateFile(statePath(dependencies, DOCTOR_FILE), { at: new Date(dependencies.now()).toISOString(), ok: failing.length === 0, failing });
  } catch { /* a report detail that cannot be saved is only missing */ }
}

/** The report for this computer now. Reads local files and the cached release check; no network. */
export async function buildReport(dependencies, probes = {}) {
  const env = dependencies.env ?? {};
  const home = dependencies.home;
  const probe = { env, home, cwd: home, platform: dependencies.platform ?? process.platform };
  const advice = await cachedUpdateAdvice(dependencies).catch(() => undefined);
  const platform = probes.platform ?? process.platform;
  const queued = dependencies.outboxDirectory ? await pending({ directory: dependencies.outboxDirectory }).catch(() => undefined) : undefined;
  return {
    cli: { version: String(dependencies.version).slice(0, 40), latest: advice?.latest ?? null, update: advice?.state ?? "unknown" },
    os: { platform: PLATFORMS.has(platform) ? platform : "other", release: String(tried(probes.release ?? osRelease) ?? "").slice(0, 64) },
    machineKind: machineKind(env, probes),
    harnesses: harnessesOf(dependencies, probe),
    settings: (await currentSettings(dependencies)).map(reportedSetting),
    profiles: await profilesOf(dependencies),
    doctor: await lastDoctor(dependencies),
    outbox: { pending: queued?.total ?? 0 },
  };
}

/** sha256 of the report as canonical JSON (keys sorted), the change detector and the idempotency key. */
export function reportHash(report) {
  const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
  return createHash("sha256").update(JSON.stringify(canonical(report))).digest("hex");
}

/**
 * Sends the report when it differs from the last one sent (or the last is a day old). Never throws: a failure
 * leaves the remembered hash alone, so the next call tries again. `background` throttles the caller that runs often
 * (the outbox flusher) to one look every 10 minutes; `force` sends even an unchanged report (the join's first one). Returns { sent, reason }.
 */
export async function sendReportIfChanged(dependencies, { background = false, force = false, probes } = {}) {
  const minIntervalMs = background ? FLUSH_INTERVAL_MS : 0;
  try {
    const now = dependencies.now();
    const path = statePath(dependencies, REPORT_FILE);
    const saved = await readStateFile(path);
    if (minIntervalMs > 0 && Number.isFinite(saved?.checkedAt) && now - saved.checkedAt >= 0 && now - saved.checkedAt < minIntervalMs) {
      return { sent: false, reason: "recent" };
    }
    // Only a browser sign-in is a computer: an environment credential (CI) has none.
    const config = await dependencies.loadConfig(dependencies.configPath());
    if (config.source === "environment") return { sent: false, reason: "no-computer" };
    // Asked now even when the send below fails: the flusher's next ask waits its interval, a command's does not.
    await writeStateFile(path, { ...(saved ?? {}), checkedAt: now });
    const report = await buildReport(dependencies, probes);
    const hash = reportHash(report);
    const unchanged = !force && saved?.hash === hash && Number.isFinite(saved.sentAt) && now - saved.sentAt >= 0 && now - saved.sentAt < DAY_MS;
    if (unchanged) return { sent: false, reason: "unchanged" };
    if (JSON.stringify(report).length > FACTS.computers.reportMaxBytes) return { sent: false, reason: "too-large" };
    await dependencies.clientFactory(config).putComputerReport(report, hash);
    await writeStateFile(path, { hash, sentAt: now, checkedAt: now });
    return { sent: true, reason: "changed" };
  } catch {
    return { sent: false, reason: "failed" };
  }
}
