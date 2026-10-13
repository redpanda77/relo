import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { cardKey } from "../src/identity.mjs";
import { ensureIdentity, loadKeyStore, trustKey } from "../src/keystore.mjs";
import { sealNoticeRequest, sealQuestion } from "../src/seal-notice.mjs";
import { sealCardRequest } from "../src/seal-card.mjs";
import { ensureTrust } from "../src/trust.mjs";

// Regression tests for the independent security review (docs/END-TO-END-ENCRYPTION.md, E6.4).
const apiUrl = "https://relo.example";

function phone(deviceId, createdAt = new Date().toISOString()) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  return { deviceId, name: deviceId,
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

function context() {
  const folder = mkdtempSync(join(tmpdir(), "relo-review-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "state", "cards") };
  return { folder, env, dependencies: { configPath: () => join(folder, "config.json"), env, now: () => Date.now() },
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

const owner = phone("dev_00000000-0000-4000-8000-00000000000a");
const ghost = phone("dev_00000000-0000-4000-8000-0000000000ee");
const client = (devices) => ({ publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }) });
const body = { title: "SECRET TITLE", body: "SECRET BODY", sourceName: "Codex", context: { project: "relo" } };

test("H2: the first phone is trusted automatically; a phone the server adds later waits for a person", async () => {
  const c = context();
  try {
    const { store } = await ensureTrust({ client: client([owner]), config: { apiUrl }, dependencies: c.dependencies });
    assert.equal(store.trusted[trustKey(apiUrl, owner.deviceId)].level, "auto");
    const notes = [];
    const sealed = await sealNoticeRequest({ body, key: "k1", client: client([owner, ghost]), config: { apiUrl }, dependencies: c.dependencies, notes });
    const after = await loadKeyStore(c.env.RELO_KEY_STORE_PATH);
    assert.equal(after.trusted[trustKey(apiUrl, ghost.deviceId)].level, "pending");
    assert.deepEqual(sealed.sealed.alerts.map((alert) => alert.recipients[0].device), [owner.deviceId], "nothing is sealed to the ghost");
    assert.ok(sealed.sealed.content.recipients.every((recipient) => recipient.device !== ghost.deviceId));
    assert.ok(notes.some((note) => note.includes("new phone")), "every command says a phone is waiting");
  } finally { c.cleanup(); }
});

test("H3: once a phone is trusted, a server that hides keys gets an error, never readable text", async () => {
  const c = context();
  try {
    await ensureTrust({ client: client([owner]), config: { apiUrl }, dependencies: c.dependencies });
    const notFound = { publishClientKey: async () => ({}), listDeviceKeys: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } };
    const hidden = [notFound, client([]), client(null), client([{ ...owner, prekey: null }]),
      client([{ ...owner, prekey: { ...owner.prekey, signature: b64u(Buffer.alloc(64, 1)) } }])];
    for (const server of hidden) {
      await assert.rejects(sealNoticeRequest({ body, key: "k", client: server, config: { apiUrl }, dependencies: c.dependencies, notes: [] }),
        (error) => error.code === "E2EE_UNAVAILABLE");
      await assert.rejects(sealQuestion({ title: "T", prompt: "SECRET?", key: "q", client: server, config: { apiUrl }, dependencies: c.dependencies, notes: [] }),
        (error) => error.code === "E2EE_UNAVAILABLE");
      await assert.rejects(sealCardRequest({ body: { title: "SECRET", status: "x" }, cardId: null, key: "c", client: server, config: { apiUrl },
        dependencies: c.dependencies, notes: [] }), (error) => error.code === "E2EE_UNAVAILABLE");
    }
    // A prekey older than 30 days is not used either.
    const old = phone(owner.deviceId, "2026-01-01T00:00:00.000Z");
    old.identityKey = owner.identityKey;
    await assert.rejects(sealNoticeRequest({ body, key: "k", client: client([{ ...owner, prekey: { ...owner.prekey, createdAt: "2025-01-01T00:00:00.000Z" } }]),
      config: { apiUrl }, dependencies: c.dependencies, notes: [] }), (error) => error.code === "E2EE_UNAVAILABLE");
  } finally { c.cleanup(); }
});

test("M3: card keys are keyed once this computer has an encryption identity", async () => {
  const c = context();
  try {
    const plain = cardKey({ context: { providerName: "Codex", project: "relo", threadName: "Release" }, env: c.env });
    await ensureIdentity(c.env.RELO_KEY_STORE_PATH);
    const keyed = cardKey({ context: { providerName: "Codex", project: "relo", threadName: "Release" }, env: c.env });
    assert.match(keyed, /^work-[0-9a-f]{24}$/);
    assert.notEqual(keyed, plain, "not the plain hash of the names");
    assert.equal(cardKey({ context: { providerName: "Codex", project: "relo", threadName: "Release" }, env: c.env }), keyed, "stable");
    assert.match(cardKey({ name: "deploy", env: c.env }), /^name-[0-9a-f]{24}$/, "--name is keyed too");
  } finally { c.cleanup(); }
});
