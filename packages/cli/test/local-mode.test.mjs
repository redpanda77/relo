import "./hermetic-env.mjs";
import { LOCAL_NOT_LINKED, LOCAL_RELINK } from "../src/shared/errors.mjs";
// Local mode (docs/internal/product/plan/16-local-mode.md): an account on the server Relo for Mac hosts is marked
// local and never sealed; managed updates; relo setup --path.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { sealNoticeRequest, sealQuestion } from "../src/crypto/seal-notice.mjs";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { setUpdateMode, updateMode } from "../src/owner/auto-update.mjs";
import { isLoopbackApiUrl } from "../src/shared/config.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { cardDependencies, fakeCards, fakeHome } from "./fake-cards.mjs";

const CODE = `rci_${"a".repeat(32)}`;
const TOKEN = `relo_${"t".repeat(43)}`;
const LOCAL_URL = "http://127.0.0.1:8187";

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, stdout, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

function phoneKeys(deviceId, createdAt = new Date().toISOString()) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  return { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

/** A key store folder and a client that records every key route it is asked for. */
function sealing() {
  const folder = mkdtempSync(join(tmpdir(), "relo-local-"));
  const calls = [];
  const client = {
    listDeviceKeys: async () => { calls.push("listDeviceKeys"); return { devices: [phoneKeys("dev_00000000-0000-4000-8000-00000000000a")] }; },
    listDevices: async () => { calls.push("listDevices"); return { hasMore: false, cursor: null, devices: [] }; },
    publishClientKey: async () => { calls.push("publishClientKey"); return {}; },
  };
  const dependencies = { env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") },
    configPath: () => "/cfg/c.json", now: () => Date.now(), home: folder };
  return { folder, calls, client, dependencies, done: () => rmSync(folder, { recursive: true, force: true }) };
}

const BODY = { title: "Deployed", summary: "All green", body: "details" };

test("isLoopbackApiUrl: 127.0.0.0/8, localhost and ::1 only", () => {
  for (const url of ["http://127.0.0.1:8187", "http://127.5.6.7", "http://localhost:8187", "http://[::1]:8187"]) assert.equal(isLoopbackApiUrl(url), true, url);
  for (const url of ["https://relo.example", "http://192.168.1.4:8187", "http://10.0.0.2", "http://127.0.0.1.evil.example", "not a url"]) assert.equal(isLoopbackApiUrl(url), false, url);
});

test("a local account on a loopback server sends readable notices and questions and touches no keys", async () => {
  const s = sealing();
  try {
    const config = { apiUrl: LOCAL_URL, token: TOKEN, local: true };
    const notes = [];
    const body = await sealNoticeRequest({ body: BODY, key: "k1", client: s.client, config, dependencies: s.dependencies, notes });
    assert.deepEqual(body, BODY, "readable, no sealed field");
    assert.equal(body.sealed, undefined);
    const question = await sealQuestion({ title: "Ship?", prompt: "Ship it?", key: "k2", client: s.client, config, dependencies: s.dependencies, notes });
    assert.equal(question, null, "the question goes out readable");
    assert.deepEqual(s.calls, [], "no key route was asked");
    assert.deepEqual(notes, []);
    assert.equal(existsSync(join(s.folder, "e2ee.json")), false, "no key store was created");
  } finally { s.done(); }
});

test("a loopback account that is not marked local still goes through trust (an SSH tunnel to a remote server seals)", async () => {
  const s = sealing();
  try {
    const config = { apiUrl: LOCAL_URL, token: TOKEN };
    await sealNoticeRequest({ body: BODY, key: "k1", client: s.client, config, dependencies: s.dependencies, notes: [] });
    assert.ok(s.calls.includes("listDeviceKeys"), "the trust step ran");
    // And a local mark on a remote URL does not skip it either.
    const before = s.calls.length;
    await sealNoticeRequest({ body: BODY, key: "k2", client: s.client, config: { apiUrl: "https://relo.example", token: TOKEN, local: true }, dependencies: s.dependencies, notes: [] });
    assert.ok(s.calls.length > before, "local on a non-loopback server is not trusted to skip sealing");
  } finally { s.done(); }
});

async function joinBox() {
  const home = await fakeHome({ agents: [] });
  const written = [];
  const redeemed = [];
  const client = { putComputerSelf: async () => ({}), publishClientKey: async () => ({}), redeemComputerInvite: async (body) => {
    redeemed.push(body);
    return { accessToken: TOKEN, setup: { level: "track" }, credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_tttt", scopes: body.scopes } };
  } };
  const deps = { ...cardDependencies({}), home, cwd: home, env: {}, computerName: () => "build-box", clientFactory: () => client,
    writeConfig: async (_path, value) => { written.push(value); }, stderr: () => {} };
  return { deps, written, redeemed };
}

test("auth join --local marks the account local; without it nothing is marked", async () => {
  const b = await joinBox();
  const out = await cli(["auth", "join", CODE, "--api-url", LOCAL_URL, "--local"], b.deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(b.written[0].local, true);
  assert.equal(b.written[0].apiUrl, LOCAL_URL);
  const plain = await joinBox();
  assert.equal((await cli(["auth", "join", CODE, "--api-url", LOCAL_URL], plain.deps)).exitCode, EXIT.OK);
  assert.equal(plain.written[0].local, undefined);
});

test("auth join --local refuses a server that is not on this computer, before any redeem", async () => {
  const b = await joinBox();
  for (const url of ["https://relo.example", "http://192.168.1.4:8187"]) {
    const out = await cli(["auth", "join", CODE, "--api-url", url, "--local"], b.deps);
    assert.equal(out.exitCode, EXIT.USAGE, url);
  }
  assert.equal(b.redeemed.length, 0);
  assert.equal(b.written.length, 0);
});

test("relo test on a local account sends its card and question to Relo for Mac readable", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-test-local-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const fake = fakeCards({ answer: "yes" });
  fake.client.listDevices = async () => ({ hasMore: false, cursor: null, devices: [] });
  const mac = { ...phoneKeys("dev_00000000-0000-4000-8000-0000000000e1"), name: "Mac", model: "Mac16,1", capabilities: ["owner_overview"] };
  fake.client.listDeviceKeys = async () => ({ devices: [mac] });
  fake.client.publishClientKey = async () => ({});
  const config = { apiUrl: LOCAL_URL, token: "x".repeat(44), local: true, revision: "r1", path: "/cfg/c.json" };
  const deps = { ...cardDependencies(fake.client, { env }), configPath: () => "/cfg/c.json", loadConfig: async () => config,
    loadStoredConfig: async () => config, writeConfig: async () => {} };
  try {
    const lines = [];
    const exitCode = await run(["test"], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) }, deps);
    assert.equal(exitCode, 0, lines.join(" "));
    const start = fake.calls.find((call) => call.op === "start");
    assert.ok(start, "a card was sent");
    assert.equal(start.body.sealed, undefined, "the card is readable");
    assert.ok(start.body.title, "with its title in the clear");
    const ask = fake.calls.find((call) => call.op === "ask");
    assert.ok(ask, "a question was sent");
    assert.equal(ask.body.sealed, undefined, "the question is readable");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Managed counts only for the CLI inside Relo for Mac: these run as that one.
const APP_ENTRYPOINT = "/Applications/Relo.app/Contents/Resources/server/cli/bin/relo.mjs";

test("managed updates: the mode is stored or set by RELO_UPDATES, and relo update installs and checks nothing", async () => {
  const home = await fakeHome({ agents: [] });
  assert.equal(updateMode({ home, env: { RELO_UPDATES: "managed" } }), "managed");
  const out = await cli(["update", "--mode", "managed"], { ...cardDependencies({}), home, env: {}, entrypoint: APP_ENTRYPOINT });
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(updateMode({ home, entrypoint: APP_ENTRYPOINT }), "managed");
  let fetched = 0;
  const deps = { ...cardDependencies({}), home, env: {}, entrypoint: APP_ENTRYPOINT, releaseFetch: async () => { fetched += 1; throw new Error("no network in managed mode"); } };
  for (const argv of [["update"], ["update", "--check"], ["update", "--rollback"]]) {
    const result = await cli(argv, deps);
    assert.equal(result.exitCode, EXIT.OK, argv.join(" "));
    assert.equal(result.line.managed, true);
  }
  assert.equal(fetched, 0);
  // The environment wins over a stored mode, like the others.
  setUpdateMode(home, "managed", APP_ENTRYPOINT);
  assert.equal(updateMode({ home, env: { RELO_UPDATES: "auto" }, entrypoint: APP_ENTRYPOINT }), "auto");
});

test("relo update --mode auto undoes managed: the CLI checks for updates itself again", async () => {
  const home = await fakeHome({ agents: [] });
  let fetched = 0;
  const deps = { ...cardDependencies({}), home, env: {}, entrypoint: APP_ENTRYPOINT, releaseFetch: async () => { fetched += 1; throw new Error("offline"); } };
  assert.equal((await cli(["update", "--mode", "managed"], deps)).exitCode, EXIT.OK);
  assert.equal((await cli(["update", "--check"], deps)).line.managed, true);
  assert.equal(fetched, 0);
  const back = await cli(["update", "--mode", "auto"], deps);
  assert.equal(back.exitCode, EXIT.OK, JSON.stringify(back));
  assert.equal(back.line.mode, "auto");
  assert.equal(back.line.effective, undefined, "nothing overrides it");
  assert.equal(updateMode({ home }), "auto");
  // The app's own CLI always leaves updating to the app; a copy installed elsewhere checks for releases itself again.
  const check = await cli(["update", "--check"], { ...deps, entrypoint: "/usr/local/lib/node_modules/@relo/cli/bin/relo.mjs" });
  assert.equal(check.line.managed, undefined, "no longer the app's job");
  assert.ok(fetched > 0, "it asks for releases itself");
});

test("setup --path puts ~/.local/bin on PATH in every startup file that exists, once", async () => {
  const home = mkdtempSync(join(tmpdir(), "relo-path-"));
  try {
    writeFileSync(join(home, ".profile"), "# mine\n");
    writeFileSync(join(home, ".zshrc"), "export PATH=$HOME/.local/bin:$PATH\n");
    const deps = { ...cardDependencies({}), home, platform: "linux", env: { SHELL: "/bin/zsh" } };
    const first = await cli(["setup", "--path"], deps);
    assert.equal(first.exitCode, EXIT.OK, JSON.stringify(first));
    assert.deepEqual(first.line.path.changed, ["~/.profile"]);
    assert.deepEqual(first.line.path.unchanged, ["~/.zshrc"]);
    assert.match(readFileSync(join(home, ".profile"), "utf8"), /^# mine\n\nexport PATH="\$HOME\/\.local\/bin:\$PATH"\n$/u);
    assert.equal(existsSync(join(home, ".bashrc")), false, "a missing file is not created while others exist");
    const again = await cli(["setup", "--path"], deps);
    assert.deepEqual(again.line.path.changed, []);
    assert.equal(readFileSync(join(home, ".profile"), "utf8").split(".local/bin").length, 2, "idempotent");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("setup --path with no startup file creates the one for $SHELL; --dry-run writes nothing", async () => {
  for (const [shell, file] of [["/bin/zsh", ".zshrc"], ["/usr/bin/bash", ".bashrc"], ["/usr/bin/fish", ".profile"]]) {
    const home = mkdtempSync(join(tmpdir(), "relo-path-"));
    try {
      const deps = { ...cardDependencies({}), home, platform: "linux", env: { SHELL: shell } };
      const dry = await cli(["setup", "--path", "--dry-run"], deps);
      assert.deepEqual(dry.line.path.changed, [`~/${file}`]);
      assert.equal(existsSync(join(home, file)), false);
      await cli(["setup", "--path"], deps);
      assert.equal(readFileSync(join(home, file), "utf8"), 'export PATH="$HOME/.local/bin:$PATH"\n');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

// ── What a local account reads and does: no iPhone, no keys (plan 16) ────────────────────────────────────────────

const MAC_ID = "dev_00000000-0000-4000-8000-0000000000e2";
const LOCAL_CONFIG = { apiUrl: LOCAL_URL, token: "x".repeat(44), local: true, revision: "r1", path: "/cfg/c.json" };

/** A doctor run on a local account whose key listing has `keys` (a Mac without a prekey by default) and device list `devices`. */
async function localDoctor({ keys, devices = [], config = LOCAL_CONFIG, authenticated = true, args = [], human = false } = {}) {
  const client = {
    ready: async () => ({ ready: true }),
    authStatus: async () => ({ authenticated, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z", scopes: ["devices:read", "activities:read"] } }),
    doctor: async () => ({ version: 1, ok: true, content: { encryptionRequired: false, retentionKnown: false } }),
    listDevices: async () => ({ hasMore: false, cursor: null, devices }),
    listDeviceKeys: async () => ({ devices: keys }),
  };
  const home = await fakeHome({ skillVersion: undefined });
  const deps = { ...cardDependencies(client), home, configPath: () => "/cfg/c.json", loadConfig: async () => config,
    loadStoredConfig: async () => config, writeConfig: async () => {}, pendingLogin: { read: async () => null },
    localFacts: async () => ({ health: { release: "1.0.0+1" }, app: null, bundledCli: null }), env: { RELO_UPDATES: "managed" } };
  if (!human) return cli(["doctor", ...args], deps);
  const lines = [];
  const exitCode = await run(["doctor", ...args], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line), stdoutIsTTY: true }, deps);
  return { exitCode, text: lines.join("\n") };
}

test("doctor on a local account: a signed-in Relo for Mac counts with no key, and the privacy line says nothing leaves it", async () => {
  const bare = { deviceId: MAC_ID, name: "Studio Mac", model: "Mac16,1", capabilities: ["owner_overview"] };
  for (const devices of [[], [{ deviceId: MAC_ID }]]) {
    const out = await localDoctor({ keys: [bare], devices });
    assert.equal(out.line.ready, true, JSON.stringify(out.line));
    assert.deepEqual(out.line.receives, { device: "Studio Mac", model: "Mac16,1" });
    assert.equal(out.line.privacy, "Relo runs on this Mac: nothing leaves it; not encrypted.");
  }
  const none = await localDoctor({ keys: [] });
  assert.equal(none.line.ready, false);
  assert.equal(none.line.next.why, LOCAL_NOT_LINKED);
  assert.doesNotMatch(JSON.stringify(none.line.next), /iPhone|auth login/u);
});

test("doctor on a local account never sends the owner to relo auth login", async () => {
  const out = await localDoctor({ keys: [], authenticated: false });
  assert.equal(out.line.next.step, "mac");
  assert.equal(out.line.next.why, LOCAL_RELINK);
  assert.doesNotMatch(JSON.stringify(out.line.next), /relo auth login/u);
});

test("relo test on a local account asks about the notch, with a Mac that has no key, and fails with Mac hints when none is linked", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-test-notch-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const attempt = async (keys) => {
    const fake = fakeCards({ answer: "yes" });
    fake.client.listDevices = async () => ({ hasMore: false, cursor: null, devices: [] });
    fake.client.listDeviceKeys = async () => ({ devices: keys });
    const deps = { ...cardDependencies(fake.client, { env }), configPath: () => "/cfg/c.json", loadConfig: async () => LOCAL_CONFIG,
      loadStoredConfig: async () => LOCAL_CONFIG, writeConfig: async () => {} };
    const lines = [];
    const exitCode = await run(["test"], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) }, deps);
    return { fake, exitCode, text: lines.join("\n") };
  };
  try {
    const ok = await attempt([{ deviceId: MAC_ID, name: "Mac", model: "Mac16,1", capabilities: ["owner_overview"] }]);
    assert.equal(ok.exitCode, 0, ok.text);
    assert.equal(ok.fake.calls.find((call) => call.op === "ask").body.prompt, `Can you see this card in ${process.platform === "darwin" ? "your Mac's notch" : "the Relo notch"}?`);
    const none = await attempt([]);
    assert.notEqual(none.exitCode, 0);
    assert.ok(none.text.includes(LOCAL_NOT_LINKED));
    assert.doesNotMatch(none.text, /iPhone|Live Activities|APNs/u);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("relo keys on a local account makes and publishes nothing, and says why", async () => {
  const s = sealing();
  const deps = { ...cardDependencies(s.client), ...s.dependencies, loadConfig: async () => LOCAL_CONFIG, loadStoredConfig: async () => LOCAL_CONFIG, writeConfig: async () => {} };
  try {
    for (const argv of [["keys", "status"], ["keys", "rotate"], ["keys", "require", "on"]]) {
      const out = await cli(argv, deps);
      assert.equal(out.exitCode, EXIT.OK, argv.join(" "));
      assert.match(out.stdout.join("\n"), /This Mac runs Relo on its own: nothing leaves it, so nothing is encrypted\./u);
    }
    assert.deepEqual(s.calls, [], "no key route was asked or written");
    assert.equal(existsSync(join(s.folder, "e2ee.json")), false);
  } finally { s.done(); }
});

test("a positive answer on a local account is accepted as is, with no signature", async () => {
  const { verifyAnswer } = await import("../src/crypto/answer-verify.mjs");
  const s = sealing();
  try {
    const payload = { interaction: { id: "int_1", state: "approved" } };
    const local = await verifyAnswer(payload, { apiUrl: LOCAL_URL, local: true }, s.dependencies, { interactionId: "int_1" });
    assert.deepEqual(local, payload);
    assert.equal(existsSync(join(s.folder, "e2ee.json")), false, "no key store was touched");
  } finally { s.done(); }
});

test("a local account's refusal and expiry hints send the owner to Relo for Mac, not to relo auth login", async () => {
  const { printFailure } = await import("../src/shared/output.mjs");
  const { AuthError } = await import("../src/shared/errors.mjs");
  const show = (local) => { const out = []; printFailure(new AuthError("expired", { code: "LOGIN_EXPIRED" }), { structured: false }, { stdout: (l) => out.push(l), stderr: (l) => out.push(l) }, "state", { local }); return out.join("\n"); };
  assert.ok(show(true).includes(LOCAL_RELINK));
  assert.doesNotMatch(show(true), /relo auth login/u);
  assert.match(show(false), /relo auth login/u);
});

// A local account has no push target: the card and the question being created is the whole success.
async function localTest(argv, { delivery, answer = "yes", answerAfterPolls = 1 } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "relo-test-local-ok-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const fake = fakeCards({ answer, answerAfterPolls });
  const start = fake.client.startActivity;
  if (delivery) fake.client.startActivity = async (...args) => ({ ...(await start(...args)), delivery });
  fake.client.listDevices = async () => ({ hasMore: false, cursor: null, devices: [] });
  fake.client.listDeviceKeys = async () => ({ devices: [{ deviceId: MAC_ID, name: "Mac", model: "Mac16,1", capabilities: ["owner_overview"] }] });
  const stored = { ...LOCAL_CONFIG };
  let clock = Date.parse("2026-10-23T10:00:00Z");
  const deps = { ...cardDependencies(fake.client, { env }), configPath: () => "/cfg/c.json", loadConfig: async () => stored,
    loadStoredConfig: async () => stored, writeConfig: async (_path, next) => { Object.assign(stored, next); }, now: () => (clock += 1000) };
  try {
    const stdout = [];
    const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
    return { exitCode, stdout: stdout.join("\n"), line: stdout[0] ? JSON.parse(stdout[0]) : undefined, fake, stored };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test("relo test on a local account succeeds with no durable commands: the card and question existing is the success", async () => {
  const out = await localTest(["test"], { delivery: { eligibleDevices: 0, durableCommands: 0, apnsJobs: 0 } });
  assert.equal(out.exitCode, 0, out.stdout);
  assert.ok(out.fake.calls.find((call) => call.op === "ask"), "the question was created");
  assert.equal(out.stored.phoneTest.verifiedAt !== undefined, true);
});

test("relo test --timeout 2s on a local account returns exit 0 waiting for the answer in the notch, then a later run resumes", async () => {
  const first = await localTest(["test", "--timeout", "2s"], { answer: "yes", answerAfterPolls: 99 });
  assert.equal(first.exitCode, 0, first.stdout);
  assert.equal(first.line.state, "pending");
  assert.match(first.line.waiting, /notch/u);
  assert.equal(first.line.error, undefined);
  assert.equal(first.line.verified, false);
  assert.match(first.stored.pendingTest.interactionId, /^int_/u, "the question is remembered for the next run");
  assert.doesNotMatch(first.stdout, /iPhone|Live Activities|Lock Screen/u);
});

// ── The real server shapes on a local account: no keys published, the Mac only in the device inventory ──────────

const INVENTORY_MAC = { deviceId: MAC_ID, name: "Studio Mac", model: "Mac16,1", liveActivityAuthorization: "denied", ownerOverview: true };

test("doctor on a local account: the Mac is seen through the device inventory when the key listing is empty", async () => {
  const out = await localDoctor({ keys: [], devices: [INVENTORY_MAC] });
  assert.equal(out.line.ready, true, JSON.stringify(out.line));
  assert.deepEqual(out.line.receives, { device: "Studio Mac", model: "Mac16,1" });
  // A device the inventory does not mark as the Mac never counts.
  const phone = await localDoctor({ keys: [], devices: [{ ...INVENTORY_MAC, ownerOverview: undefined }] });
  assert.equal(phone.line.ready, false);
});

test("relo test on a local account sends the card and question to a Mac that only the device inventory lists", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-test-inventory-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const fake = fakeCards({ answer: "yes" });
  fake.client.listDevices = async () => ({ hasMore: false, cursor: null, devices: [INVENTORY_MAC] });
  fake.client.listDeviceKeys = async () => ({ devices: [] });
  const deps = { ...cardDependencies(fake.client, { env }), configPath: () => "/cfg/c.json", loadConfig: async () => LOCAL_CONFIG,
    loadStoredConfig: async () => LOCAL_CONFIG, writeConfig: async () => {} };
  try {
    const lines = [];
    const exitCode = await run(["test"], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) }, deps);
    assert.equal(exitCode, 0, lines.join(" "));
    assert.ok(fake.calls.find((call) => call.op === "start"), "a card was sent");
    assert.equal(fake.calls.find((call) => call.op === "ask").body.prompt, `Can you see this card in ${process.platform === "darwin" ? "your Mac's notch" : "the Relo notch"}?`);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("doctor --full says ready only when data.ready is true", async () => {
  const ready = await localDoctor({ keys: [], devices: [INVENTORY_MAC], args: ["--full"], human: true });
  assert.match(ready.text, /Relo is ready\./u);
  const notReady = await localDoctor({ keys: [], devices: [], args: ["--full"], human: true });
  assert.doesNotMatch(notReady.text, /Relo is ready\./u);
  assert.ok(notReady.text.includes(LOCAL_NOT_LINKED));
  const json = (await localDoctor({ keys: [], devices: [], args: ["--full"] })).line;
  assert.equal((json.data ?? json).ready, false);
});

test("auth join --no-setup does not say it is setting up agents; a join that sets up does", async () => {
  const say = async (extra) => {
    const b = await joinBox();
    const lines = [];
    await run(["auth", "join", CODE, "--api-url", LOCAL_URL, "--local", ...extra], { stdout: () => {}, stderr: (line) => lines.push(line), stdoutIsTTY: false }, { ...b.deps, stderr: (line) => lines.push(line) });
    return lines.join("\n");
  };
  const skipped = await say(["--no-setup"]);
  assert.match(skipped, /Linked to/u);
  assert.doesNotMatch(skipped, /Setting up/u);
  assert.match(await say([]), /Setting up this computer's agents/u);
});
