// What the header and the card read from Settings: tabs always or only when there is more than one, the gear in the
// notch, the card's play button, and the interface cues of a card opening or folding.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { presentationOf, type Row } from "../../presentation"
import { fixtureSummary } from "../../testing"
import type { TabEntry } from "../../tabs"
import { WorkCard } from "../Card"
import { HeaderView } from "./Header"
import { toggleCue } from "./logic"

const html = (el: React.ReactElement) => renderToStaticMarkup(el)
const row = (): Row => presentationOf(fixtureSummary()).sections.flatMap((s) => s.rows)[0]!
const tab = (id: string): TabEntry => ({ id, label: id, icon: null, view: null, height: 190, visible: () => true, subscribeVisible: null })
const header = (over: Partial<Parameters<typeof HeaderView>[0]>) => html(createElement(HeaderView, { current: "relo", onSelect: () => {}, list: [tab("relo"), tab("system")], ...over }))

describe("header", () => {
  it("shows the tabs and the gear by default", () => {
    const h = header({ onSettings: () => {} })
    expect(h).toContain('role="tab"')
    expect(h).toContain('aria-label="Settings"')
  })

  it("leaves the gear out when the settings icon is off (no onSettings)", () => {
    expect(header({})).not.toContain('aria-label="Settings"')
  })

  it("with always-show-tabs off, a single tab hides the row and more than one brings it back", () => {
    expect(header({ alwaysShowTabs: false, list: [tab("relo")] })).not.toContain('role="tab"')
    expect(header({ alwaysShowTabs: true, list: [tab("relo")] })).toContain('role="tab"')
    expect(header({ alwaysShowTabs: false })).toContain('role="tab"')
  })
})

describe("card play button", () => {
  const props = { row: row(), questions: {}, answers: {}, onAnswer: () => Promise.resolve(), onToggle: () => {} }
  it("is absent without the voice button setting", () => {
    expect(html(createElement(WorkCard, props))).not.toContain("Say this card")
  })
  it("shows on a card with a line to say, not on one without", () => {
    expect(html(createElement(WorkCard, { ...props, voice: { canPlay: () => true, play: () => {} } }))).toContain('aria-label="Say this card"')
    expect(html(createElement(WorkCard, { ...props, voice: { canPlay: () => false, play: () => {} } }))).not.toContain("Say this card")
  })
})

describe("expand and collapse cues", () => {
  it("opening any card is expand, folding the open one is collapse", () => {
    expect(toggleCue(null, "a")).toBe("expand")
    expect(toggleCue("a", "b")).toBe("expand")
    expect(toggleCue("a", "a")).toBe("collapse")
  })
})
