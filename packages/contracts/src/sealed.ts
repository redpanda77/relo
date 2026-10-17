import { z } from "zod";

/**
 * End-to-end sealed envelope (docs/ENCRYPTION-PROTOCOL.md, E3): the one shape every surface carries
 * and the server stores as opaque JSON (it holds no key that opens it). The shape rules match
 * packages/cli/src/crypto/e2ee.mjs `validateEnvelopeShape` and ReloE2EE.validateShape. Pure (no Buffer), so
 * the Dashboard and the server share it.
 */
const B64U = /^[A-Za-z0-9_-]+$/;
const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Decoded byte length of canonical unpadded base64url, or null when the text is not canonical. */
export function base64UrlByteLength(value: string): number | null {
  if (!B64U.test(value) || value.length % 4 === 1) return null;
  // The unused low bits of the last character must be zero (what a decode/encode round trip keeps).
  const rest = value.length % 4;
  if (rest !== 0) {
    const last = B64U_ALPHABET.indexOf(value[value.length - 1]!);
    const unused = rest === 2 ? 0b1111 : 0b11;
    if ((last & unused) !== 0) return null;
  }
  return Math.floor(value.length * 3 / 4);
}

const b64u = (length?: number) => z.string().max(140_000).regex(B64U).refine((value) => {
  const bytes = base64UrlByteLength(value);
  return bytes !== null && (length === undefined || bytes === length);
},"invalid_encoding");
const binding = z.string().regex(/^[\x21-\x7e]{1,200}$/);

export const SEALED_ENVELOPE_KINDS = ["notice","question","card","card-update","reply","grouping-key","names"] as const;

export const sealedEnvelopeSchema = z.object({
  v: z.literal("relo.e2e.v1"),
  kind: z.enum(SEALED_ENVELOPE_KINDS),
  context: binding,
  sender: z.string().regex(/^k_[A-Za-z0-9_-]{22}$/),
  recipients: z.array(z.object({
    device: binding,
    prekey: binding,
    enc: b64u(65),
    key: b64u(48),
  }).strict()).min(1).max(16),
  nonce: b64u(12),
  ct: b64u().refine((value) => {
    const length = base64UrlByteLength(value) ?? 0;
    return length >= 256 + 16 && (length - 16) % 256 === 0;
  },"invalid_ciphertext"),
  sig: b64u(64),
}).strict();

export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;
