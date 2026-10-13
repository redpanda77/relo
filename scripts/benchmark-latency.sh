#!/bin/bash
# Opt-in local baseline. No physical installation, signing, APNs, or production database writes.
set -euo pipefail
RELO_BENCH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RELO_BENCH_ROOT"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Commit measured sources first; dirty source identities are not accepted.' >&2
  exit 1
fi
export RELO_BENCHMARK_SOURCE_COMMIT="$(git rev-parse HEAD)"
export RELO_BENCHMARK_OUTPUT_DIR="${RELO_BENCHMARK_OUTPUT_DIR:-$(mktemp -d /tmp/relo-latency.XXXXXX)}"
mkdir -p "$RELO_BENCHMARK_OUTPUT_DIR"
# Refuse overwriting previous evidence.
if [[ -e "$RELO_BENCHMARK_OUTPUT_DIR/identity.json" ]]; then
  echo 'Use a fresh benchmark output directory.' >&2; exit 1
fi
: "${TEST_DATABASE_URL:?Point to a migrated, disposable localhost database ending in _test}"
: "${RELO_SIMULATOR_UDID:?Choose an installed iPhone simulator}"
export RELO_BENCHMARK_OUTPUT="$RELO_BENCHMARK_OUTPUT_DIR/requester.ndjson"
export RELO_DERIVED_DATA="${RELO_DERIVED_DATA:-$RELO_BENCHMARK_OUTPUT_DIR/DerivedData}"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.env.RELO_BENCHMARK_OUTPUT_DIR+"/identity.json",JSON.stringify({sourceCommit:process.env.RELO_BENCHMARK_SOURCE_COMMIT,node:process.version,platform:process.platform,architecture:process.arch,startedAt:new Date().toISOString()},null,2)+"\n")'
xcodebuild -version > "$RELO_BENCHMARK_OUTPUT_DIR/xcode.txt"
swift --version > "$RELO_BENCHMARK_OUTPUT_DIR/swift.txt"
# Compile current sources; dependencies must already be installed by the normal workspace bootstrap.
pnpm --filter @relo/notification-contracts build > "$RELO_BENCHMARK_OUTPUT_DIR/contracts-build.log" 2>&1
pnpm --filter @relo/server exec tsc -p tsconfig.json > "$RELO_BENCHMARK_OUTPUT_DIR/server-build.log" 2>&1
node apps/server/dist/benchmarks/delivery-latency.js > "$RELO_BENCHMARK_OUTPUT_DIR/dispatch.ndjson"
node apps/server/node_modules/vitest/vitest.mjs run --root apps/server src/benchmarks/requester-latency.test.ts --no-file-parallelism > "$RELO_BENCHMARK_OUTPUT_DIR/requester-tests.log" 2>&1
cd "$RELO_BENCH_ROOT/apps/ios"
xcodegen generate > "$RELO_BENCHMARK_OUTPUT_DIR/xcodegen.log"
git diff --exit-code -- Relo.xcodeproj/project.pbxproj > "$RELO_BENCHMARK_OUTPUT_DIR/generated-project-check.log"
xcodebuild -project Relo.xcodeproj -scheme Relo -destination "platform=iOS Simulator,id=$RELO_SIMULATOR_UDID" \
  -derivedDataPath "$RELO_DERIVED_DATA" build-for-testing CODE_SIGNING_ALLOWED=NO ENABLE_DEBUG_DYLIB=NO \
  RELO_GIT_COMMIT="$RELO_BENCHMARK_SOURCE_COMMIT" \
  'RELO_SIMULATOR_TEST_ENTITLEMENTS_FLAGS=-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker $(SRCROOT)/Config/SimulatorTest.entitlements' \
  > "$RELO_BENCHMARK_OUTPUT_DIR/native-build.log" 2>&1
# Inject only the immutable measurement identity into the generated test-run configuration.
python3 - <<'PY'
import os,pathlib,plistlib
paths=[path for path in (pathlib.Path(os.environ['RELO_DERIVED_DATA'])/'Build/Products').glob('*.xctestrun')
       if path.name != 'LatencyBaseline.xctestrun']
if len(paths)!=1: raise SystemExit('Expected exactly one generated xctestrun')
config=plistlib.loads(paths[0].read_bytes())
def visit(value):
    if isinstance(value,dict):
        if 'TestBundlePath' in value:
            value.setdefault('EnvironmentVariables',{})['RELO_BENCHMARK_SOURCE_COMMIT']=os.environ['RELO_BENCHMARK_SOURCE_COMMIT']
        for child in value.values(): visit(child)
    elif isinstance(value,list):
        for child in value: visit(child)
visit(config)
(pathlib.Path(os.environ['RELO_BENCHMARK_OUTPUT_DIR'])/'baseline.xctestrun').write_bytes(plistlib.dumps(config))
PY
# __TESTROOT__ paths are relative to the xctestrun; keep the modified copy next to built products.
cp "$RELO_BENCHMARK_OUTPUT_DIR/baseline.xctestrun" "$RELO_DERIVED_DATA/Build/Products/LatencyBaseline.xctestrun"
xcodebuild test-without-building -xctestrun "$RELO_DERIVED_DATA/Build/Products/LatencyBaseline.xctestrun" \
  -destination "platform=iOS Simulator,id=$RELO_SIMULATOR_UDID" -parallel-testing-enabled NO \
  -only-testing:ReloAppTests/ResponseLatencyBaselineTests \
  -only-testing:ReloNotificationSupportTests/ExtensionLatencyBaselineTests \
  -resultBundlePath "$RELO_BENCHMARK_OUTPUT_DIR/native.xcresult" \
  > "$RELO_BENCHMARK_OUTPUT_DIR/native-tests.log" 2>&1
xcrun xcresulttool export attachments --path "$RELO_BENCHMARK_OUTPUT_DIR/native.xcresult" \
  --output-path "$RELO_BENCHMARK_OUTPUT_DIR/attachments" > "$RELO_BENCHMARK_OUTPUT_DIR/export.log"
cd "$RELO_BENCH_ROOT"
node scripts/collect-latency-baseline.mjs "$RELO_BENCHMARK_OUTPUT_DIR"
echo "Baseline saved: $RELO_BENCHMARK_OUTPUT_DIR/report.json"
