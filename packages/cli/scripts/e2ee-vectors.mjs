#!/usr/bin/env node
// Regenerates the relo.e2e.v1 interop vectors shared by the CLI and the iPhone app.
//
//   node packages/cli/scripts/e2ee-vectors.mjs [cryptokit-output.json]
//
// Node-sealed entries are rebuilt from the fixed test keys; entries that CryptoKit sealed
// (emitted by `RELO_E2EE_EMIT=<path> swift test --filter E2EEInteropTests`) are merged in from the
// optional argument or kept from the current fixture. Both copies are written byte-identically.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  answerSigningInput, b64u, fromB64u, hpkeSeal, keyId, prekeySigningInput, publicKeyFor,
  safetyNumber, sealEnvelope, signBytes,
} from "../src/crypto/e2ee.mjs";

const root = new URL("../../../", import.meta.url);
const targets = [
  new URL("packages/contracts/fixtures/e2ee-v1.json", root),
  new URL("apps/ios/Tests/ReloCoreTests/Fixtures/e2ee-v1.json", root),
];

// Test-only keys: deterministic scalars, never used outside these vectors.
const scalar = (label) => createHash("sha256").update(`relo.e2e.v1 test key ${label}`).digest();
const pair = (label) => {
  const privateKey = scalar(label);
  return { privateKey, publicKey: publicKeyFor(privateKey) };
};
const keys = {
  cliIdentity: pair("cli-identity"),
  deviceIdentity: pair("device-identity"),
  prekey: pair("device-prekey-1"),
  otherDevicePrekey: pair("other-device-prekey-1"),
};
const encodedKeys = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, {
  privateKey: b64u(key.privateKey), publicKey: b64u(key.publicKey), keyId: keyId(key.publicKey),
}]));

let existing = {};
try {
  existing = JSON.parse(readFileSync(targets[0], "utf8"));
} catch {}
const emitted = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : existing.cryptokit ?? null;

const hpkeInfo = Buffer.from("relo.e2e.v1 test hpke");
const hpkeAad = Buffer.from("relo.e2e.v1 test aad");
const hpkePlaintext = Buffer.from("The server cannot read this.");
const hpke = hpkeSeal({
  recipientPublicKey: keys.prekey.publicKey, info: hpkeInfo, aad: hpkeAad, plaintext: hpkePlaintext,
  ephemeralPrivateKey: scalar("hpke-ephemeral"),
});

const content = {
  title: "Deploy finished",
  summary: "All 848 tests passed",
  body: "## Result\nEvery check passed. Ünïcödé and emoji ✅ survive sealing.",
  project: "relo",
  topic: "end-to-end encryption",
};
const context = "acct:acc_test/idem:vector-1";
const recipients = [
  { deviceId: "dev_phone", prekeyId: "pk_1", publicKey: keys.prekey.publicKey },
  { deviceId: "dev_ipad", prekeyId: "pk_9", publicKey: keys.otherDevicePrekey.publicKey },
];
const envelope = sealEnvelope({
  kind: "notice", context, sender: keys.cliIdentity, recipients, content,
  contentKey: scalar("content-key"), nonce: scalar("body-nonce").subarray(0, 12),
  ephemeralKeys: [scalar("wrap-ephemeral-1"), scalar("wrap-ephemeral-2")],
});

const prekey = { deviceId: "dev_phone", prekeyId: "pk_1", publicKey: keys.prekey.publicKey, createdAt: "2026-10-13T16:00:00.000Z" };
const answer = {
  interactionId: "int_1", notificationId: "ntf_1", deviceId: "dev_phone", value: "approved",
  respondedAt: "2026-10-13T16:01:00.000Z",
};

const tampered = (field, value) => ({ ...structuredClone(envelope), [field]: value });
const fixture = {
  version: "relo.e2e.v1",
  note: "Interop vectors. Every key here is a public test key; never reuse one.",
  keys: encodedKeys,
  hpke: {
    suite: "DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; base mode",
    info: b64u(hpkeInfo), aad: b64u(hpkeAad), plaintext: b64u(hpkePlaintext),
    enc: b64u(hpke.enc), ciphertext: b64u(hpke.ciphertext),
  },
  node: {
    envelope, content, context,
    prekey: { ...prekey, publicKey: b64u(prekey.publicKey), signature: b64u(signBytes(keys.deviceIdentity.privateKey, prekeySigningInput(prekey))) },
    answer: { ...answer, signature: b64u(signBytes(keys.deviceIdentity.privateKey, answerSigningInput(answer))) },
  },
  safetyNumber: safetyNumber(keys.cliIdentity.publicKey, keys.deviceIdentity.publicKey),
  rejections: [
    { name: "context swapped to another account", envelope: tampered("context", "acct:acc_other/idem:vector-1"), error: "invalid_signature" },
    { name: "kind changed", envelope: tampered("kind", "card"), error: "invalid_signature" },
    { name: "ciphertext replaced", envelope: tampered("ct", b64u(Buffer.alloc(fromB64u(envelope.ct).length, 7))), error: "invalid_signature" },
    { name: "recipient entry dropped", envelope: { ...structuredClone(envelope), recipients: [structuredClone(envelope.recipients[1])] }, error: "invalid_signature" },
  ],
  cryptokit: emitted,
};

const text = `${JSON.stringify(fixture, null, 2)}\n`;
for (const target of targets) writeFileSync(target, text);
console.log(`wrote ${targets.length} copies; cryptokit entries: ${emitted ? "present" : "missing"}`);
