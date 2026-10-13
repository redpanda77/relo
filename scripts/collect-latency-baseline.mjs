import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeSpans } from "./relo-latency-report.mjs";

const directory = resolve(process.argv[2]);
const identity = JSON.parse(readFileSync(join(directory, "identity.json"), "utf8"));
const lines = name => readFileSync(name, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
const samples = [...lines(join(directory, "dispatch.ndjson")), ...lines(join(directory, "requester.ndjson"))];
// xcresult export assigns opaque filenames. Only collect typed spans, never arbitrary attachments.
let attachments = 0;
for (const file of readdirSync(join(directory, "attachments"))) {
  if (file === "manifest.json") continue;
  const content = readFileSync(join(directory, "attachments", file), "utf8");
  if (!content.startsWith('{"clock":"monotonic"')) continue;
  const spans = lines(join(directory, "attachments", file));
  summarizeSpans(spans); samples.push(...spans); attachments++;
}
if (attachments !== 2 || samples.some(span => span.sourceCommit !== identity.sourceCommit)) {
  throw new Error("Missing native collectors or mixed source identity");
}
const report = summarizeSpans(samples);
for (const stage of ["commit_to_dispatch", "decision_commit_to_wakeup", "tap_to_request_start", "nse_processing"]) {
  if (report.missingStages.includes(stage)) throw new Error(`Missing required baseline: ${stage}`);
}
writeFileSync(join(directory, "spans.ndjson"), samples.map(sample => JSON.stringify(sample)).join("\n") + "\n");
writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
