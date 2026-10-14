import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { answerSigningInput, b64u, fromB64u, generateKeyPair, hpkeOpen, hpkeSeal, keyId, openEnvelope, prekeySigningInput, safetyNumber, sealEnvelope, validateEnvelopeShape, verifyAnswer, verifyBytes, verifyPrekey, linkSigningInput } from "../src/e2ee.mjs";

const fixtureText = readFileSync(new URL("../../contracts/fixtures/e2ee-v1.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText);
const key = (name) => ({
  privateKey: fromB64u(fixture.keys[name].privateKey),
  publicKey: fromB64u(fixture.keys[name].publicKey),
});
const cli = key("cliIdentity");
const device = key("deviceIdentity");
const prekey = key("prekey");
const otherPrekey = key("otherDevicePrekey");
const trusted = { [fixture.keys.cliIdentity.keyId]: cli.publicKey };
const trustedDevice = { [fixture.keys.deviceIdentity.keyId]: device.publicKey };
const prekeys = (id) => ({ pk_1: prekey.privateKey, pk_9: otherPrekey.privateKey })[id] ?? null;

test("the iOS copy of the interop vectors is byte-identical", () => {
  assert.equal(readFileSync(new URL("../../../apps/ios/Tests/ReloCoreTests/Fixtures/e2ee-v1.json", import.meta.url), "utf8"), fixtureText);
});

test("fixture keys, key ids and the safety number are stable", () => {
  for (const name of Object.keys(fixture.keys)) {
    assert.equal(keyId(fromB64u(fixture.keys[name].publicKey)), fixture.keys[name].keyId);
  }
  assert.equal(safetyNumber(cli.publicKey, device.publicKey), fixture.safetyNumber);
  assert.equal(safetyNumber(device.publicKey, cli.publicKey), fixture.safetyNumber);
  assert.match(fixture.safetyNumber, /^(\d{5} ){11}\d{5}$/);
  assert.notEqual(safetyNumber(cli.publicKey, generateKeyPair().publicKey), fixture.safetyNumber);
});

test("HPKE: node:crypto reproduces its vector and opens CryptoKit's", () => {
  const vector = fixture.hpke;
  const args = { info: fromB64u(vector.info), aad: fromB64u(vector.aad) };
  assert.deepEqual(hpkeOpen({ recipientPrivateKey: prekey.privateKey, enc: fromB64u(vector.enc), ciphertext: fromB64u(vector.ciphertext), ...args }), fromB64u(vector.plaintext));
  const ck = fixture.cryptokit.hpke;
  assert.deepEqual(hpkeOpen({ recipientPrivateKey: prekey.privateKey, enc: fromB64u(ck.enc), ciphertext: fromB64u(ck.ciphertext), ...args }), fromB64u(vector.plaintext));
  const fresh = hpkeSeal({ recipientPublicKey: prekey.publicKey, plaintext: Buffer.from("x"), ...args });
  assert.notEqual(b64u(fresh.enc), vector.enc, "a fresh seal uses a fresh ephemeral key");
});

test("opens the node-sealed envelope for each recipient device", () => {
  for (const deviceId of ["dev_phone", "dev_ipad"]) {
    const opened = openEnvelope(fixture.node.envelope, {
      deviceId, prekeyPrivateKey: prekeys, trustedSenders: trusted, expectedKind: "notice", expectedContext: fixture.node.context,
    });
    assert.deepEqual(opened.content, fixture.node.content);
    assert.equal(opened.sender, fixture.keys.cliIdentity.keyId);
  }
});

test("opens the CryptoKit-sealed reply and verifies its signed answer", () => {
  const opened = openEnvelope(fixture.cryptokit.envelope, {
    deviceId: "dev_phone", prekeyPrivateKey: prekeys, trustedSenders: trustedDevice, expectedContext: fixture.cryptokit.context,
  });
  assert.deepEqual(opened.content, fixture.node.content);
  assert.equal(verifyAnswer({ identityPublicKey: device.publicKey, answer: fixture.cryptokit.answer }), true);
  assert.equal(verifyAnswer({ identityPublicKey: device.publicKey, answer: { ...fixture.cryptokit.answer, value: "approved" } }), false);
  assert.equal(verifyAnswer({ identityPublicKey: cli.publicKey, answer: fixture.cryptokit.answer }), false);
});

test("signed prekeys and answers verify only against the device identity", () => {
  assert.equal(verifyPrekey({ identityPublicKey: device.publicKey, prekey: fixture.node.prekey }), true);
  assert.equal(verifyPrekey({ identityPublicKey: cli.publicKey, prekey: fixture.node.prekey }), false);
  assert.equal(verifyPrekey({ identityPublicKey: device.publicKey, prekey: { ...fixture.node.prekey, deviceId: "dev_evil" } }), false);
  assert.equal(verifyAnswer({ identityPublicKey: device.publicKey, answer: fixture.node.answer }), true);
  const { signature, ...answer } = fixture.node.answer;
  assert.equal(verifyBytes(device.publicKey, answerSigningInput({ ...answer, value: "denied" }), fromB64u(signature)), false);
  assert.ok(prekeySigningInput({ ...fixture.node.prekey, publicKey: prekey.publicKey }).includes(Buffer.from("relo.e2e.v1 prekey")));
});

test("refuses untrusted senders, other devices, rotated prekeys and every tampering", () => {
  const env = fixture.node.envelope;
  const code = (envelope, options = {}) => {
    try {
      openEnvelope(envelope, { deviceId: "dev_phone", prekeyPrivateKey: prekeys, trustedSenders: trusted, ...options });
    } catch (error) {
      return error.code;
    }
    return "opened";
  };
  assert.equal(code(env, { trustedSenders: {} }), "untrusted_sender");
  assert.equal(code(env, { trustedSenders: { [fixture.keys.cliIdentity.keyId]: device.publicKey } }), "untrusted_sender");
  assert.equal(code(env, { deviceId: "dev_unknown" }), "not_a_recipient");
  assert.equal(code(env, { prekeyPrivateKey: () => null }), "prekey_unavailable");
  assert.equal(code(env, { prekeyPrivateKey: () => generateKeyPair().privateKey }), "decryption_failed");
  assert.equal(code(env, { expectedKind: "card" }), "unexpected_kind");
  assert.equal(code(env, { expectedContext: "acct:acc_other/idem:vector-1" }), "unexpected_context");
  for (const rejection of fixture.rejections) assert.equal(code(rejection.envelope), rejection.error, rejection.name);
  // A server that re-signs with its own key is still an untrusted sender.
  const server = generateKeyPair();
  const forged = sealEnvelope({ kind: "notice", context: env.context, sender: server, recipients: [{ deviceId: "dev_phone", prekeyId: "pk_1", publicKey: prekey.publicKey }], content: { title: "Approve the transfer" } });
  assert.equal(code(forged), "untrusted_sender");
});

test("shape validation is strict and padding hides length within 256-byte buckets", () => {
  assert.doesNotThrow(() => validateEnvelopeShape(fixture.node.envelope));
  for (const broken of [
    { ...fixture.node.envelope, v: "relo.e2e.v0" },
    { ...fixture.node.envelope, context: "has space" },
    { ...fixture.node.envelope, nonce: "AAAA" },
    { ...fixture.node.envelope, recipients: [] },
    { ...fixture.node.envelope, sig: `${fixture.node.envelope.sig}=` },
  ]) assert.throws(() => validateEnvelopeShape(broken));
  const sizes = ["a", "a".repeat(200)].map((text) => fromB64u(sealEnvelope({
    kind: "notice", context: "acct:a/idem:b", sender: cli, recipients: [{ deviceId: "d", prekeyId: "p", publicKey: prekey.publicKey }], content: { text },
  }).ct).length);
  assert.deepEqual(sizes, [272, 272]);
  assert.throws(() => sealEnvelope({
    kind: "notice", context: "acct:a/idem:b", sender: cli, recipients: [{ deviceId: "d", prekeyId: "p", publicKey: prekey.publicKey }], content: { text: "x".repeat(70_000) },
  }), /plaintext_too_large/);
});

test("the browser-link vector: this CLI builds the same bytes the iPhone signs and verifies its signature", () => {
  const { link, keys } = JSON.parse(fixtureText);
  const input = linkSigningInput(link);
  assert.equal(b64u(input), link.input);
  assert.equal(verifyBytes(fromB64u(keys.deviceIdentity.publicKey, { length: 65 }), input, fromB64u(link.signature, { length: 64 })), true);
});
