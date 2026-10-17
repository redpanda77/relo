// The docs search index (/docs/search.json) and its scoring, kept apart from the dialog component.

export type SearchSection = { anchor: string | null; title: string; text: string }
export type SearchPage = { path: string; title: string; section: string; summary: string; sections: SearchSection[] }
export type Result = { href: string; title: string; context: string; snippet: string; score: number; heading: boolean }

let indexPromise: Promise<SearchPage[]> | undefined
/** The search index (/docs/search.json), fetched once, the first time search opens. */
export function loadIndex(): Promise<SearchPage[]> {
  indexPromise ??= fetch("/docs/search.json", { credentials: "omit" })
    .then((response) => (response.ok ? response.json() : { pages: [] }))
    .then((body: { pages: SearchPage[] }) => body.pages)
    .catch(() => {
      indexPromise = undefined
      return []
    })
  return indexPromise
}

/** Every word must appear; a match in a title counts most, then a heading, then the text. */
export function searchDocs(pages: SearchPage[], query: string, limit = 12): Result[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const results: Result[] = []
  for (const page of pages) {
    for (const [index, section] of page.sections.entries()) {
      const title = section.title.toLowerCase()
      const pageTitle = page.title.toLowerCase()
      const text = `${section.text} ${index === 0 ? page.summary : ""}`.toLowerCase()
      if (!words.every((word) => title.includes(word) || pageTitle.includes(word) || text.includes(word))) continue
      let score = 0
      for (const word of words) {
        if (pageTitle.includes(word)) score += index === 0 ? 8 : 2
        if (title.includes(word)) score += index === 0 ? 0 : 6
        if (text.includes(word)) score += 1
      }
      if (index === 0) score += 1
      const first = words.map((word) => text.indexOf(word)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0
      const source = `${section.text} ${index === 0 ? page.summary : ""}`.trim()
      // Start the snippet at a word, about 40 characters before the first match.
      const rough = Math.max(0, first - 40)
      const start = rough === 0 ? 0 : source.indexOf(" ", rough) + 1 || rough
      results.push({
        href: section.anchor ? `${page.path}#${section.anchor}` : page.path,
        title: index === 0 ? page.title : section.title,
        context: index === 0 ? page.section : `${page.section} › ${page.title}`,
        snippet: (start > 0 ? "…" : "") + source.slice(start, start + 140),
        score,
        heading: index !== 0,
      })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

