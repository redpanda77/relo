import assert from "node:assert/strict";
import test from "node:test";
import { numberOption, parseArgs, parseDuration, requireText, validateHttpsUrl, validatePublicHttpsUrl } from "../src/args.mjs";

test("parses commands, repeatable values, and inline values", () => {
  const parsed = parseArgs([
    "notify",
    "send",
    "Build complete",
    "--title=CI",
    "--device",
    "dev_a",
    "--device=dev_b",
    "--json",
  ]);
  assert.deepEqual(parsed.positionals, ["notify", "send", "Build complete"]);
  assert.deepEqual(parsed.options.device, ["dev_a", "dev_b"]);
  assert.equal(parsed.options.title, "CI");
  assert.equal(parsed.options.json, true);

  const login = parseArgs([
    "auth",
    "login",
    "--scope",
    "notifications:send",
    "--scope=interactions:create",
    "--no-open",
  ]);
  assert.deepEqual(login.options.scope, ["notifications:send", "interactions:create"]);
  assert.equal(login.options["no-open"], true);
});

test("parses the stdin and stable ask selectors exactly", () => {
  assert.deepEqual(
    parseArgs(["ask", "--stdin", "--yes-no", "--json"]),
    {
      positionals: ["ask"],
      options: { device: [], scope: [], stdin: true, "yes-no": true, json: true },
    },
  );
  const labelled = parseArgs(["ask", "Deploy?", "--approval", "--primary-label=Deploy", "--secondary-label", "Cancel"]);
  assert.equal(labelled.options["primary-label"], "Deploy");
  assert.equal(labelled.options["secondary-label"], "Cancel");
  for (const removed of ["--poll", "--live-activity", "--text"]) {
    assert.throws(() => parseArgs(["ask", "Deploy?", removed]), /Unknown option/);
  }
});

test("treats values after the separator as positional data", () => {
  const parsed = parseArgs(["notify", "send", "--", "--not-an-option"]);
  assert.deepEqual(parsed.positionals, ["notify", "send", "--not-an-option"]);
  assert.equal(parsed.separatorAt, 2);
});

test("parses explicit trusted origins and bounded inventory options", () => {
  const parsed = parseArgs([
    "auth", "login", "--api-url", "https://relo.example", "--limit=10",
    "--page-size", "25", "--secret-file", "hook.url",
  ]);
  assert.equal(parsed.options["api-url"], "https://relo.example");
  assert.equal(parsed.options.limit, "10");
  assert.equal(parsed.options["page-size"], "25");
  assert.equal(parsed.options["secret-file"], "hook.url");
  assert.throws(() => parseArgs(["activity","status","--origin-file","origin.json"]),/Unknown option/);
  assert.equal(parseArgs(["activity","status","--name","release-build"]).options.name,"release-build");
});

test("forbids credential flags and rejects unknown or duplicate options", () => {
  assert.throws(() => parseArgs(["auth", "status", "--token", "secret"]), /forbidden; credentials come from/);
  assert.throws(() => parseArgs(["auth", "status", "--api-token=secret"]), /forbidden; credentials come from/);
  assert.throws(() => parseArgs(["devices", "list", "--wat"]), /Unknown option/);
  assert.throws(() => parseArgs(["notify", "send", "x", "--title", "a", "--title", "b"]), /only be specified once/);
});

test("validates durations, numeric options, text, and HTTPS URLs", () => {
  assert.equal(parseDuration("1.5m"), 90);
  assert.equal(parseDuration("90d", { maximumSeconds: 31_536_000 }), 7_776_000);
  assert.equal(parseDuration(undefined, { defaultSeconds: 60 }), 60);
  assert.throws(
    () => parseDuration("30m", { minimumSeconds: 3_600, maximumSeconds: 86_400 }),
    /between/,
  );
  assert.throws(() => parseDuration("0s"), /between/);
  assert.equal(numberOption("0.25", "progress", { minimum: 0, maximum: 1 }), 0.25);
  assert.throws(() => numberOption("2", "progress", { maximum: 1 }), /at most/);
  assert.equal(requireText(" Ready ", "Body"), "Ready");
  assert.throws(() => requireText("bad\u0000value", "Body"), /control/);
  assert.equal(validateHttpsUrl("https://example.test/path", "url"), "https://example.test/path");
  assert.throws(() => validateHttpsUrl("http://example.test", "url"), /HTTPS/);
  assert.equal(validatePublicHttpsUrl("https://cdn.example.test/a.png", "image"), "https://cdn.example.test/a.png");
  for (const value of [
    "https://localhost/a.png",
    "https://host.local/a.png",
    "https://10.0.0.1/a.png",
    "https://192.168.1.1/a.png",
    "https://[::1]/a.png",
    "https://[2001:db8::1]/a.png",
  ]) assert.throws(() => validatePublicHttpsUrl(value, "image"), /public HTTPS/);
  assert.equal(validateHttpsUrl("https://localhost/private", "url"), "https://localhost/private");
});
