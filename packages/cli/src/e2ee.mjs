// End-to-end encryption core: relo.e2e.v1 (docs/END-TO-END-ENCRYPTION.md).
//
// HPKE is RFC 9180 base mode, single shot, with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
// AES-256-GCM, built only on node:crypto primitives so the CLI keeps zero dependencies. Its
// correctness is pinned by cross-implementation vectors that CryptoKit seals and opens
// (packages/contracts/fixtures/e2ee-v1.json, checked by both test suites).
import {
  createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey,
  createPublicKey, randomBytes, sign as nodeSign, timingSafeEqual, verify as nodeVerify,
} from "node:crypto";

export const E2EE_VERSION = "relo.e2e.v1";
export const ENVELOPE_KINDS = Object.freeze(["notice", "question", "card", "card-update", "reply", "grouping-key", "names"]);
const PAD_BLOCK = 256;
const MAX_PLAINTEXT = 64 * 1024;

// ---- encoding -------------------------------------------------------------------------------

export function b64u(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64u(value, { length, name = "value" } = {}) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw e2eeError(`invalid_${name}`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw e2eeError(`invalid_${name}`);
  if (length !== undefined && bytes.length !== length) throw e2eeError(`invalid_${name}`);
  return bytes;
}

function i2osp(value, length) {
  const out = Buffer.alloc(length);
  out.writeUIntBE(value, 0, length);
  return out;
}

export function e2eeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// ---- HPKE (RFC 9180) ------------------------------------------------------------------------

const KEM_ID = 0x0010; // DHKEM(P-256, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0002; // AES-256-GCM
const N_SECRET = 32;
const N_K = 32;
const N_N = 12;
const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), i2osp(KEM_ID, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)]);
const HPKE_V1 = Buffer.from("HPKE-v1");

function hkdfExtract(salt, ikm) {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  if (length > 32) throw e2eeError("hkdf_length");
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

function labeledExtract(suite, salt, label, ikm) {
  return hkdfExtract(salt, Buffer.concat([HPKE_V1, suite, Buffer.from(label), ikm]));
}

function labeledExpand(suite, prk, label, info, length) {
  return hkdfExpand(prk, Buffer.concat([i2osp(length, 2), HPKE_V1, suite, Buffer.from(label), info]), length);
}

function assertPublicKey(publicKey, name = "public_key") {
  const bytes = Buffer.from(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw e2eeError(`invalid_${name}`);
  return bytes;
}

function assertPrivateKey(privateKey) {
  const bytes = Buffer.from(privateKey);
  if (bytes.length !== 32) throw e2eeError("invalid_private_key");
  return bytes;
}

function ecdh(privateKey) {
  const agreement = createECDH("prime256v1");
  agreement.setPrivateKey(assertPrivateKey(privateKey));
  return agreement;
}

function dh(privateKey, publicKey) {
  try {
    return ecdh(privateKey).computeSecret(assertPublicKey(publicKey));
  } catch (error) {
    if (error?.code?.startsWith?.("invalid_")) throw error;
    throw e2eeError("invalid_public_key");
  }
}

function kemSharedSecret(dhBytes, enc, recipientPublicKey) {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dhBytes);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", Buffer.concat([enc, recipientPublicKey]), N_SECRET);
}

function keySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "info_hash", Buffer.from(info));
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", Buffer.alloc(0));
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, N_K),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, N_N),
  };
}

function aesGcmSeal(key, nonce, aad, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmOpen(key, nonce, aad, sealed) {
  const bytes = Buffer.from(sealed);
  if (bytes.length < 16) throw e2eeError("decryption_failed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
  } catch {
    throw e2eeError("decryption_failed");
  }
}

/** HPKE single-shot seal (base mode). `ephemeralPrivateKey` exists only for fixed test vectors. */
export function hpkeSeal({ recipientPublicKey, info, aad, plaintext, ephemeralPrivateKey }) {
  const pkR = assertPublicKey(recipientPublicKey, "recipient_key");
  const ephemeral = createECDH("prime256v1");
  if (ephemeralPrivateKey) ephemeral.setPrivateKey(assertPrivateKey(ephemeralPrivateKey));
  else ephemeral.generateKeys();
  const enc = ephemeral.getPublicKey(null, "uncompressed");
  let dhBytes;
  try {
    dhBytes = ephemeral.computeSecret(pkR);
  } catch {
    throw e2eeError("invalid_recipient_key");
  }
  const { key, nonce } = keySchedule(kemSharedSecret(dhBytes, enc, pkR), info);
  return { enc, ciphertext: aesGcmSeal(key, nonce, aad, plaintext) };
}

/** HPKE single-shot open (base mode). */
export function hpkeOpen({ recipientPrivateKey, enc, info, aad, ciphertext }) {
  const encBytes = assertPublicKey(enc, "enc");
  const recipient = ecdh(recipientPrivateKey);
  const pkR = recipient.getPublicKey(null, "uncompressed");
  const { key, nonce } = keySchedule(kemSharedSecret(dh(recipientPrivateKey, encBytes), encBytes, pkR), info);
  return aesGcmOpen(key, nonce, aad, ciphertext);
}

// ---- keys -----------------------------------------------------------------------------------

function padPrivate(bytes) {
  return bytes.length === 32 ? bytes : Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
}

/** A P-256 key pair as raw scalar (32 bytes) and X9.63 uncompressed point (65 bytes). */
export function generateKeyPair() {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return { privateKey: padPrivate(pair.getPrivateKey()), publicKey: pair.getPublicKey(null, "uncompressed") };
}

export function publicKeyFor(privateKey) {
  return ecdh(privateKey).getPublicKey(null, "uncompressed");
}

/** Stable key identifier: "k_" + first 16 bytes of SHA-256(X9.63 public key), base64url. */
export function keyId(publicKey) {
  return `k_${b64u(createHash("sha256").update(assertPublicKey(publicKey)).digest().subarray(0, 16))}`;
}

function signingKeyObject(privateKey) {
  const publicKey = publicKeyFor(privateKey);
  return createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: b64u(privateKey), x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33)) },
  });
}

function verifyingKeyObject(publicKey) {
  const bytes = assertPublicKey(publicKey, "signing_key");
  return createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(bytes.subarray(1, 33)), y: b64u(bytes.subarray(33)) } });
}

/** ECDSA P-256 / SHA-256, raw r||s (64 bytes), as CryptoKit's rawRepresentation. */
export function signBytes(privateKey, message) {
  return nodeSign("sha256", Buffer.from(message), { key: signingKeyObject(privateKey), dsaEncoding: "ieee-p1363" });
}

export function verifyBytes(publicKey, message, signature) {
  const sig = Buffer.from(signature);
  if (sig.length !== 64) return false;
  try {
    return nodeVerify("sha256", Buffer.from(message), { key: verifyingKeyObject(publicKey), dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

// ---- signed prekeys -------------------------------------------------------------------------

/** Bytes a device identity key signs to publish a prekey. */
export function prekeySigningInput({ deviceId, prekeyId, publicKey, createdAt }) {
  return Buffer.from([`${E2EE_VERSION} prekey`, deviceId, prekeyId, b64u(assertPublicKey(publicKey)), createdAt].join("\n"));
}

/**
 * Bytes a phone's identity key signs to link a browser (docs/END-TO-END-ENCRYPTION.md, "Linked
 * browsers"): the browser's id and identity key, scanned from its QR code, and the signing phone.
 */
export function linkSigningInput({ browserId, identityKey, phoneDeviceId, signedAt }) {
  return Buffer.from([`${E2EE_VERSION} link`, browserId, identityKey, phoneDeviceId, signedAt].join("\n"));
}

/**
 * Bytes a trusted phone's identity key signs to approve a newer phone of the account (docs/
 * END-TO-END-ENCRYPTION.md, "New devices are approved on a trusted phone").
 */
export function approveDeviceSigningInput({ deviceId, identityKey, approverDeviceId, signedAt }) {
  return Buffer.from([`${E2EE_VERSION} approve-device`, deviceId, identityKey, approverDeviceId, signedAt].join("\n"));
}

export function verifyPrekey({ identityPublicKey, prekey }) {
  return verifyBytes(identityPublicKey, prekeySigningInput({
    deviceId: prekey.deviceId, prekeyId: prekey.prekeyId,
    publicKey: fromB64u(prekey.publicKey, { length: 65, name: "prekey" }), createdAt: prekey.createdAt,
  }), fromB64u(prekey.signature, { length: 64, name: "signature" }));
}

// ---- envelope -------------------------------------------------------------------------------

function pad(plaintext) {
  if (plaintext.length > MAX_PLAINTEXT) throw e2eeError("plaintext_too_large");
  const framed = Buffer.concat([i2osp(plaintext.length, 4), plaintext]);
  const size = Math.ceil(framed.length / PAD_BLOCK) * PAD_BLOCK;
  return Buffer.concat([framed, Buffer.alloc(size - framed.length)]);
}

function unpad(padded) {
  if (padded.length < 4 || padded.length % PAD_BLOCK !== 0) throw e2eeError("invalid_padding");
  const length = padded.readUInt32BE(0);
  if (length > padded.length - 4 || length > MAX_PLAINTEXT) throw e2eeError("invalid_padding");
  if (padded.subarray(4 + length).some((byte) => byte !== 0)) throw e2eeError("invalid_padding");
  return padded.subarray(4, 4 + length);
}

// Bound identifiers are printable ASCII without spaces, so every implementation orders and
// encodes them identically (byte order equals UTF-16 code-unit order).
function assertBinding(value, name) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value)) throw e2eeError(`invalid_${name}`);
  return value;
}

function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bodyAad({ kind, context, sender }) {
  return Buffer.from([E2EE_VERSION, kind, context, sender].join("\n"));
}

function wrapAad(envelope, recipient) {
  return Buffer.concat([bodyAad(envelope), Buffer.from(`\n${recipient.device}\n${recipient.prekey}`)]);
}

const WRAP_INFO = Buffer.from(`${E2EE_VERSION} content-key`);

/** Canonical bytes the sender signs: every envelope field except the signature itself. */
export function envelopeSigningInput(envelope) {
  const recipients = [...envelope.recipients]
    .sort((a, b) => byteOrder(a.device, b.device) || byteOrder(a.prekey, b.prekey))
    .map((r) => [r.device, r.prekey, r.enc, r.key].join(" "));
  return Buffer.from([`${E2EE_VERSION} envelope`, envelope.kind, envelope.context, envelope.sender,
    envelope.nonce, envelope.ct, ...recipients].join("\n"));
}

/**
 * Seal `content` (a JSON value) for every recipient prekey and sign it with the sender identity.
 * `context` binds the envelope to its account and request (e.g. "acct:<id>/idem:<key>").
 */
export function sealEnvelope({ kind, context, sender, recipients, content, contentKey, nonce, ephemeralKeys }) {
  if (!ENVELOPE_KINDS.includes(kind)) throw e2eeError("invalid_kind");
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 16) throw e2eeError("invalid_recipients");
  const envelope = {
    v: E2EE_VERSION, kind, context: assertBinding(context, "context"),
    sender: keyId(publicKeyFor(sender.privateKey)), recipients: [], nonce: "", ct: "", sig: "",
  };
  const cek = contentKey ? Buffer.from(contentKey) : randomBytes(32);
  const bodyNonce = nonce ? Buffer.from(nonce) : randomBytes(12);
  if (cek.length !== 32 || bodyNonce.length !== 12) throw e2eeError("invalid_content_key");
  envelope.nonce = b64u(bodyNonce);
  envelope.ct = b64u(aesGcmSeal(cek, bodyNonce, bodyAad(envelope), pad(Buffer.from(JSON.stringify(content), "utf8"))));
  const seen = new Set();
  recipients.forEach((recipient, index) => {
    const entry = { device: assertBinding(recipient.deviceId, "device"), prekey: assertBinding(recipient.prekeyId, "prekey") };
    if (seen.has(`${entry.device}\n${entry.prekey}`)) throw e2eeError("duplicate_recipient");
    seen.add(`${entry.device}\n${entry.prekey}`);
    const sealed = hpkeSeal({
      recipientPublicKey: recipient.publicKey, info: WRAP_INFO, aad: wrapAad(envelope, entry), plaintext: cek,
      ephemeralPrivateKey: ephemeralKeys?.[index],
    });
    envelope.recipients.push({ ...entry, enc: b64u(sealed.enc), key: b64u(sealed.ciphertext) });
  });
  envelope.sig = b64u(signBytes(sender.privateKey, envelopeSigningInput(envelope)));
  return envelope;
}

/** Structural check every party runs before trusting any field (the server runs only this). */
export function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || envelope.v !== E2EE_VERSION) throw e2eeError("invalid_envelope");
  if (!ENVELOPE_KINDS.includes(envelope.kind)) throw e2eeError("invalid_kind");
  assertBinding(envelope.context, "context");
  if (!/^k_[A-Za-z0-9_-]{22}$/.test(envelope.sender)) throw e2eeError("invalid_sender");
  fromB64u(envelope.nonce, { length: 12, name: "nonce" });
  const ct = fromB64u(envelope.ct, { name: "ciphertext" });
  if (ct.length < PAD_BLOCK + 16 || (ct.length - 16) % PAD_BLOCK !== 0) throw e2eeError("invalid_ciphertext");
  fromB64u(envelope.sig, { length: 64, name: "signature" });
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length < 1 || envelope.recipients.length > 16) {
    throw e2eeError("invalid_recipients");
  }
  for (const recipient of envelope.recipients) {
    assertBinding(recipient.device, "device");
    assertBinding(recipient.prekey, "prekey");
    fromB64u(recipient.enc, { length: 65, name: "enc" });
    fromB64u(recipient.key, { length: 48, name: "wrapped_key" });
  }
  return envelope;
}

/**
 * Verify the sender against `trustedSenders` (keyId → public key), then open the entry for
 * `deviceId` with `prekeyPrivateKey(prekeyId)`. Returns { content, sender }.
 */
export function openEnvelope(envelope, { deviceId, prekeyPrivateKey, trustedSenders, expectedContext, expectedKind }) {
  validateEnvelopeShape(envelope);
  if (expectedKind !== undefined && envelope.kind !== expectedKind) throw e2eeError("unexpected_kind");
  if (expectedContext !== undefined && envelope.context !== expectedContext) throw e2eeError("unexpected_context");
  const senderKey = trustedSenders instanceof Map ? trustedSenders.get(envelope.sender) : trustedSenders?.[envelope.sender];
  if (!senderKey) throw e2eeError("untrusted_sender");
  if (keyId(senderKey) !== envelope.sender) throw e2eeError("untrusted_sender");
  if (!verifyBytes(senderKey, envelopeSigningInput(envelope), fromB64u(envelope.sig, { length: 64, name: "signature" }))) {
    throw e2eeError("invalid_signature");
  }
  const entry = envelope.recipients.find((recipient) => recipient.device === deviceId);
  if (!entry) throw e2eeError("not_a_recipient");
  const privateKey = prekeyPrivateKey(entry.prekey);
  if (!privateKey) throw e2eeError("prekey_unavailable");
  const cek = hpkeOpen({
    recipientPrivateKey: privateKey, enc: fromB64u(entry.enc, { length: 65, name: "enc" }), info: WRAP_INFO,
    aad: wrapAad(envelope, entry), ciphertext: fromB64u(entry.key, { length: 48, name: "wrapped_key" }),
  });
  const padded = aesGcmOpen(cek, fromB64u(envelope.nonce, { length: 12, name: "nonce" }), bodyAad(envelope), fromB64u(envelope.ct, { name: "ciphertext" }));
  return { content: JSON.parse(unpad(padded).toString("utf8")), sender: envelope.sender };
}

// ---- signed answers -------------------------------------------------------------------------

/** Bytes a device identity key signs for an answer; the CLI verifies them before acting. */
export function answerSigningInput({ interactionId, notificationId, deviceId, value, respondedAt }) {
  return Buffer.from([`${E2EE_VERSION} answer`, interactionId, notificationId, deviceId, value, respondedAt].join("\n"));
}

/**
 * An answer to a sealed question also signs the context of the question envelope the phone opened,
 * a value only the asking CLI chose, so a server cannot move an approval to another question.
 */
export function questionAnswerSigningInput({ interactionId, notificationId, deviceId, value, respondedAt, question }) {
  return Buffer.from([`${E2EE_VERSION} answer-to`, interactionId, notificationId, deviceId, value, respondedAt, question].join("\n"));
}

export function verifyAnswer({ identityPublicKey, answer }) {
  return verifyBytes(identityPublicKey, answerSigningInput(answer), fromB64u(answer.signature, { length: 64, name: "signature" }));
}

// ---- safety number --------------------------------------------------------------------------

function fingerprintChunks(publicKey) {
  // Signal-style: 5200 iterations of SHA-512 over the identity key, 30 bytes → six 5-digit groups.
  let hash = Buffer.concat([Buffer.from([0, 0]), assertPublicKey(publicKey)]);
  for (let i = 0; i < 5200; i += 1) hash = createHash("sha512").update(hash).update(publicKey).digest();
  const groups = [];
  for (let i = 0; i < 30; i += 5) groups.push(String(hash.readUIntBE(i, 5) % 100000).padStart(5, "0"));
  return groups;
}

/** 60 digits both sides display; equal only when both hold the same pair of identity keys. */
export function safetyNumber(publicKeyA, publicKeyB) {
  const a = fingerprintChunks(publicKeyA);
  const b = fingerprintChunks(publicKeyB);
  const [first, second] = Buffer.compare(Buffer.from(publicKeyA), Buffer.from(publicKeyB)) <= 0 ? [a, b] : [b, a];
  return [...first, ...second].join(" ");
}

export function constantTimeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
