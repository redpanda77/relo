// The command registry (src/registry.mjs, from each module's spec file) is the one list of commands: every
// entry documents itself and names a handler that exists, for each producer type it serves.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, findCommand, handlerFor, optionsOf } from "../src/registry.mjs";
import { OPTIONS } from "../src/shared/options.mjs";

const handlers = (entry) => (entry.variants ? Object.entries(entry.variants) : [["all", entry]]);

test("names are unique and every entry documents itself", () => {
  const names = COMMANDS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const entry of COMMANDS) {
    assert.ok(entry.summary?.length > 20, `${entry.name}: summary`);
    for (const option of optionsOf(entry)) assert.ok(OPTIONS[option], `${entry.name} --${option} is not in shared/options.mjs`);
  }
});

test("every handler loads and exports the function it names", async () => {
  for (const entry of COMMANDS.filter((candidate) => !candidate.root)) {
    for (const [surface, handler] of handlers(entry)) {
      const module = await handler.load();
      assert.equal(typeof module[handler.run], "function", `${entry.name} (${surface}): ${handler.run}`);
      assert.ok(handler.auth === undefined || handler.auth === "client", `${entry.name}: auth`);
    }
  }
});

test("a command with variants serves both producer types, and the owner where relo admin offers it", () => {
  for (const entry of COMMANDS.filter((candidate) => candidate.variants)) {
    assert.deepEqual(Object.keys(entry.variants).sort(), entry.admin ? ["agent", "owner", "script"] : ["agent", "script"], entry.name);
    assert.ok(handlerFor(entry, "agent") && handlerFor(entry, "script"));
  }
});

test("lookup: two words, one word, and a group's shared handler for an unknown action", () => {
  assert.equal(findCommand("work", "start").name, "work start");
  assert.equal(findCommand("doctor", undefined).name, "doctor");
  assert.equal(findCommand("account", "work").name, "account", "a one-word command takes the next word as its argument");
  assert.ok(findCommand("work", "frobnicate"), "relo work answers an unknown verb itself");
  assert.equal(findCommand("frobnicate", undefined), undefined);
});

test("a group with no action names its commands, not an unknown command", async () => {
  const { execute } = await import("../src/cli.mjs");
  await assert.rejects(execute(["admin"], {}), (error) => /^Usage \(only when the owner asks/u.test(error.message));
  await assert.rejects(execute(["hooks", "status"], {}), (error) => /^Unknown command: hooks/u.test(error.message), "relo hooks is gone: relo setup --show");
});

test("help all lists every public command, and no help text names a flag that does not exist", async () => {
  const { GUIDE, HELP, HELP_SECTION_GROUPS, IDENTITY_HELP } = await import("../src/help.mjs");
  for (const entry of COMMANDS.filter((candidate) => !candidate.internal)) {
    assert.ok(HELP_SECTION_GROUPS.includes(entry.name.split(" ")[0]), `${entry.name} has no help section`);
    const typed = entry.alias && entry.alias.length < entry.name.length ? entry.alias : entry.name;
    assert.ok(HELP.includes(`  relo ${typed}`), `relo help all is missing relo ${typed}`);
  }
  const GLOBAL = new Set(["json", "full", "help", "version"]);
  for (const [name, text] of [["help all", HELP], ["help", GUIDE], ["help identity", IDENTITY_HELP]]) {
    // npm's own flags (npm install --global …) are not Relo's.
    for (const [, flag] of text.replace(/npm (?:un)?install --global/gu, "npm").matchAll(/(?<![\w-])--([a-z][a-z-]*)/gu)) {
      assert.ok(OPTIONS[flag] || GLOBAL.has(flag), `relo ${name} names --${flag}, which no command takes`);
    }
  }
});

test("relo help GROUP lists the group's commands; relo help admin includes the cross-session views", async () => {
  const { execute } = await import("../src/cli.mjs");
  const keys = (await execute(["help", "keys"], {})).data.help;
  for (const entry of COMMANDS.filter((candidate) => candidate.name.startsWith("keys "))) assert.match(keys, new RegExp(`relo ${entry.name}\\b`, "u"));
  const admin = (await execute(["help", "admin"], {})).data.help;
  for (const name of ["admin works", "admin finish", "admin sessions", "admin activity end"]) assert.match(admin, new RegExp(`relo ${name}\\b`, "u"));
});
