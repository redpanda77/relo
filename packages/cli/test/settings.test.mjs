import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS, envSetting, resolveSettings, updateCheckDisabled } from "../src/shared/settings.mjs";

const row = (rows, key) => rows.find((entry) => entry.key === key);

test("the variable wins over the config file, the config file over what the machine shows, then the default", () => {
  const config = { computer: "Config Mac", profile: "work" };
  const detected = { computer: "Detected Mac", project: "repo", source: "Claude Code" };
  const rows = resolveSettings({ env: { RELO_COMPUTER: "Env Mac" }, config, detected, defaults: { profile: "default" } });
  assert.deepEqual(row(rows, "computer"), { key: "computer", value: "Env Mac", source: "env", env: "RELO_COMPUTER" });
  assert.equal(row(resolveSettings({ env: {}, config, detected }), "computer").source, "config");
  assert.equal(row(resolveSettings({ env: {}, config: {}, detected }), "computer").source, "detected");
  assert.equal(row(rows, "project").source, "detected");
  assert.deepEqual(row(resolveSettings({ env: {}, config: {}, detected: {}, defaults: { profile: "default" } }), "profile"), { key: "profile", value: "default", source: "default", env: "RELO_PROFILE" });
  assert.equal(row(rows, "topic").value, undefined, "nothing sets the topic");
});

test("a blank variable is not set; values are trimmed", () => {
  assert.equal(envSetting("project", { RELO_PROJECT: "   " }), undefined);
  assert.equal(envSetting("project", { RELO_PROJECT: " Relo " }), "Relo");
  assert.equal(row(resolveSettings({ env: { RELO_PROJECT: " " }, detected: { project: "repo" } }), "project").source, "detected");
});

test("the update check: off for anything but blank or 0, shown as on/off and never as the variable's text", () => {
  assert.equal(updateCheckDisabled({}), false);
  assert.equal(updateCheckDisabled({ RELO_NO_UPDATE_CHECK: "0" }), false);
  assert.equal(updateCheckDisabled({ RELO_NO_UPDATE_CHECK: "yes" }), true);
  assert.deepEqual(row(resolveSettings({ env: { RELO_NO_UPDATE_CHECK: "yes" } }), "updateCheck"), { key: "updateCheck", value: "off", source: "env", env: "RELO_NO_UPDATE_CHECK" });
  assert.deepEqual(row(resolveSettings({ env: {} }), "updateCheck"), { key: "updateCheck", value: "on", source: "default", env: "RELO_NO_UPDATE_CHECK" });
});

test("rows follow the registry and carry the variable's name, never its value", () => {
  const rows = resolveSettings({ env: { RELO_TOPIC: "secret topic" } });
  assert.deepEqual(rows.map((entry) => entry.key), SETTINGS.map((setting) => setting.key));
  assert.ok(rows.every((entry) => /^RELO_[A-Z_]+$/u.test(entry.env)));
});
