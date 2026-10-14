import "./hermetic-env.mjs";
// 2.12: `relo listen` carries the phone's answer signature and refuses an answer it cannot verify.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { answerSigningInput, b64u, generateKeyPair, keyId, signBytes } from "../src/e2ee.mjs";
import { trustKey } from "../src/keystore.mjs";

const API = "https://relo.example";
const PHONE = "dev_2a2a2a2a-0000-4000-8000-000000000000";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "relo-listen-sig-"));
  const me = generateKeyPair();
  const phone = generateKeyPair();
  const store = { version: 1, identity: { privateKey: b64u(me.privateKey), publicKey: b64u(me.publicKey) },
    trusted: { [trustKey(API, PHONE)]: { publicKey: b64u(phone.publicKey), level: "verified", kind: "phone" } } };
  const keys = join(dir, "e2ee.json");
  await writeFile(keys, JSON.stringify(store), { mode: 0o600 });
  return { dir, phone, env: { RELO_KEY_STORE_PATH: keys } };
}

function signedAnswer(phone, id, extra = {}) {
  const signedAt = "2026-10-14T10:52:03.000Z";
  const fields = { interactionId: id, notificationId: `ntf_${id}`, deviceId: PHONE, value: "yes", respondedAt: signedAt };
  return { id, eventId: `ntf_${id}`, type: "yes_no", state: "yes", action: "yes", respondedAt: signedAt,
    respondingDevice: { id: PHONE, name: "iPhone" }, cursor: `cursor-after-${id}-0000`,
    response: { e2eeKeyId: keyId(phone.publicKey), e2eeSignedAt: signedAt,
      e2eeSignature: b64u(signBytes(phone.privateKey, answerSigningInput(fields))) }, ...extra };
}

async function listen(answers, { dir, env }) {
  const lines = [];
  const client = { apiUrl: API, async listAnswers() { return { answers, cursor: "cursor-end-000000000" }; } };
  const out = await execute(["listen", "--once"], {
    env: { ...env, HOME: dir }, configPath: () => join(dir, "config.json"),
    loadConfig: async () => ({ apiUrl: API, token: "x".repeat(44) }),
    clientFactory: () => client, identityDefaults: () => ({}),
    emit: (line) => lines.push(line), now: () => Date.parse("2026-10-14T10:53:00.000Z"), sleep: async () => {},
  });
  return { out, lines };
}

test("a signed answer from a trusted phone is printed with its signature and marked verified", async () => {
  const ctx = await setup();
  const id = "int_5d5d5d5d-0000-4000-8000-000000000001";
  const { lines } = await listen([signedAnswer(ctx.phone, id)], ctx);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, "yes");
  assert.equal(lines[0].verified, true);
  assert.equal(lines[0].signed, true);
  assert.deepEqual(lines[0].device, { id: PHONE, keyId: keyId(ctx.phone.publicKey) });
  assert.equal(typeof lines[0].signature.sig, "string");
});

test("a forged or unsigned positive answer is refused and carries no decision", async () => {
  const ctx = await setup();
  const forged = signedAnswer(generateKeyPair(), "int_5d5d5d5d-0000-4000-8000-000000000002");
  const unsigned = { ...signedAnswer(ctx.phone, "int_5d5d5d5d-0000-4000-8000-000000000003"), response: {} };
  const { lines, out } = await listen([forged, unsigned], ctx);
  assert.deepEqual(lines.map((line) => line.state), ["unverified", "unverified"]);
  for (const line of lines) assert.equal(line.action, undefined);
  assert.match(lines[0].reason, /key|signature/u);
  assert.equal(lines[1].reason, "the answer is not signed");
  assert.equal(JSON.stringify(out).includes("\"refused\":2") || out?.data?.refused === 2 || out?.refused === 2, true);
});
