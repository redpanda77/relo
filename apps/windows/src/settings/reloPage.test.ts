import { encryptionDetail, encryptionNote, encryptionTitle } from "@relo/owner-client"
import { describe, expect, it } from "vitest"
import { readEncryptionView } from "./reloPage"

describe("the Encryption group's payload from the notch", () => {
  it("reads the server's choice, the trusted phone, the problem and the busy flag", () => {
    expect(readEncryptionView({ mode: "on", phoneTrusted: true, problem: null, busy: false })).toEqual({ mode: "on", phoneTrusted: true, problem: null, busy: false })
    expect(readEncryptionView({ mode: "auto", phoneTrusted: false, problem: "Relo could not change that. Try again.", busy: true })).toEqual({
      mode: "auto",
      phoneTrusted: false,
      problem: "Relo could not change that. Try again.",
      busy: true,
    })
  })

  it("shows 'Reading the server's choice…' (mode null) for anything it does not understand", () => {
    expect(readEncryptionView({ mode: "bogus" })).toEqual({ mode: null, phoneTrusted: false, problem: null, busy: false })
    expect(readEncryptionView(null)).toBeNull()
    expect(readEncryptionView("x")).toBeNull()
  })

  it("uses the Mac's words for each choice and the no-iPhone note", () => {
    expect([encryptionTitle("auto"), encryptionTitle("on"), encryptionTitle("off")]).toEqual(["Automatic", "Always", "Off"])
    expect(encryptionDetail("on")).toBe("Always: every card is sealed for your trusted devices")
    expect(encryptionNote({ mode: "on", required: true }, false)).toBe("Cards will open only on this PC until you add an iPhone.")
    expect(encryptionNote({ mode: "on", required: true }, true)).toBeNull()
  })
})
