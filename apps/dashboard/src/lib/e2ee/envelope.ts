/**
 * relo.e2e.v1, OPEN side only, on WebCrypto (docs/END-TO-END-ENCRYPTION.md, "Linked browsers").
 * A byte-for-byte port of packages/cli/src/e2ee.mjs: RFC 9180 HPKE base mode with
 * DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. The recipient prekey is a
 * non-extractable ECDH CryptoKey; the browser never seals anything.
 */
import { b64u, concat, copy, E2eeError, fromB64u, fromUtf8, i2osp, utf8, type Bytes } from "./bytes"

export const E2EE_VERSION = "relo.e2e.v1"
export const ENVELOPE_KINDS = ["notice", "question", "card", "card-update", "reply", "grouping-key", "names"] as const
const PAD_BLOCK = 256
const MAX_PLAINTEXT = 64 * 1024

export type EnvelopeRecipient = { device: string; prekey: string; enc: string; key: string }
export type Envelope = {
  v: typeof E2EE_VERSION
  kind: (typeof ENVELOPE_KINDS)[number]
  context: string
  sender: string
  recipients: EnvelopeRecipient[]
  nonce: string
  ct: string
  sig: string
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle
  if (!value) throw new E2eeError("webcrypto_unavailable")
  return value
}

// ---- HPKE (RFC 9180) ------------------------------------------------------------------------

const KEM_SUITE = concat(utf8("KEM"), i2osp(0x0010, 2))
const HPKE_SUITE = concat(utf8("HPKE"), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0002, 2))
const HPKE_V1 = utf8("HPKE-v1")
const EMPTY = new Uint8Array(0)
// HMAC pads its key with zeros to the block size, so an empty salt equals HashLen zero bytes
// (RFC 5869); WebCrypto refuses zero-length HMAC keys.
const ZERO_SALT = new Uint8Array(32)

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const imported = await subtle().importKey("raw", key.length ? key : ZERO_SALT, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return copy(await subtle().sign("HMAC", imported, data))
}

function labeledExtract(suite: Bytes, salt: Bytes, label: string, ikm: Bytes) {
  return hmac(salt, concat(HPKE_V1, suite, utf8(label), ikm))
}

async function labeledExpand(suite: Bytes, prk: Bytes, label: string, info: Bytes, length: number) {
  const labeled = concat(i2osp(length, 2), HPKE_V1, suite, utf8(label), info)
  return (await hmac(prk, concat(labeled, Uint8Array.of(1)))).slice(0, length)
}

async function aesGcmOpen(key: Bytes, nonce: Bytes, aad: Bytes, sealed: Bytes): Promise<Bytes> {
  if (sealed.length < 16) throw new E2eeError("decryption_failed")
  try {
    const imported = await subtle().importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"])
    return copy(await subtle().decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, imported, sealed))
  } catch {
    throw new E2eeError("decryption_failed")
  }
}

/** HPKE single-shot open with a non-extractable ECDH private key and its X9.63 public key. */
export async function hpkeOpen({
  recipientPrivateKey,
  recipientPublicKey,
  enc,
  info,
  aad,
  ciphertext,
}: {
  recipientPrivateKey: CryptoKey
  recipientPublicKey: Bytes
  enc: Bytes
  info: Bytes
  aad: Bytes
  ciphertext: Bytes
}): Promise<Bytes> {
  if (enc.length !== 65 || enc[0] !== 0x04) throw new E2eeError("invalid_enc")
  let ephemeral: CryptoKey
  try {
    ephemeral = await subtle().importKey("raw", enc, { name: "ECDH", namedCurve: "P-256" }, false, [])
  } catch {
    throw new E2eeError("invalid_enc")
  }
  let dh: Bytes
  try {
    dh = copy(await subtle().deriveBits({ name: "ECDH", public: ephemeral }, recipientPrivateKey, 256))
  } catch {
    throw new E2eeError("decryption_failed")
  }
  const eaePrk = await labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh)
  const sharedSecret = await labeledExpand(KEM_SUITE, eaePrk, "shared_secret", concat(enc, recipientPublicKey), 32)
  const pskIdHash = await labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY)
  const infoHash = await labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info)
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash)
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY)
  const key = await labeledExpand(HPKE_SUITE, secret, "key", context, 32)
  const nonce = await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12)
  return aesGcmOpen(key, nonce, aad, ciphertext)
}

// ---- keys -----------------------------------------------------------------------------------

function assertPublicKey(bytes: Bytes, name = "public_key"): Bytes {
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new E2eeError(`invalid_${name}`)
  return bytes
}

/** "k_" + first 16 bytes of SHA-256(X9.63 public key), base64url. */
export async function keyId(publicKey: Bytes): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", assertPublicKey(publicKey)))
  return `k_${b64u(digest.subarray(0, 16))}`
}

/** Bytes an identity key signs to publish a prekey. */
export function prekeySigningInput({
  deviceId,
  prekeyId,
  publicKey,
  createdAt,
}: {
  deviceId: string
  prekeyId: string
  publicKey: Bytes
  createdAt: string
}): Bytes {
  return utf8([`${E2EE_VERSION} prekey`, deviceId, prekeyId, b64u(assertPublicKey(publicKey)), createdAt].join("\n"))
}

/**
 * Bytes a trusted phone, or a linked browser, signs to approve a new device: the same input as the
 * CLI's and the iPhone's `approveDeviceSigningInput`, with the approver's id (`dev_…` or `brw_…`).
 */
export function approveDeviceSigningInput({
  deviceId,
  identityKey,
  approverDeviceId,
  signedAt,
}: {
  deviceId: string
  identityKey: string
  approverDeviceId: string
  signedAt: string
}): Bytes {
  return utf8([`${E2EE_VERSION} approve-device`, deviceId, identityKey, approverDeviceId, signedAt].join("\n"))
}

/** ECDSA P-256 / SHA-256 over raw r||s, as CryptoKit and the CLI produce. */
export async function verifyBytes(publicKey: Bytes, message: Bytes, signature: Bytes): Promise<boolean> {
  if (signature.length !== 64) return false
  try {
    const key = await subtle().importKey("raw", assertPublicKey(publicKey, "signing_key"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, message)
  } catch {
    return false
  }
}

// ---- envelope -------------------------------------------------------------------------------

function unpad(padded: Bytes): Bytes {
  if (padded.length < 4 || padded.length % PAD_BLOCK !== 0) throw new E2eeError("invalid_padding")
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0)
  if (length > padded.length - 4 || length > MAX_PLAINTEXT) throw new E2eeError("invalid_padding")
  if (padded.subarray(4 + length).some((byte) => byte !== 0)) throw new E2eeError("invalid_padding")
  return padded.slice(4, 4 + length)
}

function assertBinding(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/u.test(value)) throw new E2eeError(`invalid_${name}`)
  return value
}

function byteOrder(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function bodyAad(envelope: Pick<Envelope, "kind" | "context" | "sender">): Bytes {
  return utf8([E2EE_VERSION, envelope.kind, envelope.context, envelope.sender].join("\n"))
}

function wrapAad(envelope: Envelope, recipient: EnvelopeRecipient): Bytes {
  return concat(bodyAad(envelope), utf8(`\n${recipient.device}\n${recipient.prekey}`))
}

const WRAP_INFO = utf8(`${E2EE_VERSION} content-key`)

/** Canonical bytes the sender signs: every envelope field except the signature itself. */
export function envelopeSigningInput(envelope: Envelope): Bytes {
  const recipients = [...envelope.recipients]
    .sort((a, b) => byteOrder(a.device, b.device) || byteOrder(a.prekey, b.prekey))
    .map((r) => [r.device, r.prekey, r.enc, r.key].join(" "))
  return utf8([`${E2EE_VERSION} envelope`, envelope.kind, envelope.context, envelope.sender, envelope.nonce, envelope.ct, ...recipients].join("\n"))
}

/** The structural check every party runs before trusting any field. */
export function validateEnvelopeShape(value: unknown): Envelope {
  const envelope = value as Partial<Envelope> | null
  if (!envelope || typeof envelope !== "object" || envelope.v !== E2EE_VERSION) throw new E2eeError("invalid_envelope")
  if (!ENVELOPE_KINDS.includes(envelope.kind as Envelope["kind"])) throw new E2eeError("invalid_kind")
  assertBinding(envelope.context, "context")
  if (typeof envelope.sender !== "string" || !/^k_[A-Za-z0-9_-]{22}$/u.test(envelope.sender)) throw new E2eeError("invalid_sender")
  fromB64u(envelope.nonce, { length: 12, name: "nonce" })
  const ct = fromB64u(envelope.ct, { name: "ciphertext" })
  if (ct.length < PAD_BLOCK + 16 || (ct.length - 16) % PAD_BLOCK !== 0) throw new E2eeError("invalid_ciphertext")
  fromB64u(envelope.sig, { length: 64, name: "signature" })
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length < 1 || envelope.recipients.length > 16) {
    throw new E2eeError("invalid_recipients")
  }
  for (const recipient of envelope.recipients) {
    if (!recipient || typeof recipient !== "object") throw new E2eeError("invalid_recipients")
    assertBinding(recipient.device, "device")
    assertBinding(recipient.prekey, "prekey")
    fromB64u(recipient.enc, { length: 65, name: "enc" })
    fromB64u(recipient.key, { length: 48, name: "wrapped_key" })
  }
  return envelope as Envelope
}

export type RecipientPrekey = { privateKey: CryptoKey; publicKey: Bytes }

/**
 * Verify the sender against `trustedSenders` (keyId → X9.63 public key), then open the entry for
 * `deviceId` with the prekey `prekeyFor(prekeyId)` returns. Returns { content, sender, kind }.
 */
export async function openEnvelope(
  value: unknown,
  {
    deviceId,
    prekeyFor,
    trustedSenders,
    expectedKind,
  }: {
    deviceId: string
    prekeyFor: (prekeyId: string) => RecipientPrekey | null | undefined | Promise<RecipientPrekey | null | undefined>
    trustedSenders: ReadonlyMap<string, Bytes>
    expectedKind?: Envelope["kind"]
  }
): Promise<{ content: unknown; sender: string; kind: Envelope["kind"] }> {
  const envelope = validateEnvelopeShape(value)
  if (expectedKind !== undefined && envelope.kind !== expectedKind) throw new E2eeError("unexpected_kind")
  const senderKey = trustedSenders.get(envelope.sender)
  if (!senderKey || (await keyId(senderKey)) !== envelope.sender) throw new E2eeError("untrusted_sender")
  const signature = fromB64u(envelope.sig, { length: 64, name: "signature" })
  if (!(await verifyBytes(senderKey, envelopeSigningInput(envelope), signature))) throw new E2eeError("invalid_signature")
  const entry = envelope.recipients.find((recipient) => recipient.device === deviceId)
  if (!entry) throw new E2eeError("not_a_recipient")
  const prekey = await prekeyFor(entry.prekey)
  if (!prekey) throw new E2eeError("prekey_unavailable")
  const cek = await hpkeOpen({
    recipientPrivateKey: prekey.privateKey,
    recipientPublicKey: prekey.publicKey,
    enc: fromB64u(entry.enc, { length: 65, name: "enc" }),
    info: WRAP_INFO,
    aad: wrapAad(envelope, entry),
    ciphertext: fromB64u(entry.key, { length: 48, name: "wrapped_key" }),
  })
  const padded = await aesGcmOpen(cek, fromB64u(envelope.nonce, { length: 12, name: "nonce" }), bodyAad(envelope), fromB64u(envelope.ct, { name: "ciphertext" }))
  let content: unknown
  try {
    content = JSON.parse(fromUtf8(unpad(padded)))
  } catch (cause) {
    if (cause instanceof E2eeError) throw cause
    throw new E2eeError("invalid_plaintext")
  }
  return { content, sender: envelope.sender, kind: envelope.kind }
}
