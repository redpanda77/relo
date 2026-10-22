#!/usr/bin/env node
// How hard a command works this Mac (plan 15's success criterion: the Mac is never thrashed). Samples the whole
// machine every 2 s while COMMAND runs, or for --for DURATION alone, and judges it against fixed limits.
//
//   node scripts/load-audit.mjs [--for 60s] [--json FILE] [-- COMMAND [ARGS...]]
//
// Measured: CPU busy across all cores (and on the performance cores alone, which carry the owner's apps), the
// 1-minute load average, memory pressure (free %), thermal or CPU-speed limits (pmset), and the top processes
// by CPU at the busiest moment. Limits weigh the performance cores: they run the owner's apps and make the heat
// (heavy steps run at background priority, which macOS keeps on the efficiency cores). Performance cores average
// <= 30% with no 10 s window above 60%, all cores average <= 50%, memory free >= 20%, no thermal limit. Exits 1 when a limit is broken, or with COMMAND's failure.
import { execFileSync, spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({ averageCpu: 50, windowCpu: 60, performanceCpu: 30, memoryFree: 20 });

const run = (file, args) => { try { return execFileSync(file, args, { encoding: "utf8", timeout: 5000 }); } catch { return ""; } };
const performanceCores = () => Number(run("/usr/sbin/sysctl", ["-n", "hw.perflevel0.logicalcpu"]).trim()) || 0;

/** Busy share per core between two os.cpus() snapshots, in percent. */
export function busy(before, after) {
  return after.map((core, index) => {
    const a = before[index].times, b = core.times;
    const total = Object.keys(b).reduce((sum, key) => sum + (b[key] - a[key]), 0);
    return total > 0 ? 100 * (1 - (b.idle - a.idle) / total) : 0;
  });
}

/** Judges samples [{ at, cores: [%], load, memoryFree, thermal }] against LIMITS. */
export function judge(samples, { performance = 0, intervalMs = 2000 } = {}) {
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const all = samples.map((sample) => mean(sample.cores));
  // Apple silicon numbers the efficiency cores first: the performance cores are the last `performance` ones.
  const perf = samples.map((sample) => mean(performance ? sample.cores.slice(-performance) : sample.cores));
  const span = Math.max(1, Math.round(10_000 / intervalMs));
  let window = 0;
  for (let index = 0; index + span <= perf.length; index += 1) window = Math.max(window, mean(perf.slice(index, index + span)));
  if (perf.length < span) window = Math.max(...perf, 0);
  const result = {
    samples: samples.length, averageCpu: Math.round(mean(all)), peakWindowCpu: Math.round(window), performanceCpu: Math.round(mean(perf)),
    peakLoad: Math.max(...samples.map((sample) => sample.load), 0),
    minMemoryFree: Math.min(...samples.map((sample) => sample.memoryFree ?? 100), 100),
    thermal: samples.some((sample) => sample.thermal),
  };
  const broken = [
    result.averageCpu > LIMITS.averageCpu && `average CPU ${result.averageCpu}% > ${LIMITS.averageCpu}%`,
    result.peakWindowCpu > LIMITS.windowCpu && `performance cores spent a 10 s window at ${result.peakWindowCpu}% > ${LIMITS.windowCpu}%`,
    result.performanceCpu > LIMITS.performanceCpu && `performance cores at ${result.performanceCpu}% > ${LIMITS.performanceCpu}%`,
    result.minMemoryFree < LIMITS.memoryFree && `memory free fell to ${result.minMemoryFree}% < ${LIMITS.memoryFree}%`,
    result.thermal && "the Mac recorded a thermal or CPU-speed limit",
  ].filter(Boolean);
  return { ...result, ok: broken.length === 0, broken };
}

function sampleExtras() {
  const memoryFree = Number(/free percentage: (\d+)%/u.exec(run("/usr/bin/memory_pressure", ["-Q"]))?.[1] ?? 100);
  const therm = run("/usr/bin/pmset", ["-g", "therm"]);
  const thermal = /CPU_Speed_Limit\s*=\s*(\d+)/u.test(therm) && Number(/CPU_Speed_Limit\s*=\s*(\d+)/u.exec(therm)[1]) < 100;
  return { memoryFree, thermal };
}

const topProcesses = () => run("/bin/ps", ["-A", "-o", "%cpu=,comm="]).split("\n").map((line) => line.trim()).filter(Boolean)
  .map((line) => { const [cpu, ...rest] = line.split(/\s+/u); return { cpu: Number(cpu), name: rest.join(" ").split("/").pop() }; })
  .sort((a, b) => b.cpu - a.cpu).slice(0, 5);

async function main(argv) {
  const split = argv.indexOf("--");
  const flags = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const forIndex = flags.indexOf("--for");
  const forMs = forIndex === -1 ? 0 : Number(/^(\d+)s?$/u.exec(flags[forIndex + 1] ?? "")?.[1] ?? 0) * 1000;
  const jsonIndex = flags.indexOf("--json");
  if (!command.length && !forMs) { process.stderr.write("usage: load-audit.mjs [--for 60s] [--json FILE] [-- COMMAND ...]\n"); return 2; }
  const intervalMs = 2000, samples = [];
  let previous = cpus(), busiest = { cpu: -1, top: [] };
  const timer = setInterval(() => {
    const now = cpus();
    const cores = busy(previous, now); previous = now;
    const sample = { at: Date.now(), cores, load: Math.round(loadavg()[0] * 10) / 10, ...sampleExtras() };
    samples.push(sample);
    const average = cores.reduce((sum, value) => sum + value, 0) / cores.length;
    if (average > busiest.cpu) busiest = { cpu: Math.round(average), top: topProcesses() };
  }, intervalMs);
  let status = 0;
  if (command.length) {
    status = await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, forMs));
  }
  clearInterval(timer);
  const verdict = { ...judge(samples, { performance: performanceCores(), intervalMs }), busiest };
  const lines = [
    `load-audit: ${verdict.ok ? "within limits" : "OVER LIMITS"} over ${Math.round(samples.length * intervalMs / 1000)}s`,
    `  CPU average ${verdict.averageCpu}%, performance cores ${verdict.performanceCpu}% (busiest 10 s ${verdict.peakWindowCpu}%), load ${verdict.peakLoad}, memory free >= ${verdict.minMemoryFree}%${verdict.thermal ? ", THERMAL LIMIT" : ""}`,
    `  busiest moment (${busiest.cpu}%): ${busiest.top.map((p) => `${p.name} ${p.cpu}%`).join(", ")}`,
    ...verdict.broken.map((line) => `  broken: ${line}`),
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
  if (jsonIndex !== -1) writeFileSync(flags[jsonIndex + 1], JSON.stringify(verdict, null, 2));
  return status !== 0 ? status : verdict.ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exit(await main(process.argv.slice(2)));
