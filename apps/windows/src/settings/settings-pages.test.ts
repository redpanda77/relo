import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { accountButton, accountLine, approvalLine, displayAddress, INITIAL_STATUS, readOwnerPayload, statusLine, updateCheckLine } from "./account"
import { PAGE_IDS, PAGE_LIST } from "./pageList"
import { recorderKey, type RecorderKey } from "./recorder"
import { modelRow } from "./voicePage"
import { formatBytes } from "./voiceSpeak"

const key = (over: Partial<RecorderKey>): RecorderKey => ({ key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over })

describe("page registration", () => {
  it("lists the Mac's sidebar in the Mac's order, Media and Shelf included", () => {
    expect(PAGE_IDS).toEqual(["relo", "alerts", "voice", "general", "appearance", "media", "shelf", "shortcuts", "advanced", "about"])
    expect(PAGE_LIST.filter((p) => p.group === "notch").map((p) => p.title)).toEqual(["General", "Appearance", "Media", "Shelf", "Shortcuts"])
  })

  it("matches the Rust allow-list in settings_window.rs", () => {
    const rust = readFileSync(path.resolve(import.meta.dirname, "../../src-tauri/src/settings_window.rs"), "utf8")
    const line = rust.match(/pub const PAGES: \[&str; \d+\] = \[([^\]]*)\]/)
    expect(line).not.toBeNull()
    const ids = [...line![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1])
    for (const id of PAGE_IDS) expect(ids).toContain(id)
    expect(ids).toContain("onboarding")
  })

  it("renders every page from SettingsApp", () => {
    const app = readFileSync(path.resolve(import.meta.dirname, "SettingsApp.tsx"), "utf8")
    for (const id of PAGE_IDS) expect(app).toContain(`page === "${id}"`)
  })
})

describe("shortcut recorder", () => {
  it("records a modifier and a key", () => {
    expect(recorderKey(key({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true }))).toEqual({ kind: "set", accelerator: "Ctrl+Shift+K" })
    expect(recorderKey(key({ key: "F5", code: "F5", altKey: true }))).toEqual({ kind: "set", accelerator: "Alt+F5" })
  })
  it("waits while only modifiers are down", () => {
    expect(recorderKey(key({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toEqual({ kind: "wait" })
  })
  it("cancels on Escape and clears on Backspace", () => {
    expect(recorderKey(key({ key: "Escape", code: "Escape" }))).toEqual({ kind: "cancel" })
    expect(recorderKey(key({ key: "Backspace", code: "Backspace" }))).toEqual({ kind: "clear" })
    expect(recorderKey(key({ key: "Delete", code: "Delete" }))).toEqual({ kind: "clear" })
  })
  it("refuses a bare key", () => {
    expect(recorderKey(key({ key: "h", code: "KeyH" }))).toEqual({ kind: "needsModifier" })
  })
})

describe("account block", () => {
  it("follows owner_state and remembers what it was not told again", () => {
    const live = readOwnerPayload({ state: "live", approval: "waiting" }, INITIAL_STATUS, 1000)
    expect(live).toMatchObject({ connection: "live", approval: "waiting", at: 1000 })
    const later = readOwnerPayload({ state: "live" }, live, 2000)
    expect(later).toMatchObject({ approval: "waiting", at: 1000 })
    expect(readOwnerPayload({ state: "nonsense" }, live, 3000).connection).toBe("live")
    expect(readOwnerPayload({ state: "signedOut", approval: null }, live, 4000)).toMatchObject({ connection: "signedOut", approval: null })
    expect(readOwnerPayload(null, live, 5000).connection).toBe("live")
  })
  it("says what the Mac says", () => {
    expect(accountLine("live")).toBe("Signed in")
    expect(statusLine("signedOut", null)).toBe("Not signed in")
    expect(statusLine("needsSignIn", null)).toBe("This PC was signed out; sign in again")
    expect(statusLine("live", null)).toBe("Live")
    expect(statusLine("live", Date.UTC(2026, 0, 1))).toMatch(/^Live · synced /)
    expect(accountButton("signedOut")).toEqual({ label: "Sign in", action: "signIn" })
    expect(accountButton("needsSignIn")).toEqual({ label: "Sign in again", action: "signIn" })
    expect(accountButton("signingIn")).toEqual({ label: "Signing in…", action: null })
    expect(accountButton("offline")).toEqual({ label: "Sign out", action: "signOut" })
    expect(approvalLine("waiting")).toBe("Approve this PC on your iPhone")
    expect(approvalLine("approved")).toBe("This PC is approved on your iPhone")
    expect(approvalLine(null)).toBeNull()
  })
  it("shows the server without its default port", () => {
    expect(displayAddress("https://relo.example.com")).toBe("relo.example.com")
    expect(displayAddress("http://localhost:4000")).toBe("localhost:4000")
    expect(displayAddress(null)).toBe("Not set")
  })
  it("words the update check", () => {
    expect(updateCheckLine({ state: "none" })).toBe("Relo for Windows is up to date.")
    expect(updateCheckLine({ state: "available", version: "0.3.1" })).toBe("Version 0.3.1 is available.")
    expect(updateCheckLine({ state: "off" })).toBe("This build does not take updates.")
  })
})

describe("voice model row", () => {
  const base = { state: "missing", fraction: 0, downloadedBytes: 0, totalBytes: 102_823_920, error: null, waitingForNetwork: false, id: "x", revision: "r", directory: "d" } as const
  it("offers what each state allows", () => {
    expect(modelRow(base)).toMatchObject({ action: "download", text: "102.8 MB" })
    expect(modelRow({ ...base, waitingForNetwork: true })).toMatchObject({ action: "downloadNow" })
    expect(modelRow({ ...base, state: "downloading", fraction: 0.5 })).toEqual({ text: "50%", progress: 0.5, action: "cancel" })
    expect(modelRow({ ...base, state: "ready" })).toMatchObject({ text: "Downloaded", action: "delete" })
    expect(modelRow({ ...base, state: "failed", error: "Could not download model" })).toMatchObject({ action: "retry", text: "Could not download model" })
  })
  it("formats sizes", () => {
    expect(formatBytes(65_045)).toBe("65 KB")
  })
})
