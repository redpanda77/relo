import "./hermetic-env.mjs";
// Add a computer (docs/site/guides/servers.md): `relo auth join CODE` redeems a one-time code for this computer's own
// login, saves it like a sign-in and runs relo setup the way the owner chose; `relo auth invite` makes the command.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { openWindowsApp } from "../src/owner/auth.mjs";
import { ApiError, EXIT, NetworkError } from "../src/shared/errors.mjs";
import { createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

const CODE = `rci_${"a".repeat(32)}`;
const TOKEN = `relo_${"t".repeat(43)}`;

async function cli(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false }, dependencies);
  return { exitCode, stdout, stderr, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

async function box({ redeem, agents = [".claude"], pick } = {}) {
  const home = await fakeHome({ agents });
  const cwd = await mkdtemp(join(tmpdir(), "relo-join-cwd-"));
  const state = { redeemed: [], written: [], invites: [], computer: [] };
  const client = {
    putComputerSelf: async (body) => { state.computer.push(body); return {}; },
    redeemComputerInvite: async (body) => {
      state.redeemed.push(body);
      if (redeem) return redeem(body);
      return { accessToken: TOKEN, setup: { level: "guide", approvals: true, ...(pick ? { agents: pick } : {}) },
        credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes } };
    },
    createComputerInvite: async (body) => {
      state.invites.push(body);
      return { code: CODE, command: `curl -fsSL https://relo.example/install.sh | sh -s -- ${CODE}`, expiresAt: "2026-10-16T18:00:00.000Z",
        level: body.level ?? "guide", approvals: body.approvals ?? false };
    },
  };
  const deps = { ...cardDependencies({}), home, cwd, env: {}, computerName: () => "build-box", clientFactory: () => client,
    writeConfig: async (_path, value) => { state.written.push(value); }, stderr: () => {} };
  return { home, state, deps };
}

test("auth join redeems the code for this computer's login, saves it like a sign-in and sets up as the code says", async () => {
  const b = await box();
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.redeemed.length, 1);
  assert.equal(b.state.redeemed[0].code, CODE);
  assert.equal(b.state.redeemed[0].clientName, "build-box");
  assert.deepEqual(b.state.written[0].principal.name, "build-box");
  assert.equal(b.state.written[0].token, TOKEN);
  assert.equal(b.state.written[0].apiUrl, "https://relo.example");
  // relo setup ran at the owner's chosen depth (guide, with approvals): the block, the skill and the hooks.
  assert.deepEqual(out.line.depth, { level: "guide", modules: ["reporting", "planning", "continuity"], skill: true, hooks: "approvals", approvals: true });
  assert.ok(existsSync(join(b.home, ".claude", "skills", "relo-notifications", "SKILL.md")));
  assert.match(await readFile(join(b.home, ".claude", "CLAUDE.md"), "utf8"), /relo:start/u);
  assert.equal(b.state.computer[0]?.name, "build-box", "the computer shows by the name it joined with");
  assert.equal(JSON.stringify(out).includes(TOKEN), false, "the token is never printed");
});

test("auth join refuses what is not a code, and says so when the server does not know it", async () => {
  const b = await box({ redeem: async () => { throw new ApiError("invalid", { status: 400, code: "INVALID_CODE" }); } });
  const malformed = await cli(["auth", "join", "hello", "--api-url", "https://relo.example"], b.deps);
  assert.equal(malformed.exitCode, EXIT.USAGE);
  assert.equal(b.state.redeemed.length, 0);
  const used = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(used.exitCode, EXIT.CLOSED);
  assert.match(used.line.error.message, /expired or was already used/u);
  assert.equal(b.state.written.length, 0);
});

test("auth invite prints the one-time command for another computer, at the depth asked", async () => {
  const b = await box();
  const out = await cli(["auth", "invite", "--level", "optimize", "--approvals", "on"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.deepEqual(b.state.invites, [{ level: "optimize", approvals: true }]);
  assert.equal(out.line.command, `curl -fsSL https://relo.example/install.sh | sh -s -- ${CODE}`);
});

test("auth join on a computer with no agent yet signs in and says to run setup once one is installed", async () => {
  const b = await box({ agents: [] });
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.written[0].token, TOKEN);
  assert.equal(out.line.signedIn, true);
  assert.match(out.line.message ?? JSON.stringify(out), /relo setup --level guide --approvals on/u);
});

test("auth join sets up exactly the agents the code names, and invite --agent names them", async () => {
  const b = await box({ agents: [".claude", ".codex"], pick: ["codex"] });
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.deepEqual([...new Set(out.line.changed.filter((row) => row.harness).map((row) => row.harness))], ["codex"]);
  assert.equal(existsSync(join(b.home, ".claude", "CLAUDE.md")), false, "Claude Code was not picked");
  const invite = await cli(["auth", "invite", "--agent", "claude", "--agent", "opencode"], b.deps);
  assert.deepEqual(b.state.invites.at(-1), { agents: ["claude-code", "opencode"] });
  assert.equal(invite.exitCode, EXIT.OK);
  assert.equal((await cli(["auth", "invite", "--agent", "notepad"], b.deps)).exitCode, EXIT.USAGE);
});


// A server that answers the self-check, and optionally has a phone to seal the connected notice to.
function healthy(b, { phone = false, ready = true } = {}) {
  const sent = [];
  const client = b.deps.clientFactory();
  const deviceId = "dev_00000000-0000-4000-8000-00000000000a";
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  const devices = phone ? [{ deviceId, kind: "phone", name: "iPhone", identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } }] : [];
  Object.assign(client, {
    ready: async () => (ready ? { status: "ready", ready: true } : Promise.reject(Object.assign(new Error("down"), { code: "NETWORK_ERROR" }))),
    authStatus: async () => ({ authenticated: true, credential: { id: "key_0123456789ab", clientName: "build-box", prefix: "relo_tttt", scopes: ["devices:read"] } }),
    doctor: async () => ({ version: 1, ok: true, checks: {} }),
    publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }), listDevices: async () => ({ devices }),
    endToEndPolicy: async () => ({ required: false }),
    sendNotification: async (body, key) => { sent.push({ body, key }); return { eventId: "ntf_1" }; },
  });
  return { sent, client };
}

test("auth join never asks, even at a terminal, and names the login it replaced", async () => {
  const b = await box();
  const folder = await mkdtemp(join(tmpdir(), "relo-join-keys-"));
  Object.assign(b.deps, { env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") }, stdinIsTTY: true, stdoutIsTTY: true,
    ask: async () => { throw new Error("asked"); }, confirm: async () => { throw new Error("asked"); },
    loadConfig: async () => ({ apiUrl: "https://old.example", token: "x".repeat(44), principal: { id: "key_old", name: "old-laptop" } }) });
  healthy(b);
  const stdout = [];
  const exitCode = await run(["auth", "join", CODE, "--api-url", "https://relo.example"], { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: true }, b.deps);
  assert.equal(exitCode, EXIT.OK, stdout.join("\n"));
  const text = stdout.join("\n");
  assert.match(text, /^Switched from old-laptop on https:\/\/old\.example\.$/mu);
  assert.match(text, /^Computer: build-box$/mu);
  assert.match(text, /^Server: relo\.example$/mu);
  assert.match(text, /^Level: guide/mu);
  assert.match(text, /^Agents set up: Claude Code/mu);
  assert.match(text, /^Self-check: passed$/mu);
  assert.match(text, /Install the Relo iPhone app to get notifications\./u);
});

test("auth join reports each failing self-check on its own line and records it for the report", async () => {
  const b = await box();
  const recorded = [];
  const reports = [];
  b.deps.recordDoctor = async (checks) => { recorded.push(checks); };
  b.deps.sendMachineReport = async (options) => { reports.push(options); return { sent: true, reason: "changed" }; };
  healthy(b, { ready: false });
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(out.line.join.selfCheck.ok, false);
  assert.deepEqual(out.line.join.selfCheck.failing.map((row) => row.name), ["server"]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].server.ok, false);
  assert.deepEqual(reports.at(-1), { force: true }, "the join's report ignores the change and day throttle");
  assert.equal(out.line.join.reported, true);
});

test("auth join sends one sealed 'Relo is connected' notice with a key from the login, when a trusted phone exists", async () => {
  const b = await box();
  const folder = await mkdtemp(join(tmpdir(), "relo-join-keys-"));
  b.deps.env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") };
  const { sent } = healthy(b, { phone: true });
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(out.line.join.notice, "sent");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.sealed, "the notice is sealed for the phone");
  assert.equal(JSON.stringify(sent[0].body).includes("build-box"), false, "the computer's name is not readable by the server");
  assert.equal(sent[0].key, "relo-join:key_0123456789ab");
});

test("auth join says one line for an expired code, a busy server, an unreachable host and a gate", async () => {
  const failing = async (error, message, code) => {
    const b = await box({ redeem: async () => { throw error; } });
    const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
    assert.notEqual(out.exitCode, EXIT.OK);
    assert.match(out.line.error.message, message);
    if (code) assert.equal(out.line.error.code, code);
    assert.equal(b.state.written.length, 0);
  };
  await failing(new ApiError("invalid", { status: 400, code: "INVALID_CODE" }), /^This code expired or was already used\. Make a new one in Connect a computer\.$/u, "INVALID_CODE");
  await failing(new ApiError("slow down", { status: 429, code: "RATE_LIMITED" }), /Wait a minute/u, "JOIN_RATE_LIMITED");
  await failing(new NetworkError("fetch failed", { reason: "ENOTFOUND" }), /^Cannot reach relo\.example: the name does not resolve/u, "SERVER_UNREACHABLE");
  await failing(new NetworkError("fetch failed", { reason: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), /Cannot reach relo\.example: its TLS certificate was not accepted/u);
  await failing(new ApiError("HTTP 403", { status: 403, code: "API_ERROR" }), /relo\.example.*Cloudflare Access/u, "ACCESS_BLOCKED");
});

const BIND = "AAECAwQFBgcICQoLDA0ODw";

async function filesUnder(directory) {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...await filesUnder(path)); else names.push(path);
  }
  return names;
}

test("auth join with a bind half redeems only the rci_ part, binds the published key to this login and stores no bind half", async () => {
  const b = await box();
  const folder = await mkdtemp(join(tmpdir(), "relo-join-keys-"));
  b.deps.env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") };
  const published = [];
  healthy(b).client.publishClientKey = async (body) => { published.push(body); return {}; };
  const out = await cli(["auth", "join", `${CODE}.${BIND}`, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.redeemed[0].code, CODE);
  assert.equal(published.length >= 1, true);
  const first = published[0];
  const expected = createHmac("sha256", Buffer.from(BIND, "base64url"))
    .update(`relo.e2e.v1 computer-binding\nkey_0123456789ab\n${first.identityKey}`).digest("base64url");
  assert.equal(first.binding, expected);
  assert.equal(first.binding.length, 43);
  for (const file of [...await filesUnder(folder), ...await filesUnder(b.home), ...await filesUnder(b.deps.cwd)]) {
    assert.equal((await readFile(file, "utf8").catch(() => "")).includes(BIND), false, `${file} holds the bind half`);
  }
  assert.equal(JSON.stringify(out).includes(BIND), false);
  assert.equal(JSON.stringify(b.state.written).includes(BIND), false);
});

test("auth join without a bind half publishes the key with no binding, and a malformed bind half is refused", async () => {
  const b = await box();
  const folder = await mkdtemp(join(tmpdir(), "relo-join-keys-"));
  b.deps.env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") };
  const published = [];
  healthy(b).client.publishClientKey = async (body) => { published.push(body); return {}; };
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(published.length >= 1, true);
  assert.equal("binding" in published[0], false);
  const bad = await cli(["auth", "join", `${CODE}.short`, "--api-url", "https://relo.example"], b.deps);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.equal(b.state.redeemed.length, 1);
});

test("auth join --mac-app asks for the Mac app's sign-in code and opens the app with it and the verifier only it gets", async () => {
  const signInCode = `relo_signin_${"s".repeat(43)}`;
  const b = await box({ redeem: async (body) => ({ accessToken: TOKEN, setup: { level: "track", approvals: false, desktopApp: true },
    credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes },
    ...(body.desktopAppChallenge ? { macAppSignInCode: signInCode } : {}) }) });
  const opened = [];
  const deps = { ...b.deps, platform: "darwin", openMacApp: async (path, args) => { opened.push({ path, args }); } };
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app", "/Users/x/Applications/Relo Notch.app"], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  const challenge = b.state.redeemed[0].desktopAppChallenge;
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, "/Users/x/Applications/Relo Notch.app");
  const args = opened[0].args;
  const verifier = args[args.indexOf("--relo-code-verifier") + 1];
  assert.equal(args[args.indexOf("--relo-sign-in-code") + 1], signInCode);
  assert.equal(args[args.indexOf("--relo-origin") + 1], "https://relo.example");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "the verifier matches the challenge sent");
  assert.equal(out.line.join.macApp, "signed-in");
  assert.equal(JSON.stringify(out).includes(verifier) || JSON.stringify(out).includes(signInCode), false, "neither is printed");
});

test("auth join --windows-app asks for the desktop app's sign-in code and launches the exe with it and the verifier only it gets", async () => {
  const signInCode = `relo_signin_${"w".repeat(43)}`;
  const b = await box({ redeem: async (body) => ({ accessToken: TOKEN, setup: { level: "track", approvals: false, desktopApp: true },
    credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes },
    ...(body.desktopAppChallenge ? { desktopAppSignInCode: signInCode } : {}) }) });
  const opened = [];
  const deps = { ...b.deps, platform: "win32", openWindowsApp: async (path, args) => { opened.push({ path, args }); },
    openMacApp: async () => { throw new Error("not on Windows"); } };
  const exe = "C:\\Users\\x\\AppData\\Local\\Programs\\Relo\\Relo.exe";
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--windows-app", exe], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  const challenge = b.state.redeemed[0].desktopAppChallenge;
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, exe);
  const args = opened[0].args;
  const verifier = args[args.indexOf("--relo-code-verifier") + 1];
  assert.equal(args[args.indexOf("--relo-sign-in-code") + 1], signInCode);
  assert.equal(args[args.indexOf("--relo-origin") + 1], "https://relo.example");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "the verifier matches the challenge sent");
  assert.equal(out.line.join.windowsApp, "signed-in");
  assert.equal(out.line.join.macApp, undefined);
  assert.equal(JSON.stringify(out).includes(verifier) || JSON.stringify(out).includes(signInCode), false, "neither is printed");
  // The old server's name for the sign-in code still works, and a server without a code opens the app unsigned.
  const old = await box({ redeem: async (body) => ({ accessToken: TOKEN, setup: { level: "track", approvals: false },
    credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes }, macAppSignInCode: signInCode }) });
  const oldOpened = [];
  const oldOut = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--windows-app", exe],
    { ...old.deps, platform: "win32", openWindowsApp: async (path, a) => { oldOpened.push(a); } });
  assert.equal(oldOut.line.join.windowsApp, "signed-in");
  const none = await box();
  const noneOpened = [];
  const noneOut = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--windows-app", exe],
    { ...none.deps, platform: "win32", openWindowsApp: async (path, a) => { noneOpened.push(a); } });
  assert.equal(noneOut.line.join.windowsApp, "opened");
  assert.deepEqual(noneOpened[0], ["--relo-origin", "https://relo.example"]);
});

test("auth join --windows-app off Windows sends no challenge and launches nothing", async () => {
  const b = await box();
  const opened = [];
  const deps = { ...b.deps, platform: "linux", openWindowsApp: async (path, args) => { opened.push({ path, args }); } };
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--windows-app", "/tmp/Relo.exe"], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.redeemed[0].desktopAppChallenge, undefined);
  assert.equal(opened.length, 0);
});

test("openWindowsApp launches the exe detached with its arguments, and only on Windows", () => {
  const calls = [];
  const spawnImpl = (file, args, options) => { calls.push({ file, args, options }); return { on() {}, unref() {} }; };
  assert.throws(() => openWindowsApp("C:/x/Relo.exe", ["--a"], { platform: "darwin", spawnImpl }));
  assert.equal(calls.length, 0);
  openWindowsApp("C:/x/Relo.exe", ["--relo-origin", "https://relo.example"], { platform: "win32", spawnImpl });
  assert.equal(calls[0].file, "C:/x/Relo.exe");
  assert.deepEqual(calls[0].args, ["--relo-origin", "https://relo.example"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
});

test("auth join --mac-app-challenge sends Relo for Mac's own challenge and returns the sign-in code without opening anything", async () => {
  const signInCode = `relo_signin_${"c".repeat(43)}`;
  const challenge = "C".repeat(43);
  const b = await box({ redeem: async (body) => ({ accessToken: TOKEN, setup: { level: "track", approvals: false, desktopApp: true },
    credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes },
    ...(body.desktopAppChallenge ? { macAppSignInCode: signInCode } : {}) }) });
  const opened = [];
  const deps = { ...b.deps, platform: "darwin", openMacApp: async (path, args) => { opened.push({ path, args }); } };
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app-challenge", challenge], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.redeemed[0].desktopAppChallenge, challenge);
  assert.equal(opened.length, 0);
  assert.equal(out.line.join.macAppSignInCode, signInCode);
  const both = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app-challenge", challenge, "--mac-app", "/x.app"], deps);
  assert.equal(both.exitCode, EXIT.USAGE);
  const short = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app-challenge", "short"], deps);
  assert.equal(short.exitCode, EXIT.USAGE);
});

test("auth join --mac-app off a Mac sends no challenge and opens nothing", async () => {
  const b = await box();
  const opened = [];
  const deps = { ...b.deps, platform: "linux", openMacApp: async (path, args) => { opened.push({ path, args }); } };
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app", "/tmp/Relo Notch.app"], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.redeemed[0].desktopAppChallenge, undefined);
  assert.equal(opened.length, 0);
});

test("auth invite --with-mac-app asks for Relo for Mac on the new computer", async () => {
  const b = await box();
  const out = await cli(["auth", "invite", "--with-mac-app"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.deepEqual(b.state.invites, [{ desktopApp: true }]);
});

test("auth join says the notch shows the cards and the iPhone is optional when the Mac app came with it", async () => {
  const run1 = async (extra, platform) => {
    const b = await box();
    const folder = await mkdtemp(join(tmpdir(), "relo-join-keys-"));
    Object.assign(b.deps, { env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") }, stdinIsTTY: true, stdoutIsTTY: true, platform,
      openMacApp: async () => {} });
    healthy(b);
    const stdout = [];
    const exitCode = await run(["auth", "join", CODE, "--api-url", "https://relo.example", ...extra], { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: true }, b.deps);
    assert.equal(exitCode, EXIT.OK, stdout.join("\n"));
    return stdout.join("\n");
  };
  const withMac = await run1(["--mac-app", "/Users/x/Applications/Relo Notch.app"], "darwin");
  assert.match(withMac, /notch on this Mac shows your cards and questions\. The iPhone app is optional\./u);
  assert.doesNotMatch(withMac, /Install the Relo iPhone app/u);
  assert.match(await run1([], "darwin"), /Install the Relo iPhone app to get notifications\./u);
});

test("auth join --no-setup signs in and returns the Mac sign-in code but sets up no agent", async () => {
  const signInCode = `relo_signin_${"d".repeat(43)}`;
  const b = await box({ redeem: async (body) => ({ accessToken: TOKEN, setup: { level: "guide", approvals: true },
    credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes },
    ...(body.desktopAppChallenge ? { macAppSignInCode: signInCode } : {}) }) });
  const out = await cli(["auth", "join", CODE, "--api-url", "https://relo.example", "--mac-app-challenge", "C".repeat(43), "--no-setup"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.state.written[0].token, TOKEN, "signed in");
  assert.equal(out.line.join.macAppSignInCode, signInCode);
  assert.equal(out.line.join.agents.skipped, true);
  assert.match(out.line.note ?? out.line.message ?? "", /not set up/u);
  assert.equal(existsSync(join(b.home, ".claude", "skills", "relo-notifications", "SKILL.md")), false, "no skill was installed");
  assert.equal(existsSync(join(b.home, ".claude", "CLAUDE.md")), false, "no block was written");
});
