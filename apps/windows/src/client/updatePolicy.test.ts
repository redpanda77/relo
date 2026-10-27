import { describe, expect, it } from "vitest"
import { bannerText, isLoopback, isSnoozed, SNOOZE_MS, snoozedUntil, updateFeedUrl, updatedLine, versionText } from "./updatePolicy"

const release = "https://release.example.com"

describe("where updates come from", () => {
  it("a remote server keeps its own feed; a local install or a server on this PC uses the public one", () => {
    expect(updateFeedUrl("https://relo.example.com", release, false)).toBe("https://relo.example.com/windows/update.json")
    expect(updateFeedUrl("http://127.0.0.1:8180", release, false)).toBe(`${release}/windows/update.json`)
    expect(updateFeedUrl("http://localhost:8180", release, false)).toBe(`${release}/windows/update.json`)
    expect(updateFeedUrl("https://relo.example.com", release, true)).toBe(`${release}/windows/update.json`)
  })

  it("never checks when there is nothing to ask", () => {
    expect(updateFeedUrl(null, release, false)).toBeNull()
    expect(updateFeedUrl("http://localhost:1", null, false)).toBeNull()
    expect(updateFeedUrl("not a url", release, false)).toBeNull()
  })

  it("knows loopback", () => {
    expect(isLoopback("http://[::1]:3000")).toBe(true)
    expect(isLoopback("http://app.localhost")).toBe(true)
    expect(isLoopback("https://relo.example.com")).toBe(false)
  })
})

describe("Later", () => {
  it("hides the reminder for a day, for that version only", () => {
    const now = 1_000_000
    const snooze = { version: "0.2.0", until: snoozedUntil(now) }
    expect(snooze.until - now).toBe(SNOOZE_MS)
    expect(isSnoozed("0.2.0", snooze, now + 1000)).toBe(true)
    expect(isSnoozed("0.2.0", snooze, now + SNOOZE_MS)).toBe(false)
    expect(isSnoozed("0.2.1", snooze, now + 1000)).toBe(false)
    expect(isSnoozed("0.2.0", null, now)).toBe(false)
  })
})

describe("words", () => {
  it("reads like the Mac", () => {
    expect(updatedLine("0.2.32", "notApplicable")).toBe("Updated to 0.2.32")
    expect(updatedLine("0.2.32", "refreshed")).toBe("Updated to 0.2.32 · agents refreshed")
    expect(updatedLine("0.2.32", "failed")).toBe("Updated to 0.2.32 · agents not refreshed: Set up agents again in Settings")
    expect(versionText("0.2.32")).toBe("Version 0.2.32")
    expect(bannerText("0.2.0", true)).toBe("Relo 0.2.0 is ready")
    expect(bannerText("0.2.0", false)).toBe("Relo 0.2.0 is available")
  })
})
