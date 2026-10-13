#!/bin/bash
# Local PostgreSQL + unsigned simulator acceptance. Never signs, installs on a phone, or sends APNs.
set -euo pipefail
RELO_INTEGRATED_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RELO_INTEGRATED_ROOT"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Commit measured sources first; dirty source identities are not accepted.' >&2; exit 1
fi
: "${RELO_INTEGRATED_OUTPUT_DIR:?Use a fresh evidence directory}"
: "${RELO_DERIVED_DATA:?Reuse a configured simulator build directory}"
: "${RELO_SIMULATOR_UDID:?Choose an installed simulator}"
: "${TEST_DATABASE_URL:?Use a disposable migrated localhost database ending in _test}"
if [[ -e "$RELO_INTEGRATED_OUTPUT_DIR" ]]; then echo 'Evidence directory already exists.' >&2; exit 1; fi
mkdir -p "$RELO_INTEGRATED_OUTPUT_DIR"
export RELO_BENCHMARK_SOURCE_COMMIT="$(git rev-parse HEAD)"
RELO_BENCHMARK_OUTPUT_DIR="$RELO_INTEGRATED_OUTPUT_DIR/immediate" bash scripts/benchmark-latency.sh
export RELO_INTEGRATED_BENCHMARK_OUTPUT="$RELO_INTEGRATED_OUTPUT_DIR/server.ndjson"
node apps/server/node_modules/vitest/vitest.mjs run --root apps/server src/inbox/performance.test.ts --no-file-parallelism \
  > "$RELO_INTEGRATED_OUTPUT_DIR/server-tests.log" 2>&1
xcodebuild test-without-building -xctestrun "$RELO_DERIVED_DATA/Build/Products/LatencyBaseline.xctestrun" \
  -destination "platform=iOS Simulator,id=$RELO_SIMULATOR_UDID" -parallel-testing-enabled NO \
  -only-testing:ReloAppTests/InboxIntegrationTests \
  -resultBundlePath "$RELO_INTEGRATED_OUTPUT_DIR/current.xcresult" \
  > "$RELO_INTEGRATED_OUTPUT_DIR/current-tests.log" 2>&1
xcrun xcresulttool export attachments --path "$RELO_INTEGRATED_OUTPUT_DIR/current.xcresult" \
  --output-path "$RELO_INTEGRATED_OUTPUT_DIR/attachments" > "$RELO_INTEGRATED_OUTPUT_DIR/export.log"
node --input-type=module - "$RELO_INTEGRATED_OUTPUT_DIR" <<'JS'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {summarizeSpans} from './scripts/relo-latency-report.mjs';
const directory=process.argv[2];
const lines=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const spans=[...lines(join(directory,'immediate/spans.ndjson')),...lines(join(directory,'server.ndjson'))];
let currentCollectors=0;
for(const file of readdirSync(join(directory,'attachments'))) {
  if(file==='manifest.json')continue;
  const path=join(directory,'attachments',file),value=readFileSync(path,'utf8');
  if(value.startsWith('{"clock":"monotonic"')) {spans.push(...lines(path));currentCollectors++;}
  if(value.startsWith('{"sourceCommit"'))writeFileSync(join(directory,'ios-shape.json'),value+'\n');
}
if(currentCollectors!==1 || spans.some(span=>span.sourceCommit!==process.env.RELO_BENCHMARK_SOURCE_COMMIT))throw new Error('Missing or mixed source evidence');
const report=summarizeSpans(spans);
const budgets={commit_to_dispatch:100,api_to_ack:200,tap_to_request_start:100,decision_commit_to_wakeup:100,foreground_hint_to_render:250,nse_processing:150};
const failures=report.groups.filter(group=>group.failed || group.cancelled || !group.durationMs || group.durationMs.p95>=budgets[group.stage]);
const shape=JSON.parse(readFileSync(join(directory,'server.ndjson.shape.json'),'utf8'));
const queries=[...new Set(shape.samples.map(sample=>sample.scenario))].map(scenario=>{
  const samples=shape.samples.filter(sample=>sample.scenario===scenario),durations=samples.map(sample=>sample.durationMs).sort((a,b)=>a-b);
  const percentile=p=>durations[Math.ceil(durations.length*p)-1];
  return {scenario,count:samples.length,bytes:{minimum:Math.min(...samples.map(sample=>sample.bytes)),maximum:Math.max(...samples.map(sample=>sample.bytes))},durationMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}};
});
const result={...report,fixture:'integrated-v1',budgetsMs:budgets,queries,failedBudgetScenarios:failures.map(group=>group.scenario),
  boundaries:{api:'Hono entry through committed response serialization; excludes network',dispatch:'Local PostgreSQL commit through injected provider start; excludes APNs',current:'Hosted AppModel publication plus current UI projection; excludes network query and compositor frame',query:'Hono and PostgreSQL read round trip on the same machine',phone:'Unproven; user installation required'}};
writeFileSync(join(directory,'spans.ndjson'),spans.map(span=>JSON.stringify(span)).join('\n')+'\n');
writeFileSync(join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(report.missingStages.length || failures.length)process.exitCode=1;
JS
