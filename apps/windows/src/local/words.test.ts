import { describe, expect, it } from "vitest"
import { allWords, LOCAL, offlineAnswer, offlineLabel, SETTINGS, SETUP, textReply, unreadable, untitled } from "./words"
import { buttonOf, closedLine, problemOf, titleOf } from "./LocalPanel"
import { runningLine, versionLine } from "./LocalSettings"

describe("local mode's words", () => {
  it("none mention an account, a server address, an iPhone or encryption", () => {
    const banned = [/account/i, /server address/i, /iphone/i, /encrypt/i, /sign[- ]?in/i, /password/i]
    for (const word of allWords()) {
      // Leaving for a server and the settings row that does it are about a server by nature; they still never say these.
      for (const b of banned) {
        if (word === SETTINGS.useAnotherDetail && b.source === "sign[- ]?in") continue
        expect(word, `${b}`).not.toMatch(b)
      }
    }
  })

  it("are the Mac's, with PC for Mac", () => {
    expect(LOCAL.needsRepair).toBe("Relo needs a quick repair on this PC.")
    expect(LOCAL.repair).toBe("Repair")
    expect(LOCAL.hoverToRepair).toBe("Relo · hover here to repair")
    expect(LOCAL.hoverStartFailed).toBe("Relo couldn't start · hover here")
    expect(LOCAL.startFailedTitle).toBe("Relo couldn't start on this PC")
    expect(LOCAL.notAnswering).toBe("Relo isn't answering on this PC.")
    expect(LOCAL.notAnsweringShort).toBe("Not answering")
    expect(LOCAL.starting).toBe("Starting Relo…")
    expect(LOCAL.replyInTerminal).toBe("Reply in your terminal")
    expect(untitled(true)).toBe("Work")
    expect(unreadable(true)).toBe("Relo could not read this card.")
    expect(offlineAnswer(true)).toBe("Relo isn't answering on this PC.")
    expect(textReply(true)).toBe("Reply in your terminal")
    expect(offlineLabel(true)).toBe("Not answering")
    expect(LOCAL.leaveConfirmation).toBe(
      "Relo on this PC stops. Your cards stay on this PC. To have your agents report to your server, add this PC in your server's Dashboard (Add a computer).",
    )
  })

  it("the setup's five steps and closing words are the Mac's", () => {
    expect(Object.values(SETUP.steps)).toEqual(["Starting Relo", "Choosing your agents", "Adding the relo command", "Setting up your agents", "Done"])
    expect(SETUP.runsHere).toBe("Relo runs on this PC. Nothing leaves it.")
    expect(SETUP.testCard).toBe("A test card is waiting in the notch: answer it there.")
    expect(SETUP.skipAgents).toBe("Skip agents for now")
    expect(SETUP.agentsNote).toBe("Relo adds a few lines to their instructions so they report here.")
    expect(SETUP.noAgents).toBe("No agents found yet. Install Claude Code or OpenCode, then choose Set up agents again in Settings.")
    expect(SETUP.tryAgain).toBe("Try again")
    expect(SETUP.showDetails).toBe("Show details")
  })

  it("the Settings group has the four rows", () => {
    expect(SETTINGS.group).toBe("Relo on this PC")
    expect([SETTINGS.setUpAgents, SETTINGS.useAnother, SETTINGS.uninstall, SETTINGS.showDetails]).toEqual([
      "Set up agents again", "Use another Relo server…", "Uninstall Relo from this PC…", "Show details",
    ])
    expect(runningLine({ phase: "running" })).toBe("Relo is running")
    expect(runningLine({ phase: "starting" })).toBe("Starting Relo…")
    expect(runningLine({ phase: "failed" })).toBe("Relo isn't running")
    expect(versionLine({ version: "0.2.32" })).toBe("Version 0.2.32")
    expect(versionLine({ version: null })).toBeUndefined()
  })
})

describe("what the notch says without work to show", () => {
  it("follows the server first, then the app's own link", () => {
    expect(problemOf({ phase: "starting" }, "live")).toBe("starting")
    expect(problemOf({ phase: "failed" }, "live")).toBe("startFailed")
    expect(problemOf({ phase: "foreign" }, "signedOut")).toBe("startFailed")
    expect(problemOf({ phase: "stopped" }, "offline")).toBe("notAnswering")
    expect(problemOf({ phase: "running" }, "connecting")).toBe("starting")
    expect(problemOf({ phase: "running" }, "signingIn")).toBe("starting")
    expect(problemOf({ phase: "running" }, "needsSignIn")).toBe("needsRepair")
    expect(problemOf({ phase: "running" }, "signedOut")).toBe("needsRepair")
  })

  it("has a title, a closed line and one button for each", () => {
    expect(titleOf("starting")).toBe("Starting Relo…")
    expect(buttonOf("starting")).toBeNull()
    expect(titleOf("startFailed")).toBe("Relo couldn't start on this PC")
    expect(buttonOf("startFailed")).toBe("Try again")
    expect(closedLine("startFailed")).toBe("Relo couldn't start · hover here")
    expect(titleOf("needsRepair")).toBe("Relo needs a quick repair on this PC.")
    expect(buttonOf("needsRepair")).toBe("Repair")
    expect(closedLine("needsRepair")).toBe("Relo · hover here to repair")
    expect(buttonOf("notAnswering")).toBe("Try again")
    expect(closedLine("notAnswering")).toBe("Not answering")
    expect(closedLine("starting")).toBe("Starting Relo…")
  })
})
