import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import gemini from "../src/harness/adapters/gemini/index.mjs";
import { wantedEntries, HOOK_LEVELS } from "../src/harness/adapters/claude-code/levels.mjs";
import { inferLevel as inferFor, planLevel as planFor } from "../src/harness/core/install.mjs";

const planLevel = (path, current, level) => planFor(path, current, level, claudeCode);
const inferLevel = (settings) => inferFor(settings, claudeCode);

const commands = (settings) => Object.values(settings.hooks ?? {}).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));

test("sets are off, presence, approvals; presence is the local context entries plus the session phase", () => {
  assert.deepEqual(HOOK_LEVELS, ["off", "presence", "approvals", "presence+lean", "approvals+lean"]);
  assert.deepEqual(wantedEntries("off"), {});
  const presence = commands({ hooks: wantedEntries("presence") });
  for (const role of ["await", "guard", "release", "remind", "restore", "turn"]) assert.ok(presence.includes(`relo hook ${role}`), role);
  assert.equal(wantedEntries("presence").Stop[0].hooks[0].timeout, 5);
  assert.equal(wantedEntries("presence").UserPromptSubmit[0].hooks[0].async, undefined, "the turn hook adds context, so it is not async");
  assert.equal(wantedEntries("presence").UserPromptSubmit[0].hooks[0].timeout, 5);
  const observed = ["start", "prompt", "tool-start", "tool-end", "wait", "subagent-start", "subagent-stop", "compact", "stop"];
  for (const role of [...observed, "end"]) assert.ok(presence.includes(`relo hook ${role}`), role);
  for (const [event, groups] of Object.entries(wantedEntries("presence"))) {
    for (const g of groups) for (const h of g.hooks) if (observed.map((role) => `relo hook ${role}`).includes(h.command)) assert.equal(h.async, true, `${event} ${h.command}`);
  }
  assert.deepEqual(commands({ hooks: wantedEntries("approvals") }).sort(), [...presence, "relo hook permission"].sort());
});

test("planLevel reconciles to exactly the level, keeps others' hooks, and inferLevel reads it back", () => {
  const original = `${JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, null, 2)}\n`;
  const presencePlan = planLevel("/s.json", original, "presence");
  const parsed = JSON.parse(presencePlan.content);
  assert.equal(parsed.model, "x");
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "mine");
  assert.deepEqual(inferLevel(parsed), { level: "presence", outdated: [] });
  assert.equal(planLevel("/s.json", presencePlan.content, "presence").action, "unchanged");
  const approvals = JSON.parse(planLevel("/s.json", presencePlan.content, "approvals").content);
  assert.equal(inferLevel(approvals).level, "approvals");
  const back = JSON.parse(planLevel("/s.json", JSON.stringify(approvals), "presence").content);
  assert.equal(inferLevel(back).level, "presence");
  const off = planLevel("/s.json", JSON.stringify(back, null, 2) + "\n", "off");
  assert.equal(off.action, "removed");
  assert.deepEqual(JSON.parse(off.content), JSON.parse(original));
});

test("inferLevel reads a drifted set or the retired reminders set as custom with the nearest set, and unknown commands as legacy", () => {
  const drifted = { hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 5 }] }] } };
  assert.deepEqual(inferLevel(drifted), { level: "custom", outdated: ["Stop"], nearest: "presence" });
  const reminders = { hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook remind", timeout: 9 }] }] } };
  assert.equal(inferLevel(reminders).level, "custom");
  assert.equal(inferLevel(reminders).nearest, "presence", "refresh upgrades it");
  const legacy = { hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook old-thing" }] }] } };
  assert.equal(inferLevel(legacy).level, "legacy");
  assert.equal(inferLevel({}).level, "off");
});

test("every installed hook command names a canonical event or a local role the hook understands", async () => {
  const { EVENT_COMMANDS } = await import("../src/harness/core/events.mjs");
  const { HARNESS_ROLES } = await import("../src/harness/core/roles.mjs");
  for (const adapter of [claudeCode, gemini]) {
    for (const level of adapter.install.levels) {
      for (const command of commands({ hooks: adapter.install.entries(level) })) {
        const name = command.split(" ")[2];
        assert.ok(name in EVENT_COMMANDS || HARNESS_ROLES.includes(name), `${adapter.id} ${level}: ${command}`);
        assert.ok(command.startsWith("relo hook "), "ownership is recognised by the prefix");
      }
    }
  }
  // Each native event an adapter installs maps to the canonical event its command names.
  for (const adapter of [claudeCode, gemini]) {
    const entries = adapter.install.entries("presence");
    for (const [native, groups] of Object.entries(entries)) {
      for (const g of groups) for (const h of g.hooks) {
        const name = h.command.split(" ")[2];
        // The idle prompt is a Notification the adapter refines to `idle` (see claude-code refine).
        if (name === "idle") assert.equal(adapter.refine("wait", { notification_type: "idle_prompt" }), "idle");
        else if (name in EVENT_COMMANDS) assert.equal(adapter.events[native], EVENT_COMMANDS[name], `${adapter.id} ${native}`);
      }
    }
  }
});

test("Gemini levels are off and presence; its presence reads back as presence", () => {
  assert.deepEqual(gemini.install.levels, ["off", "presence"]);
  const written = JSON.parse(planFor("/g.json", undefined, "presence", gemini).content);
  assert.deepEqual(inferFor(written, gemini), { level: "presence", outdated: [] });
});
