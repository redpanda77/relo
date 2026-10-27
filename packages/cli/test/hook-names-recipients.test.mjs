import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { b64u, generateKeyPair, keyId, linkSigningInput, openEnvelope, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, loadKeyStore } from "../src/crypto/keystore.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";
import { RECIPIENT_RECHECK_MS } from "../src/harness/core/observed.mjs";
import { cardDependencies } from "./fake-cards.mjs";

// A browser linked after a session began must still read the session's names (the Sessions list):
// the names are sealed again once, the next time the computer looks at its recipients.
const apiUrl = "https://relo.example";
const phoneId = "dev_00000000-0000-4000-8000-00000000000a";
const browserId = "brw_00000000-0000-4000-8000-0000000000cc";

function endpoint(deviceId, kind) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  return { identity, prekey, device: { deviceId, kind, name: kind === "browser" ? "Chrome on macOS" : "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

test("a browser linked mid-session gets the session's names sealed again, once", async () => {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-names-recipients-"));
  const repo = join(state, "relo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_STATE_DIR: join(state, "s"),
    RELO_HARNESS_CREDENTIAL_PATH: join(state, "harness-credential") };
  const phone = endpoint(phoneId, "phone");
  const browser = endpoint(browserId, "browser");
  const signedAt = new Date().toISOString();
  const link = { deviceId: phoneId, signedAt, signature: b64u(signBytes(phone.identity.privateKey,
    linkSigningInput({ browserId, identityKey: browser.device.identityKey.publicKey, phoneDeviceId: phoneId, signedAt }))) };
  let devices = [phone.device];
  let clock = Date.now();
  const sent = [];
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }),
    createHarnessCredential: async () => ({ id: "hcr_1", token: "h".repeat(44) }),
    request: async (method, route, options = {}) => { if (route === "/api/agent-sessions/observed") sent.push(options.body); return { ok: true }; } };
  const deps = () => ({
    ...cardDependencies(client, { env }), env,
    loadConfig: async () => ({ apiUrl, token: "x".repeat(44) }),
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => ({ session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c002", hook_event_name: native, cwd: repo }),
    stdinIsTTY: false, computerName: () => "Studio Mac", home: state, cwd: repo, now: () => clock, spawnFlusher: () => {},
  });
  let native = "SessionStart";
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  await ensureTrust({ client, config: { apiUrl }, dependencies: deps() });
  const io = { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false };
  const flush = async (event, hook) => { native = event; await run(["hook", hook], io, deps()); await run(["outbox", "flush"], io, deps()); };

  await flush("SessionStart", "start");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sealedNames.recipients.length, 1, "phone only so far");

  devices = [phone.device, { ...browser.device, link }];
  clock += 60_000;
  await flush("UserPromptSubmit", "prompt");
  assert.equal(sent[1].sealedNames, undefined, "recipients are not checked again within the interval");

  clock += RECIPIENT_RECHECK_MS;
  await flush("Stop", "stop");
  assert.equal(sent[2].sealedNames.recipients.length, 2, "the linked browser is a recipient now");

  const store = await loadKeyStore(env.RELO_KEY_STORE_PATH);
  const opened = openEnvelope(sent[2].sealedNames, { deviceId: browserId, prekeyPrivateKey: () => browser.prekey.privateKey,
    trustedSenders: { [store.identity.keyId]: Buffer.from(store.identity.publicKey, "base64url") }, expectedKind: "names" });
  assert.equal(opened.content.names[sent[2].project], "relo");

  clock += RECIPIENT_RECHECK_MS;
  await flush("UserPromptSubmit", "prompt");
  assert.equal(sent[3].sealedNames, undefined, "unchanged recipients seal nothing again");
});

// An account with Relo for Mac and no phone: the hooks send handles, so the names must reach the Mac, which reads
// them as a reader (names carry no alert); before, nothing was sealed and the notch showed the bare handles.
test("with only Relo for Mac, the session's names are sealed for the Mac", async () => {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-names-mac-"));
  const repo = join(state, "relo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_STATE_DIR: join(state, "s"),
    RELO_HARNESS_CREDENTIAL_PATH: join(state, "harness-credential") };
  const macId = "dev_00000000-0000-4000-8000-0000000000dd";
  const mac = endpoint(macId, "phone");
  const devices = [{ ...mac.device, name: "Relo for Mac", ownerOverview: true }];
  const sent = [];
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }),
    createHarnessCredential: async () => ({ id: "hcr_1", token: "h".repeat(44) }),
    endToEndPolicy: async () => ({ required: false }),
    request: async (method, route, options = {}) => { if (route === "/api/agent-sessions/observed") sent.push(options.body); return { ok: true }; } };
  const deps = () => ({
    ...cardDependencies(client, { env }), env,
    loadConfig: async () => ({ apiUrl, token: "x".repeat(44) }),
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => ({ session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c003", hook_event_name: "SessionStart", cwd: repo }),
    stdinIsTTY: false, computerName: () => "Studio Mac", home: state, cwd: repo, now: () => Date.now(), spawnFlusher: () => {},
  });
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  await ensureTrust({ client, config: { apiUrl }, dependencies: deps() });
  const io = { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false };
  await run(["hook", "start"], io, deps());
  await run(["outbox", "flush"], io, deps());

  assert.equal(sent.length, 1);
  assert.match(sent[0].project, /^p-[a-z2-7]{16}$/u, "the project went as a handle");
  assert.ok(sent[0].sealedNames, "and its name went sealed");
  const store = await loadKeyStore(env.RELO_KEY_STORE_PATH);
  const opened = openEnvelope(sent[0].sealedNames, { deviceId: macId, prekeyPrivateKey: () => mac.prekey.privateKey,
    trustedSenders: { [store.identity.keyId]: Buffer.from(store.identity.publicKey, "base64url") }, expectedKind: "names" });
  assert.equal(opened.content.names[sent[0].project], "relo");
  assert.equal(opened.content.names[sent[0].computer], "Studio Mac");
});
