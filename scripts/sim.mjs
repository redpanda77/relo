#!/usr/bin/env node
// iOS Simulators on a lease (plan 15): a simulator is booted for one run and always shut down after it, and
// one nobody holds is shut down by the reaper. A booted simulator idles at about one full core (rendering,
// backboardd, the app); on 19 Oct one left booted by a screenshot check ran for five hours.
//
//   node scripts/sim.mjs run [--device NAME|UDID] [--timeout 15m] -- COMMAND [ARGS...]
//       boots the device (default: the newest available iPhone), runs COMMAND with RELO_SIMULATOR_UDID set, as one
//       heavy step (scripts/step.mjs: one at a time, background priority, a budget), then shuts the device down,
//       also when COMMAND fails, times out or is interrupted.
//   node scripts/sim.mjs reap [--idle 15m]
//       shuts down every booted simulator without a live lease that has been up longer than --idle (default 15m).
//   node scripts/sim.mjs status
//       booted simulators, how long they have been up, and who holds them.
//
// Agents and scripts never boot a simulator any other way (Xcode's run button is the owner's own).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const leases = (env = process.env) => join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "relo", "sim-leases");
const simctl = (...args) => execFileSync("/usr/bin/xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const durationMs = (text) => { const m = /^(\d+)(s|m|h)?$/u.exec(String(text ?? "")); if (!m) throw new Error(`not a duration: ${text}`); return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] ?? "s"] * 1000; };

/** Booted devices: [{ udid, name, upMs }]; up time from the device's launchd_sim process. */
export function booted({ list = () => JSON.parse(simctl("list", "devices", "booted", "-j")), ps = () => execFileSync("/bin/ps", ["-A", "-o", "etime=,command="], { encoding: "utf8" }) } = {}) {
  const devices = Object.values(list().devices ?? {}).flat().filter((device) => device.state === "Booted");
  const lines = ps().split("\n");
  return devices.map((device) => {
    const line = lines.find((row) => row.includes("launchd_sim") && row.includes(device.udid));
    return { udid: device.udid, name: device.name, upMs: line ? elapsedMs(line.trim().split(/\s+/u)[0]) : 0 };
  });
}

/** ps etime ([[dd-]hh:]mm:ss) in ms. */
export function elapsedMs(etime) {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return (((Number(days) * 24 + parts[0]) * 60 + parts[1]) * 60 + parts[2]) * 1000;
}

/** The leases still held by a live process: Set of UDIDs. Dead holders' leases are removed. */
export function heldLeases(dir = leases()) {
  const held = new Set();
  let names = [];
  try { names = readdirSync(dir); } catch { return held; }
  for (const name of names) {
    try {
      const lease = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (alive(lease.pid)) held.add(lease.udid); else rmSync(join(dir, name), { force: true });
    } catch { rmSync(join(dir, name), { force: true }); }
  }
  return held;
}

/** What the reaper shuts down: booted, unheld, up longer than idleMs. */
export function toReap(devices, held, idleMs) {
  return devices.filter((device) => !held.has(device.udid) && device.upMs >= idleMs);
}

function pickDevice(wanted) {
  const devices = Object.entries(JSON.parse(simctl("list", "devices", "available", "-j")).devices ?? {})
    .flatMap(([runtime, list]) => list.map((device) => ({ ...device, runtime })));
  if (wanted) {
    const found = devices.find((device) => device.udid === wanted || device.name === wanted);
    if (!found) throw new Error(`no available simulator named ${wanted}`);
    return found;
  }
  const iphones = devices.filter((device) => /^iPhone/u.test(device.name)).sort((a, b) => b.runtime.localeCompare(a.runtime, "en", { numeric: true }));
  if (!iphones.length) throw new Error("no available iPhone simulator");
  return iphones[0];
}

async function run({ device, timeout, command }) {
  const target = pickDevice(device);
  const dir = leases();
  mkdirSync(dir, { recursive: true });
  const lease = join(dir, `${target.udid}.${process.pid}.json`);
  writeFileSync(lease, JSON.stringify({ udid: target.udid, name: target.name, pid: process.pid, command: command.join(" ").slice(0, 200), at: new Date().toISOString() }));
  const wasBooted = target.state === "Booted";
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return;
    shutDown = true;
    rmSync(lease, { force: true });
    // Someone else's lease on the same device keeps it up; otherwise it goes down, even if it was up before.
    if (heldLeases(dir).has(target.udid)) return;
    try { simctl("shutdown", target.udid); process.stderr.write(`sim: ${target.name} shut down\n`); } catch { /* already down */ }
  };
  process.on("exit", shutdown);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { shutdown(); process.exit(130); });
  if (!wasBooted) { simctl("boot", target.udid); }
  simctl("bootstatus", target.udid, "-b");
  process.stderr.write(`sim: ${target.name} (${target.udid}) leased for: ${command.join(" ").slice(0, 80)}\n`);
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "step.mjs"), "--name", `simulator: ${command[0]}`, "--heavy", "--timeout", timeout, "--quiet", "5m", "--", ...command],
      { stdio: "inherit", env: { ...process.env, RELO_SIMULATOR_UDID: target.udid } });
    child.on("close", (code) => resolve(code ?? 1));
  });
  shutdown();
  return status;
}

function reap(idleMs) {
  const devices = booted();
  const victims = toReap(devices, heldLeases(), idleMs);
  for (const device of victims) {
    try { simctl("shutdown", device.udid); process.stderr.write(`sim: reaped ${device.name}, up ${Math.round(device.upMs / 60000)} min with no lease\n`); }
    catch (error) { process.stderr.write(`sim: could not shut down ${device.name}: ${error.message}\n`); }
  }
  if (!victims.length) process.stderr.write(`sim: nothing to reap (${devices.length} booted)\n`);
  return 0;
}

function status() {
  const held = heldLeases();
  const devices = booted();
  if (!devices.length) process.stdout.write("no simulator is booted\n");
  for (const device of devices) process.stdout.write(`${device.name} ${device.udid} up ${Math.round(device.upMs / 60000)} min, ${held.has(device.udid) ? "leased" : "NO LEASE (the reaper shuts it down)"}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [action, ...rest] = process.argv.slice(2);
  const split = rest.indexOf("--");
  const flags = split === -1 ? rest : rest.slice(0, split);
  const flag = (name, fallback) => { const index = flags.indexOf(name); return index === -1 ? fallback : flags[index + 1]; };
  try {
    if (action === "run" && split !== -1 && rest.length > split + 1) process.exitCode = await run({ device: flag("--device"), timeout: flag("--timeout", "15m"), command: rest.slice(split + 1) });
    else if (action === "reap") process.exitCode = reap(durationMs(flag("--idle", "15m")));
    else if (action === "status") process.exitCode = status();
    else { process.stderr.write("usage: sim.mjs run [--device NAME] [--timeout 15m] -- COMMAND | reap [--idle 15m] | status\n"); process.exitCode = 2; }
  } catch (error) { process.stderr.write(`sim: ${error.message}\n`); process.exitCode = 1; }
}
