import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { b64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, loadKeyStore } from "../src/crypto/keystore.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";
import { cardDependencies } from "./fake-cards.mjs";

// Agent sessions carry no card, so the hook seals the names behind its handles for the phone (E2.5).
const apiUrl = "https://relo.example";
const deviceId = "dev_00000000-0000-4000-8000-00000000000a";

test("a sealing computer's hook sends handles plus the names sealed for the phone, once per session", async () => {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-names-"));
  const repo = join(state, "relo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_STATE_DIR: join(state, "s"),
    RELO_HARNESS_CREDENTIAL_PATH: join(state, "harness-credential") };
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  const phone = { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
  const sent = [];
  let native = "SessionStart";
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: [phone] }),
    createHarnessCredential: async () => ({ id: "hcr_1", token: "h".repeat(44) }),
    request: async (method, route, options = {}) => { if (route === "/api/agent-sessions/observed") sent.push(options.body); return { ok: true }; } };
  const deps = () => ({
    ...cardDependencies(client, { env }),
    env,
    loadConfig: async () => ({ apiUrl, token: "x".repeat(44) }),
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => ({ session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001", hook_event_name: native, cwd: repo }),
    stdinIsTTY: false,
    computerName: () => "Studio Mac",
    home: state, cwd: repo, now: () => Date.now(), spawnFlusher: () => {},
  });
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  await ensureTrust({ client, config: { apiUrl }, dependencies: deps() });
  const io = { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false };
  // Claude Code keeps the session's title beside its transcript.
  const titleDirectory = join(state, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/gu, "-"), "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001");
  await mkdir(titleDirectory, { recursive: true });
  const title = (name) => writeFile(join(titleDirectory, "custom-title.json"), JSON.stringify({ customTitle: name }));
  await title("Ship the release notes");

  // The hook only queues; the flusher seals the names at send time.
  await run(["hook", "start"], io, deps());
  await run(["outbox", "flush"], io, deps());
  // Renamed in Claude Code: the next snapshot seals the names again.
  await title("Release notes for 0.17");
  native = "UserPromptSubmit";
  await run(["hook", "prompt"], io, deps());
  await run(["outbox", "flush"], io, deps());
  native = "Stop";
  await run(["hook", "stop"], io, deps());
  await run(["outbox", "flush"], io, deps());
  assert.equal(sent.length, 3);
  const [first, second, third] = sent;
  assert.match(first.project, /^p-[a-z2-7]{16}$/u);
  assert.match(first.computer, /^c-[a-z2-7]{16}$/u);
  for (const body of sent) {
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes("Studio Mac") && !wire.includes('"relo"') && !wire.includes("release notes")
      && !wire.includes("Release notes"), "names and the session title never travel readable");
  }
  assert.equal(first.sealedNames.kind, "names");
  assert.equal(second.sealedNames.kind, "names", "a renamed session seals its names again");
  assert.equal(third.sealedNames, undefined, "unchanged names travel once");

  const store = await loadKeyStore(env.RELO_KEY_STORE_PATH);
  const open = (envelope) => openEnvelope(envelope, { deviceId, prekeyPrivateKey: () => prekey.privateKey,
    trustedSenders: { [store.identity.keyId]: Buffer.from(store.identity.publicKey, "base64url") }, expectedKind: "names" });
  const opened = open(first.sealedNames);
  assert.equal(opened.content.names[first.project], "relo");
  assert.equal(opened.content.names[first.computer], "Studio Mac");
  assert.equal(opened.content.title, "Ship the release notes");
  assert.equal(open(second.sealedNames).content.title, "Release notes for 0.17");
});
