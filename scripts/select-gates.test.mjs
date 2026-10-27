import assert from "node:assert/strict";
import test from "node:test";
import { GATES, gatesFor, selectGates } from "./select-gates.mjs";

const heavy = ["contracts", "dashboard", "server"];

test("server, contracts, migrations, dashboard and deploy paths select the server gates", () => {
  for (const path of ["apps/server/src/app.ts", "apps/server/migrations/0115_work_handoffs.sql", "packages/contracts/src/works.ts", "packages/owner-crypto/src/keys.ts", "packages/owner-crypto/test/envelope.test.ts",
    "apps/dashboard/src/main.tsx", "deploy/compose.yaml", "docs/api/openapi.json", "docs/internal/operations/example-host/compose.yaml"]) {
    for (const gate of heavy) assert.ok(gatesFor(path).includes(gate), `${path} selects ${gate}`);
  }
});

test("the owner client selects only the contracts gate", () => {
  assert.deepEqual(gatesFor("packages/owner-client/src/store.ts"), ["contracts"]);
  assert.deepEqual(selectGates(["packages/owner-client/package.json"]).selected, ["contracts"]);
});

test("paths only the phone, the notch app, the Windows app or internal notes read select no gate", () => {
  const { selected } = selectGates(["apps/ios/Sources/ReloApp/NowView.swift", "apps/notch/Sources/Orb.swift",
    "apps/windows/src/notch/Notch.tsx",
    "docs/internal/STATUS.md", "docs/adr/0012-handoff.md", "ROADMAP.md", ".github/workflows/ci.yml"]);
  assert.deepEqual(selected, []);
});

test("Dashboard sounds and images select only the Dashboard gate; its code still selects the server", () => {
  assert.deepEqual(selectGates(["apps/dashboard/src/assets/sounds/done.m4a", "apps/dashboard/public/icon.png"]).selected, ["dashboard"]);
  assert.deepEqual(gatesFor("apps/dashboard/src/assets/theme.ts"), heavy);
});

test("iOS fixtures and the E2EE source are shared with the server and CLI tests", () => {
  for (const path of ["apps/ios/Tests/ReloCoreTests/Fixtures/e2ee-v1.json", "apps/ios/Sources/ReloCore/E2EE/ReloSealedCards.swift"]) {
    assert.deepEqual(gatesFor(path), [...heavy, "cli"]);
  }
});

test("CLI, skill and script paths select their own gates; the CLI also selects the server (its tests import it)", () => {
  assert.deepEqual(selectGates(["skills/relo-notifications/SKILL.md"]).selected, ["cli", "skill", "repo"]);
  assert.deepEqual(selectGates(["packages/cli/src/help.mjs"]).selected, GATES);
  assert.deepEqual(selectGates(["scripts/public-export.mjs"]).selected, ["repo"]);
  assert.deepEqual(selectGates(["docs/site/reference/files.md"]).selected, [...heavy, "cli"]);
});

test("the gate machinery, the workspace and any unknown path select every gate", () => {
  for (const path of ["scripts/gates.sh", "scripts/release/head-gates.sh", "pnpm-lock.yaml", "package.json", "something/new.txt"]) {
    assert.deepEqual(selectGates([path]).selected, GATES, path);
  }
  assert.deepEqual(selectGates(["something/new.txt"]).unknown, ["something/new.txt"]);
});
