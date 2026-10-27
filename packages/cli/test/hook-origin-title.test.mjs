import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity } from "../src/crypto/keystore.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";
import { prepareObserved } from "../src/harness/core/observed.mjs";
import { cardDependencies } from "./fake-cards.mjs";

const HANDLE = "p-aaaaaaaaaaaaaaaa";
const entry = (title) => ({ body: { session: "sess-1", project: HANDLE, phase: "working" }, meta: { names: { [HANDLE]: "relo" }, ...(title === undefined ? {} : { title }) } });

async function setUp({ devices = [], required = false } = {}) {
  const state = await mkdtemp(join(tmpdir(), "relo-origin-title-"));
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_STATE_DIR: join(state, "s") };
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }), endToEndPolicy: async () => ({ required }) };
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  const dependencies = { ...cardDependencies(client, { env }), env, configPath: () => join(state, "config.json"), home: state, hookStateDirectory: join(state, "hooks"), now: () => Date.now() };
  const prepare = async (apiUrl, e, local) => {
    const config = { apiUrl, token: "x".repeat(44), ...(local ? { local: true } : {}) };
    await ensureTrust({ client, config, dependencies });
    const result = await prepareObserved(e, { client, config, dependencies });
    await result.after();
    return result.body;
  };
  return { prepare, devices, state };
}

function phone() {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  const deviceId = "dev_00000000-0000-4000-8000-00000000000a";
  return { deviceId, kind: "phone", name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

test("a plain marker for the local server never makes snapshots to another origin readable", async () => {
  const { prepare } = await setUp({ required: true });
  const local = await prepare("http://127.0.0.1:8786", entry(), true);
  assert.equal(local.project, "relo");
  // The same session, now to an encrypted remote server with nobody to seal for: stays handles, nothing readable.
  const remote = await prepare("https://relo.example", entry(), false);
  assert.equal(remote.project, HANDLE);
});

test("readable labels carry the session title; sealed ones never do", async () => {
  const plain = await (await setUp()).prepare("http://127.0.0.1:8786", entry("  Fix the\n  login   bug " + "x".repeat(100)), true);
  assert.equal(plain.project, "relo");
  assert.equal(plain.title.length <= 80, true);
  assert.match(plain.title, /^Fix the login bug x+$/u);
  // The marker path (same digest, rechecked later) is readable with the title too.
  const again = await setUp();
  const first = await again.prepare("http://127.0.0.1:8786", entry("Named"), true);
  const second = await again.prepare("http://127.0.0.1:8786", entry("Named"), true);
  assert.equal(first.title, "Named");
  assert.equal(second.title, "Named");
  const sealed = await (await setUp({ devices: [phone()] })).prepare("https://relo.example", entry("Secret name"), false);
  assert.equal(sealed.title, undefined);
  assert.ok(sealed.sealedNames);
  assert.equal(sealed.project, HANDLE);
});
