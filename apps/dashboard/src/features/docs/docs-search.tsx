import { CornerDownLeft, FileText, Hash, Search } from "lucide-react"
import * as React from "react"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { loadIndex, searchDocs, type Result, type SearchPage } from "@/features/docs/docs-search-index"

export function DocsSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pages, setPages] = React.useState<SearchPage[] | null>(null)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState(0)
  React.useEffect(() => {
    if (open && !pages) void loadIndex().then(setPages)
  }, [open, pages])
  const results = React.useMemo(() => (pages ? searchDocs(pages, query) : []), [pages, query])

  const go = (result: Result | undefined) => {
    if (!result) return
    onOpenChange(false)
    window.location.assign(result.href)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected((index) => Math.min(index + 1, results.length - 1)) }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)) }
    if (event.key === "Enter") { event.preventDefault(); go(results[selected]) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="docs-search" showCloseButton={false} onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Search the docs</DialogTitle>
        <DialogDescription className="sr-only">Type to search every page; arrow keys choose, Enter opens.</DialogDescription>
        <label className="docs-search-field">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0) }}
            placeholder="Search the docs: hooks, relo work, callbacks…"
            aria-label="Search the docs"
            aria-controls="docs-search-results"
            aria-activedescendant={results[selected] ? `docs-result-${selected}` : undefined}
          />
          <kbd className="docs-kbd">Esc</kbd>
        </label>
        <ul id="docs-search-results" className="docs-search-results" role="listbox" aria-label="Results">
          {query && pages && !results.length ? <li className="docs-search-empty">Nothing matches “{query}”.</li> : null}
          {!pages && open ? <li className="docs-search-empty">Loading the index…</li> : null}
          {results.map((result, index) => (
            <li key={result.href} id={`docs-result-${index}`} role="option" aria-selected={index === selected}>
              <a href={result.href} onMouseEnter={() => setSelected(index)} onClick={(event) => { event.preventDefault(); go(result) }}>
                {result.heading ? <Hash className="size-4 shrink-0" aria-hidden="true" /> : <FileText className="size-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="docs-search-title">{result.title}</span>
                  <span className="docs-search-context">{result.context}</span>
                  {result.snippet ? <span className="docs-search-snippet">{result.snippet}</span> : null}
                </span>
                {index === selected ? <CornerDownLeft className="ml-auto size-4 shrink-0 opacity-60" aria-hidden="true" /> : null}
              </a>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
