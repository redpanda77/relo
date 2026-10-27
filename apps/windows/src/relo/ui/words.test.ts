import { describe, expect, it } from "vitest"
import { answerButtons } from "../answers"
import { EMPTY, type Row } from "../presentation"
import { answerView, cardFacts } from "./open/logic"
import { dashboardUrl } from "./mode"
import { allClearWords, moreLine, offlineAnswer, offlineLabel, offlineSymbol, privateEarlierLine, textReply, unreadable, untitled } from "./words"

const row = (extra: Partial<Row> = {}): Row => ({
  id: "a", title: "A", status: "Doing it", project: null, source: null, tone: "needsYou", stepsDone: null, stepsTotal: null, currentStep: null,
  startedAt: 0, questionId: "q", notificationId: "n", questionPending: true, unreadable: false, questionMissed: false, computerIcon: null,
  declaredAt: 0, roundOutcome: null, outline: null, currentIndex: null, currentFill: null, ...extra,
})

describe("local mode's words on the Relo tab (LocalMode.swift, L15 L16 C30 P06 P11 P12)", () => {
  it("offline: the server says Offline with the crossed wifi, Relo on this PC says Not answering with the exclamation", () => {
    expect(offlineLabel(false)).toBe("Offline")
    expect(offlineLabel(true)).toBe("Not answering")
    expect(offlineSymbol(false)).toBe("wifiSlash")
    expect(offlineSymbol(true)).toBe("exclamation")
    expect(offlineAnswer(false)).toBe("Offline: answer on your iPhone")
    expect(offlineAnswer(true)).toBe("Relo isn't answering on this PC.")
  })

  it("all clear: title and detail for empty, connecting and offline, server and local", () => {
    expect(allClearWords({ local: false, offline: false, connecting: false })).toEqual({ title: "Nothing needs you", detail: "Running work shows up here as it starts." })
    expect(allClearWords({ local: false, offline: true, connecting: false })).toEqual({ title: "Relo is offline", detail: "The last state stays here until the server answers." })
    expect(allClearWords({ local: true, offline: true, connecting: false })).toEqual({ title: "Relo isn't answering on this PC.", detail: "The last state stays here until Relo answers." })
    expect(allClearWords({ local: false, offline: false, connecting: true }).title).toBe("Connecting to Relo…")
    expect(allClearWords({ local: true, offline: false, connecting: true }).title).toBe("Starting Relo…")
  })

  it("local words never mention a server, iPhone, account or Dashboard", () => {
    const local = [
      allClearWords({ local: true, offline: true, connecting: false }).title,
      allClearWords({ local: true, offline: true, connecting: false }).detail,
      allClearWords({ local: true, offline: false, connecting: true }).title,
      moreLine(3, true),
      offlineAnswer(true),
      textReply(true),
      unreadable(true),
      untitled(true),
    ].join(" ")
    expect(local).not.toMatch(/server|iphone|account|dashboard|sign in|encrypt/i)
  })

  it("+N more: a server adds the Dashboard, Relo on this PC does not", () => {
    expect(moreLine(2, false)).toBe("+2 more · Dashboard")
    expect(moreLine(2, true)).toBe("+2 more")
  })

  it("approvals read Yes and No on this PC, Approve and Deny with a server; the actions are the same", () => {
    const approval = { kind: "approval" as const }
    expect(answerButtons(approval).map((b) => b.label)).toEqual(["Approve", "Deny"])
    expect(answerButtons(approval, true).map((b) => b.label)).toEqual(["Yes", "No"])
    expect(answerButtons(approval, true).map((b) => b.action)).toEqual(["approve", "deny"])
    expect(answerButtons({ kind: "yesNo" }, true).map((b) => b.label)).toEqual(["Yes", "No"])
  })

  it("a free-text question hints where to reply, and has no buttons", () => {
    expect(answerView({ kind: "text" }, undefined, false, false)).toEqual({ kind: "text" })
    expect(answerView({ kind: "text" }, undefined, false, true)).toEqual({ kind: "text" })
    expect(textReply(false)).toBe("Reply on your iPhone or in the Dashboard")
    expect(textReply(true)).toBe("Reply in your terminal")
    expect(answerView({ kind: "approval" }, undefined, true, true)).toEqual({ kind: "offline" })
  })

  it("an unreadable card says so in the PC’s words", () => {
    const r = row({ unreadable: true, questionPending: false, questionId: null })
    expect(cardFacts(r, undefined, false, false).bodyText).toBe("Approve this PC on your iPhone to read it")
    expect(cardFacts(r, undefined, false, true).bodyText).toBe("Relo could not read this card.")
    expect(untitled(false)).toBe("Private work")
    expect(untitled(true)).toBe("Work")
  })

  it("sealed cards that are over are one count, not a list", () => {
    expect(privateEarlierLine(2)).toBe("2 private earlier")
    expect(EMPTY.privateEarlier).toBe(0)
  })
})

describe("the Dashboard link", () => {
  it("is the server’s /dashboard page, nothing without a server", () => {
    expect(dashboardUrl("https://relo.example.com")).toBe("https://relo.example.com/dashboard")
    expect(dashboardUrl("http://192.168.1.5:8180/")).toBe("http://192.168.1.5:8180/dashboard")
    expect(dashboardUrl(null)).toBeNull()
  })
})
