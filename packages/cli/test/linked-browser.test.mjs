import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64u, generateKeyPair, keyId, linkSigningInput, openEnvelope, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { loadKeyStore, trustKey } from "../src/keystore.mjs";
import { sealNoticeRequest } from "../src/seal-notice.mjs";
import { ensureTrust } from "../src/trust.mjs";

// A browser reads sealed content only when a phone this computer trusts signed its identity key.
const apiUrl = "https://relo.example";

function endpoint(deviceId, kind) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  return { identity, prekeyPair: prekey, device: { deviceId, kind, name: kind === "browser" ? "Chrome on macOS" : "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

const phone = endpoint("dev_00000000-0000-4000-8000-00000000000a", "phone");
const other = endpoint("dev_00000000-0000-4000-8000-0000000000bb", "phone");
const browser = endpoint("brw_00000000-0000-4000-8000-0000000000cc", "browser");

function link(signer = phone, { identityKey = browser.device.identityKey.publicKey, phoneDeviceId = signer.device.deviceId } = {}) {
  const signedAt = new Date().toISOString();
  return { deviceId: phoneDeviceId, signedAt, signature: b64u(signBytes(signer.identity.privateKey,
    linkSigningInput({ browserId: browser.device.deviceId, identityKey, phoneDeviceId, signedAt }))) };
}

function harness() {
  const folder = mkdtempSync(join(tmpdir(), "relo-browser-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "state", "cards") };
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => Date.now() };
  const client = (devices) => ({ publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }) });
  return { dependencies, client, env, cleanup: () => rmSync(folder, { recursive: true, force: true }),
    send: async (devices) => (await sealNoticeRequest({ body: { title: "SECRET", body: "SECRET BODY", sourceName: "Codex" }, key: "k1",
      client: client(devices), config: { apiUrl }, dependencies, notes: [] })).sealed };
}

test("a browser linked by the trusted phone gets the content envelope (no push alert) and can open it", async () => {
  const h = harness();
  try {
    await ensureTrust({ client: h.client([phone.device]), config: { apiUrl }, dependencies: h.dependencies });
    const sealed = await h.send([phone.device, { ...browser.device, link: link() }]);
    assert.deepEqual(sealed.alerts.map((alert) => alert.recipients[0].device), [phone.device.deviceId]);
    assert.deepEqual(sealed.content.recipients.map((r) => r.device).sort(), [phone.device.deviceId, browser.device.deviceId].sort());
    const store = await loadKeyStore(h.env.RELO_KEY_STORE_PATH);
    const opened = openEnvelope(sealed.content, { deviceId: browser.device.deviceId, prekeyPrivateKey: () => browser.prekeyPair.privateKey,
      trustedSenders: { [store.identity.keyId]: Buffer.from(store.identity.publicKey, "base64url") } });
    assert.equal(opened.content.title, "SECRET");
    assert.equal(store.trusted[trustKey(apiUrl, browser.device.deviceId)].notice.kind, "browser_linked");
  } finally { h.cleanup(); }
});

test("no link, a forged link, a link by an unknown phone or over another key: the browser gets nothing", async () => {
  const h = harness();
  try {
    await ensureTrust({ client: h.client([phone.device]), config: { apiUrl }, dependencies: h.dependencies });
    const forged = { ...link(), signature: b64u(Buffer.alloc(64, 7)) };
    const cases = [null, forged, link(other), link(phone, { identityKey: b64u(generateKeyPair().publicKey) }),
      link(phone, { phoneDeviceId: other.device.deviceId })];
    for (const candidate of cases) {
      const sealed = await h.send([phone.device, other.device, { ...browser.device, link: candidate }]);
      assert.ok(sealed.content.recipients.every((r) => r.device !== browser.device.deviceId));
    }
    // Linked, then unlinked by the phone (the server stops listing the link): trust is withdrawn.
    await h.send([phone.device, { ...browser.device, link: link() }]);
    await h.send([phone.device, { ...browser.device, link: null }]);
    assert.equal((await loadKeyStore(h.env.RELO_KEY_STORE_PATH)).trusted[trustKey(apiUrl, browser.device.deviceId)], undefined);
  } finally { h.cleanup(); }
});
