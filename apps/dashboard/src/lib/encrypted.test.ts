import { describe, expect, it } from "vitest"

import { displayName, displayNameOrNull, ENCRYPTED_TEXT, isOpaqueHandle } from "@/lib/encrypted"

describe("encrypted display helpers", () => {
  it("names each kind of opaque handle without showing it", () => {
    expect(displayName("p-abcdefghijklmnop")).toBe("Encrypted project")
    expect(displayName("t-abcdefghijklmn27")).toBe("Encrypted topic")
    expect(displayName("w-abcdefghijklmnop")).toBe("Encrypted task")
    expect(displayName("c-abcdefghijklmnop")).toBe("Encrypted computer")
    expect(displayName("a-abcdefghijklmnop")).toBe("Encrypted account")
  })

  it("leaves readable names, near misses and other prefixes alone", () => {
    for (const value of [
      "Relo",
      "p-abc",
      "p-abcdefghijklmnopq",
      "p-ABCDEFGHIJKLMNOP",
      "p-abcdefghijklmn01",
      "x-abcdefghijklmnop",
      "my p-abcdefghijklmnop",
    ]) {
      expect(displayName(value)).toBe(value)
      expect(isOpaqueHandle(value)).toBe(false)
    }
    expect(isOpaqueHandle("c-abcdefghijklmnop")).toBe(true)
  })

  it("keeps missing names missing", () => {
    expect(displayNameOrNull(null)).toBeNull()
    expect(displayNameOrNull(" ")).toBeNull()
    expect(displayNameOrNull("a-abcdefghijklmnop")).toBe("Encrypted account")
  })

  it("says where to read sealed text", () => {
    expect(ENCRYPTED_TEXT).toBe("End-to-end encrypted · open on iPhone to read")
  })
})
