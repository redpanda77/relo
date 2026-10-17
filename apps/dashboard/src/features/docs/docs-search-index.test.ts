import { describe, expect, test } from "vitest"

import { searchDocs, type SearchPage } from "@/features/docs/docs-search-index"

const pages: SearchPage[] = [
  { path: "/docs/guides/hooks", title: "Session hooks", section: "Guides", summary: "Optional hooks remind your agents.",
    sections: [{ anchor: null, title: "Session hooks", text: "" }, { anchor: "turn-hooks-on", title: "Turn hooks on", text: "Run relo setup with a level." }] },
  { path: "/docs/guides/scripts", title: "Scripts, cron and CI", section: "Guides", summary: "Your jobs report progress.",
    sections: [{ anchor: null, title: "Scripts, cron and CI", text: "A nightly backup runs with nobody watching, and hooks are not needed." }] },
]

describe("docs search", () => {
  test("a page title outranks a heading, which outranks body text; every word must match", () => {
    const results = searchDocs(pages, "hooks")
    expect(results.map((result) => result.href)).toEqual(["/docs/guides/hooks", "/docs/guides/hooks#turn-hooks-on", "/docs/guides/scripts"])
    expect(searchDocs(pages, "hooks level").map((result) => result.href)).toEqual(["/docs/guides/hooks#turn-hooks-on"])
    expect(searchDocs(pages, "   ")).toEqual([])
  })

  test("a snippet starts at a word", () => {
    const [result] = searchDocs(pages, "needed")
    expect(result.snippet.startsWith("…")).toBe(true)
    expect(result.snippet).toMatch(/^…[a-z]+ /u)
    expect(result.snippet).toContain("needed")
  })
})
