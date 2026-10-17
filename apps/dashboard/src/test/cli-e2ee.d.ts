// Types for the CLI's reference implementation (packages/cli/src/crypto/e2ee.mjs), aliased in vitest.config.ts
// for the interop tests only. The Dashboard bundle never imports it.
declare module "@relo/cli-e2ee" {
  type Bytes = Uint8Array
  export function b64u(bytes: Uint8Array): string
  export function fromB64u(value: string, options?: { length?: number; name?: string }): Bytes
  export function generateKeyPair(): { privateKey: Bytes; publicKey: Bytes }
  export function publicKeyFor(privateKey: Uint8Array): Bytes
  export function keyId(publicKey: Uint8Array): string
  export function safetyNumber(publicKeyA: Uint8Array, publicKeyB: Uint8Array): string
  export function signBytes(privateKey: Uint8Array, message: Uint8Array): Bytes
  export function verifyBytes(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean
  export function verifyPrekey(input: {
    identityPublicKey: Uint8Array
    prekey: { deviceId: string; prekeyId: string; publicKey: string; createdAt: string; signature: string }
  }): boolean
  export function approveDeviceSigningInput(input: {
    deviceId: string
    identityKey: string
    approverDeviceId: string
    signedAt: string
  }): Bytes
  export function answerSigningInput(input: {
    interactionId: string
    notificationId: string
    deviceId: string
    value: string
    respondedAt: string
  }): Bytes
  export function questionAnswerSigningInput(input: {
    interactionId: string
    notificationId: string
    deviceId: string
    value: string
    respondedAt: string
    question: string
  }): Bytes
  export function sealEnvelope(input: {
    kind: string
    context: string
    sender: { privateKey: Uint8Array }
    recipients: Array<{ deviceId: string; prekeyId: string; publicKey: Uint8Array }>
    content: unknown
  }): Record<string, unknown> & { sig: string; recipients: Array<Record<string, string>> }
}
