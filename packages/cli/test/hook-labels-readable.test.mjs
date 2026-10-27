import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { b64u, generateKeyPair, keyId } from "../src/crypto/e2ee.mjs";
import { ensureIdentity } from "../src/crypto/keystore.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";
import { cardDependencies } from "./fake-cards.mjs";

// An account nobody decrypts for gets readable session labels, as its cards are: a handle there is never named, so
// the notch showed "p-…" and "A computer" (Relo for Mac's local server, a remote server with no reader).
const HANDLE = /^[pca]-[a-z2-7]{16}$/u;

async function setUp({ apiUrl, local, devices, required = false }) {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-labels-"));
  const repo = join(state, "relo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_STATE_DIR: join(state, "s"),
    RELO_HARNESS_CREDENTIAL_PATH: join(state, "harness-credential") };
  const sent = [];
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }),
    createHarnessCredential: async () => ({ id: "hcr_1", token: "h".repeat(44) }),
    endToEndPolicy: async () => ({ required }),
    request: async (method, route, options = {}) => { if (route === "/api/agent-sessions/observed") sent.push(options.body); return { ok: true }; } };
  const deps = () => ({
    ...cardDependencies(client, { env }), env,
    loadConfig: async () => ({ apiUrl, token: "x".repeat(44), ...(local ? { local: true } : {}) }),
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => ({ session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c010", hook_event_name: "SessionStart", cwd: repo }),
    stdinIsTTY: false, computerName: () => "Studio Mac", home: state, cwd: repo, now: () => Date.now(), spawnFlusher: () => {},
  });
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  await ensureTrust({ client, config: { apiUrl }, dependencies: deps() }).catch(() => {});
  const io = { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false };
  await run(["hook", "start"], io, deps());
  await run(["outbox", "flush"], io, deps());
  return sent;
}

function macReader(deviceId) {
  const identity = generateKeyPair();
  const createdAt = new Date().toISOString();
  // Pinned (the trust store pins what it sees) but with no prekey: it cannot be sealed for.
  return { deviceId, name: "Relo for Mac", ownerOverview: true,
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt } };
}

test("Relo for Mac's local server gets readable labels, never handles", async () => {
  const sent = await setUp({ apiUrl: "http://127.0.0.1:8786", local: true, devices: [macReader("dev_00000000-0000-4000-8000-0000000000e1")] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].project, "relo");
  assert.equal(sent[0].computer, "Studio Mac");
  assert.equal(sent[0].sealedNames, undefined);
});

test("a server with nobody to seal for, not requiring encryption, gets readable labels", async () => {
  const sent = await setUp({ apiUrl: "https://relo.example", local: false, devices: [macReader("dev_00000000-0000-4000-8000-0000000000e2")] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].project, "relo");
  assert.doesNotMatch(sent[0].computer, HANDLE);
});

test("a server that requires encryption keeps handles when nobody can read the names", async () => {
  const sent = await setUp({ apiUrl: "https://relo.example", local: false, required: true,
    devices: [macReader("dev_00000000-0000-4000-8000-0000000000e3")] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].project, HANDLE);
});
