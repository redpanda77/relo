import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stages = ["commit_to_dispatch", "tap_to_request_start", "decision_commit_to_wakeup",
  "nse_processing", "api_to_ack", "foreground_hint_to_render"];
const fields = new Set(["stage", "scenario", "sourceCommit", "process", "clock", "outcome", "startNs", "endNs"]);

// Consume local monotonic spans, never subtract timestamps from different hosts.
// Collectors provide no payload, URL, token, or free-text error fields.
export function summarizeSpans(spans) {
  const groups = new Map();
  for (const span of spans) {
    if (!span || Object.keys(span).some(key => !fields.has(key))
      || !stages.includes(span.stage) || span.clock !== "monotonic"
      || !["ok", "failed", "cancelled"].includes(span.outcome)
      || !/^[0-9a-f]{40,64}$/.test(span.sourceCommit ?? "")
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(span.process ?? "")
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(span.scenario ?? "")
      || typeof span.startNs !== "string" || typeof span.endNs !== "string"
      || !/^\d+$/.test(span.startNs) || !/^\d+$/.test(span.endNs)) {
      throw new Error("Invalid latency span; only typed local monotonic measurements are accepted");
    }
    const elapsed = BigInt(span.endNs) - BigInt(span.startNs);
    if (elapsed < 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid elapsed duration");
    const key = JSON.stringify([span.sourceCommit, span.scenario, span.stage]);
    const group = groups.get(key) ?? {
      sourceCommit: span.sourceCommit, scenario: span.scenario, stage: span.stage,
      successful: 0, failed: 0, cancelled: 0, durations: [],
    };
    if (span.outcome === "ok") {
      group.successful += 1;
      group.durations.push(Number(elapsed) / 1_000_000);
    } else group[span.outcome] += 1;
    groups.set(key, group);
  }
  return {
    schemaVersion: 1, total: spans.length,
    missingStages: stages.filter(stage => !spans.some(span => span.stage === stage)),
    groups: [...groups.values()].map(({ durations, ...group }) => {
      durations.sort((a, b) => a - b);
      const percentile = p => durations[Math.ceil(p * durations.length) - 1];
      return { ...group, durationMs: durations.length ? {
        p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: durations.at(-1),
      } : null };
    }),
  };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const lines = readFileSync(process.argv[2] ?? 0, "utf8").split(/\r?\n/).filter(line => line.trim());
  process.stdout.write(`${JSON.stringify(summarizeSpans(lines.map(line => JSON.parse(line))), null, 2)}\n`);
}
