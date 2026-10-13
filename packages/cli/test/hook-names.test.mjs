import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { b64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { ensureIdentity, loadKeyStore } from "../src/keystore.mjs";
import { ensureTrust } from "../src/trust.mjs";
import { cardDependencies } from "./fake-cards.mjs";

// Agent sessions carry no card, so the hook seals the names behind its handles for the phone (E2.5).
const apiUrl = "https://relo.example";
const deviceId = "dev_00000000-0000-4000-8000-00000000000a";

test("a sealing computer's hook sends handles plus the names sealed for the phone, once per session", async () => {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-names-"));
  const repo = join(state, "relo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const env = { RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_SEALED_CARD_DIR: join(state, "s", "cards") };
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  const phone = { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
  const sent = [];
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: [phone] }),
    sendAgentSessionEvent: async (body) => { sent.push(body); return { ok: true, state: "active" }; } };
  const deps = () => ({
    ...cardDependencies(client, { env }),
    env,
    loadConfig: async () => ({ apiUrl, token: "x".repeat(44) }),
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => ({ session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001", hook_event_name: "SessionStart", cwd: repo }),
    stdinIsTTY: false,
    computerName: () => "Studio Mac",
    home: state, cwd: repo, now: () => Date.now(),
  });
  await ensureIdentity(env.RELO_KEY_STORE_PATH);
  await ensureTrust({ client, config: { apiUrl }, dependencies: deps() });
  const io = { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false };

  await run(["hook", "start"], io, deps());
  await run(["hook", "prompt"], io, deps());
  assert.equal(sent.length, 2);
  const [first, second] = sent;
  assert.match(first.project, /^p-[a-z2-7]{16}$/u);
  assert.match(first.computer, /^c-[a-z2-7]{16}$/u);
  assert.ok(!JSON.stringify(first).includes("Studio Mac") && !JSON.stringify(first).includes('"relo"'));
  assert.equal(first.sealedNames.kind, "names");
  assert.equal(second.sealedNames, undefined, "the names travel once per session");

  const store = await loadKeyStore(env.RELO_KEY_STORE_PATH);
  const opened = (openEnvelope(first.sealedNames, { deviceId, prekeyPrivateKey: () => prekey.privateKey,
    trustedSenders: { [store.identity.keyId]: Buffer.from(store.identity.publicKey, "base64url") }, expectedKind: "names" }));
  assert.equal(opened.content.names[first.project], "relo");
  assert.equal(opened.content.names[first.computer], "Studio Mac");
});
