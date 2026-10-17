import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTER_ICONS, COMPUTER_NAME_MAX, computerIconSchema, computerReportSchema, computerRenameSchema } from "../src/computers.js";
import { FACTS } from "../src/facts.js";

test("the computer icons are the six in the plan", () => {
  assert.deepEqual([...COMPUTER_ICONS], ["laptop", "desktop", "server", "cloud", "terminal", "build"]);
  assert.equal(computerIconSchema.safeParse("toaster").success, false);
});

test("a rename needs a field, trims the name and accepts null to clear", () => {
  assert.equal(computerRenameSchema.safeParse({}).success, false);
  assert.deepEqual(computerRenameSchema.parse({ name: "  Studio Mac  " }), { name: "Studio Mac" });
  assert.deepEqual(computerRenameSchema.parse({ name: null, icon: null }), { name: null, icon: null });
  assert.deepEqual(computerRenameSchema.parse({ icon: "server" }), { icon: "server" });
});

test("a name is 1 to 80 characters and unknown fields are refused", () => {
  assert.equal(computerRenameSchema.safeParse({ name: "x".repeat(COMPUTER_NAME_MAX) }).success, true);
  assert.equal(computerRenameSchema.safeParse({ name: "x".repeat(COMPUTER_NAME_MAX + 1) }).success, false);
  assert.equal(computerRenameSchema.safeParse({ name: "   " }).success, false);
  assert.equal(computerRenameSchema.safeParse({ name: "ok", label: "x" }).success, false);
  assert.equal(computerRenameSchema.safeParse({ icon: "toaster" }).success, false);
});

const REPORT = {
  cli: { version: "0.17.13", latest: "0.17.14", update: "behind" },
  os: { platform: "darwin", release: "25.0.0" },
  machineKind: "laptop",
  harnesses: [
    { id: "claude-code", detected: true, instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"], skill: "current", hooks: "presence", hooksOutdated: false, mcp: "none" },
    { id: "codex", detected: false, instructions: "none", level: "none", modules: [], skill: "none", hooks: "off", hooksOutdated: false, mcp: "none" },
  ],
  settings: [
    { key: "server", source: "config", env: "RELO_API_URL", value: "https://relo.example.test" },
    { key: "computer", source: "env", env: "RELO_COMPUTER" },
  ],
  profiles: { count: 2, active: "default" },
  doctor: { at: "2026-10-16T10:00:00.000Z", ok: false, failing: ["runtime"] },
  outbox: { pending: 0 },
};

test("a machine report parses; the doctor result may be absent; the machine kind is an icon or null", () => {
  assert.deepEqual(computerReportSchema.parse(REPORT), REPORT);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, doctor: null, machineKind: null }).success, true);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, machineKind: "toaster" }).success, false);
});

test("a machine report is strict: an unknown key anywhere is refused", () => {
  assert.equal(computerReportSchema.safeParse({ ...REPORT, env: { HOME: "/Users/x" } }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, cli: { ...REPORT.cli, path: "/usr/bin/relo" } }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, harnesses: [{ ...REPORT.harnesses[0], hooksFile: "~/.claude/settings.json" }] }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, settings: [{ key: "x", source: "env", token: "y" }] }).success, false);
});

test("a machine report bounds every list and string", () => {
  assert.equal(computerReportSchema.safeParse({ ...REPORT, harnesses: Array.from({ length: 25 }, () => REPORT.harnesses[0]) }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, settings: [{ key: "k", source: "config", value: "v".repeat(201) }] }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, os: { platform: "darwin", release: "r".repeat(65) } }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, os: { platform: "plan9", release: "1" } }).success, false);
  assert.equal(computerReportSchema.safeParse({ ...REPORT, doctor: { ...REPORT.doctor, failing: Array.from({ length: 21 }, () => "x") } }).success, false);
});

test("the largest report the schema allows stays near the size cap's order of magnitude", () => {
  assert.equal(FACTS.computers.reportMaxBytes, 32768);
  const text = (n: number) => "x".repeat(n);
  const biggest = computerReportSchema.parse({
    ...REPORT,
    harnesses: Array.from({ length: 24 }, () => ({ ...REPORT.harnesses[0], id: text(40) })),
    settings: Array.from({ length: 32 }, () => ({ key: text(40), source: "config", env: text(64), value: text(200) })),
    doctor: { at: text(40), ok: false, failing: Array.from({ length: 20 }, () => text(40)) },
  });
  assert.ok(JSON.stringify(biggest).length < FACTS.computers.reportMaxBytes * 2);
});
