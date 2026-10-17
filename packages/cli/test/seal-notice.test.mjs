import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64u, fromB64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/crypto/keystore.mjs";
import { fitAlert, sealablePhones, sealNotice, sealNoticeRequest, sealQuestion } from "../src/crypto/seal-notice.mjs";

const apiUrl = "https://relo.example";

function phone(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = "2026-10-13T16:00:00.000Z";
  const signature = signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }));
  return {
    identity, prekey,
    resource: {
      deviceId, name: deviceId,
      identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
      prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, signature: b64u(signature), stale: false },
    },
  };
}

const pinned = (device) => ({ [trustKey(apiUrl, device.resource.deviceId)]: { publicKey: device.resource.identityKey.publicKey } });

test("only verified phones whose prekey the pinned identity signed are sealable", () => {
  const verified = phone("dev_00000000-0000-4000-8000-00000000000a");
  const unverified = phone("dev_00000000-0000-4000-8000-00000000000b");
  const swapped = phone("dev_00000000-0000-4000-8000-00000000000c");
  const forged = phone("dev_00000000-0000-4000-8000-00000000000d");
  const store = { trusted: { ...pinned(verified), ...pinned(swapped), ...pinned(forged) } };
  swapped.resource.identityKey.publicKey = b64u(generateKeyPair().publicKey);
  forged.resource.prekey.publicKey = b64u(generateKeyPair().publicKey);
  const { eligible, skipped } = sealablePhones(store, apiUrl, [verified, unverified, swapped, forged].map((d) => d.resource));
  assert.deepEqual(eligible.map((p) => p.deviceId), [verified.resource.deviceId]);
  assert.equal(skipped.length, 3);
  assert.deepEqual(sealablePhones(store, "https://other.example", [verified.resource]).eligible, []);
  assert.deepEqual(sealablePhones(store, apiUrl, [verified.resource], ["dev_other"]).eligible, []);
});

test("each phone opens its own alert and the shared body; retries seal identically", () => {
  const a = phone("dev_00000000-0000-4000-8000-00000000000a");
  const b = phone("dev_00000000-0000-4000-8000-00000000000b");
  const sender = generateKeyPair();
  const phones = [b, a].map((d) => ({ deviceId: d.resource.deviceId, prekeyId: "pk_1", publicKey: d.prekey.publicKey }));
  const content = { title: "Deployed", summary: "All green", body: "## Secret details", bodyFormat: "markdown" };
  const args = { sender, idempotencyKey: "idem-1", phones, content, sentAt: "2026-10-13T17:00:00.000Z" };
  const sealed = sealNotice(args);
  const trusted = { [keyId(sender.publicKey)]: sender.publicKey };
  assert.deepEqual(sealed.alerts.map((alert) => alert.recipients[0].device), [a.resource.deviceId, b.resource.deviceId]);
  for (const [index, device] of [a, b].entries()) {
    const options = { deviceId: device.resource.deviceId, prekeyPrivateKey: () => device.prekey.privateKey, trustedSenders: trusted };
    assert.deepEqual(openEnvelope(sealed.alerts[index], options).content, { title: "Deployed", summary: "All green", sentAt: args.sentAt });
    assert.deepEqual(openEnvelope(sealed.content, options).content, { ...content, sentAt: args.sentAt });
    assert.throws(() => openEnvelope(sealed.alerts[1 - index], options), /not_a_recipient/);
  }
  const retry = sealNotice(args);
  const unsigned = ({ sig, ...rest }) => rest;
  assert.deepEqual(retry.alerts.map(unsigned), sealed.alerts.map(unsigned));
  assert.deepEqual(unsigned(retry.content), unsigned(sealed.content));
  const other = sealNotice({ ...args, idempotencyKey: "idem-2" });
  assert.notEqual(other.content.ct, sealed.content.ct);
  assert.notEqual(other.content.nonce, sealed.content.nonce);
  assert.notEqual(sealNotice({ ...args, content: { ...content, body: "changed" } }).content.nonce, sealed.content.nonce);
  assert.notEqual(sealNotice({ ...args, sender: generateKeyPair() }).content.ct, sealed.content.ct);
  const json = JSON.stringify(sealed);
  for (const secret of ["Deployed", "All green", "Secret details"]) assert.ok(!json.includes(secret));
});

test("alerts shrink to fit a push", () => {
  const alert = fitAlert({ title: "T".repeat(80), summary: "😀".repeat(240) });
  assert.ok(Buffer.byteLength(JSON.stringify(alert)) <= 760);
  assert.ok(alert.summary.endsWith("…"));
  assert.deepEqual(fitAlert({ title: "Short" }), { title: "Short" });
});

test("relo notify seals for the account's phones automatically, and stays readable only for older servers", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-seal-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const device = phone("dev_00000000-0000-4000-8000-00000000000a");
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => Date.parse("2026-10-13T17:00:00.000Z") };
  const client = { listDeviceKeys: async () => ({ devices: [device.resource] }), publishClientKey: async () => ({}) };
  const body = { title: "Deployed", body: "Secret", sourceName: "Codex", context: { project: "relo" },
    relevance: { occurredAt: "2026-10-13T16:59:00.000Z" }, imageUrl: "https://example.com/x.png" };
  try {
    const notes = [];
    const oldServer = { listDeviceKeys: async () => { throw Object.assign(new Error("not found"), { status: 404 }); },
      publishClientKey: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } };
    assert.equal(await sealNoticeRequest({ body, key: "k1", client: oldServer, config: { apiUrl }, dependencies, notes }), body);
    assert.deepEqual(notes, [], "an older server is not an error");
    // Trust on first use: the phone's key is pinned automatically and the notice is sealed.
    const sealed = await sealNoticeRequest({ body, key: "k1", client, config: { apiUrl }, dependencies, notes });
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    assert.equal(store.trusted[trustKey(apiUrl, device.resource.deviceId)].level, "auto");
    assert.deepEqual(Object.keys(sealed).sort(), ["context", "relevance", "sealed", "sourceName"]);
    assert.ok(!JSON.stringify(sealed).includes("Secret"));
    const opened = openEnvelope(sealed.sealed.content, { deviceId: device.resource.deviceId, prekeyPrivateKey: () => device.prekey.privateKey,
      trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) } });
    // The project travels as a handle; its name only inside the envelope (E2.5).
    assert.match(sealed.context.project, /^p-[a-z2-7]{16}$/);
    assert.ok(!JSON.stringify(sealed).includes('"relo"'));
    assert.deepEqual(opened.content, { title: "Deployed", body: "Secret", imageUrl: "https://example.com/x.png",
      sentAt: "2026-10-13T16:59:00.000Z", names: { [sealed.context.project]: "relo" } });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("questions are sealed for the account's phones automatically, with the prompt readable only on the phone", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-seal-question-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const device = phone("dev_00000000-0000-4000-8000-00000000000a");
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => 0 };
  const client = { listDeviceKeys: async () => ({ devices: [device.resource] }), publishClientKey: async () => ({}) };
  const args = { title: "Release", prompt: "Deploy 0.11.0 to production?", key: "k-q", client, config: { apiUrl }, dependencies, notes: [] };
  try {
    assert.equal(await sealQuestion({ ...args, client: { listDeviceKeys: async () => ({ devices: [] }), publishClientKey: async () => ({}) } }), null,
      "no phone with keys: the question goes out as before");
    const { sealed } = await sealQuestion(args);
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    assert.equal(sealed.content.kind, "question");
    assert.ok(!JSON.stringify(sealed).includes("Deploy 0.11.0"));
    const options = { deviceId: device.resource.deviceId, prekeyPrivateKey: () => device.prekey.privateKey,
      trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) }, expectedKind: "question" };
    assert.deepEqual(openEnvelope(sealed.content, options).content, { title: "Release", summary: args.prompt, body: args.prompt });
    assert.deepEqual(openEnvelope(sealed.alerts[0], options).content, { title: "Release", summary: args.prompt });
    const { sealed: retry } = await sealQuestion(args);
    assert.equal(retry.content.ct, sealed.content.ct, "an exact retry seals identically");
    // The question's detail is the sealed body, never sent beside it.
    const { sealed: detailed } = await sealQuestion({ ...args, key: "k-q2", detail: "Rewrites the orders table" });
    assert.ok(!JSON.stringify(detailed).includes("orders table"));
    assert.deepEqual(openEnvelope(detailed.content, options).content,
      { title: "Release", summary: args.prompt, body: "Rewrites the orders table", bodyFormat: "markdown" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
