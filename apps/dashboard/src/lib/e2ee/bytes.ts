/** Byte helpers for relo.e2e.v1 on WebCrypto (the browser port of packages/cli/src/e2ee.mjs). */

export type Bytes = Uint8Array<ArrayBuffer>

export class E2eeError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = "E2eeError"
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function utf8(value: string): Bytes {
  const encoded = encoder.encode(value)
  const out = new Uint8Array(encoded.length)
  out.set(encoded)
  return out
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function copy(bytes: ArrayBuffer | Uint8Array): Bytes {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = new Uint8Array(view.length)
  out.set(view)
  return out
}

export function i2osp(value: number, length: number): Bytes {
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  return out
}

export function b64u(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

/** Strict base64url: rejects padding, other alphabets and non-canonical trailing bits. */
export function fromB64u(
  value: unknown,
  { length, name = "value" }: { length?: number; name?: string } = {}
): Bytes {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new E2eeError(`invalid_${name}`)
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new E2eeError(`invalid_${name}`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (b64u(bytes) !== value) throw new E2eeError(`invalid_${name}`)
  if (length !== undefined && bytes.length !== length) throw new E2eeError(`invalid_${name}`)
  return bytes
}
