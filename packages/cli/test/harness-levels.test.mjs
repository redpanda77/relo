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

test("levels are off, reminders, presence; reminders sends nothing (no presence roles)", () => {
  assert.deepEqual(HOOK_LEVELS, ["off", "reminders", "presence"]);
  assert.deepEqual(wantedEntries("off"), {});
  const reminders = commands({ hooks: wantedEntries("reminders") });
  assert.deepEqual(reminders.sort(), ["relo hook await", "relo hook guard", "relo hook guard", "relo hook release", "relo hook remind", "relo hook restore", "relo hook turn"]);
  assert.equal(wantedEntries("reminders").Stop[0].hooks[0].timeout, 5);
  assert.equal(wantedEntries("reminders").UserPromptSubmit[0].hooks[0].async, true);
  const presence = commands({ hooks: wantedEntries("presence") });
  const observed = ["start", "prompt", "tool-start", "tool-end", "wait", "subagent-start", "subagent-stop", "compact", "stop"];
  for (const role of [...observed, "end"]) assert.ok(presence.includes(`relo hook ${role}`), role);
  for (const [event, groups] of Object.entries(wantedEntries("presence"))) {
    for (const g of groups) for (const h of g.hooks) if (observed.map((role) => `relo hook ${role}`).includes(h.command)) assert.equal(h.async, true, `${event} ${h.command}`);
  }
});

test("planLevel reconciles to exactly the level, keeps others' hooks, and inferLevel reads it back", () => {
  const original = `${JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, null, 2)}\n`;
  const reminders = planLevel("/s.json", original, "reminders");
  const parsed = JSON.parse(reminders.content);
  assert.equal(parsed.model, "x");
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "mine");
  assert.deepEqual(inferLevel(parsed), { level: "reminders", outdated: [] });
  assert.equal(planLevel("/s.json", reminders.content, "reminders").action, "unchanged");
  const presence = JSON.parse(planLevel("/s.json", reminders.content, "presence").content);
  assert.equal(inferLevel(presence).level, "presence");
  const back = JSON.parse(planLevel("/s.json", JSON.stringify(presence), "reminders").content);
  assert.equal(inferLevel(back).level, "reminders");
  const off = planLevel("/s.json", JSON.stringify(presence, null, 2) + "\n", "off");
  assert.equal(off.action, "removed");
  assert.deepEqual(JSON.parse(off.content), JSON.parse(original));
});

test("inferLevel reports legacy sync presence entries and hand-edited mixes", () => {
  const legacy = { hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 5 }] }] } };
  assert.equal(inferLevel(legacy).level, "legacy");
  assert.deepEqual(inferLevel(legacy).outdated, ["Stop"]);
  const custom = { hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook remind", timeout: 9 }] }] } };
  assert.equal(inferLevel(custom).level, "custom");
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
        if (name in EVENT_COMMANDS) assert.equal(adapter.events[native], EVENT_COMMANDS[name], `${adapter.id} ${native}`);
      }
    }
  }
});

test("Gemini levels are off and presence; its presence reads back as presence", () => {
  assert.deepEqual(gemini.install.levels, ["off", "presence"]);
  const written = JSON.parse(planFor("/g.json", undefined, "presence", gemini).content);
  assert.deepEqual(inferFor(written, gemini), { level: "presence", outdated: [] });
});
