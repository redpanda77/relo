import { ArrowLeft, ArrowRight, Menu, Pencil, Search } from "lucide-react"
import * as React from "react"

import { BrandOrb } from "@/components/brand"
import { Badge } from "@/components/card"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { GITHUB_URL } from "@/features/auth/github"
import { DocsSearch } from "@/features/docs/docs-search"
import type { DocsSectionView, DocsSiteBootstrap } from "@/features/docs/types"

/**
 * The public docs layout (plan 08): the site header, a sidebar tree, the article the server rendered at
 * build time, an "On this page" outline that follows the reader, previous and next, and search. The same
 * classes as the server's no-JavaScript markup (apps/server/src/web/docs-site.ts), so taking over is seamless.
 */
export function DocsSite({ bootstrap }: { bootstrap: DocsSiteBootstrap }) {
  const { page } = bootstrap
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="docs">
      <a className="docs-skip" href="#docs-article">Skip to content</a>
      <header className="docs-header">
        <div className="docs-header-inner">
          <button type="button" className="docs-icon-button docs-menu-button" onClick={() => setMenuOpen(true)} aria-label="Docs menu">
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <a className="docs-brand" href="/" aria-label="Relo home">
            <BrandOrb className="size-7" />
            <span className="wordmark">relo</span>
          </a>
          <a className="docs-brand-section" href="/docs">Docs</a>
          <nav className="docs-top-links" aria-label="Site">
            <a href="/">Home</a>
            <a href="/docs/privacy">Privacy</a>
            <a href={GITHUB_URL} rel="external noopener">GitHub</a>
          </nav>
          <div className="docs-header-actions">
            <button type="button" className="docs-search-button" onClick={() => setSearchOpen(true)}>
              <Search className="size-4" aria-hidden="true" />
              <span className="docs-search-label">Search docs</span>
              <kbd className="docs-kbd">⌘K</kbd>
            </button>
            {bootstrap.viewer.signedIn ? (
              <a className="capsule-cta docs-cta" href="/dashboard">Open Dashboard</a>
            ) : (
              <a className="capsule-cta docs-cta" href="/sign-in">Sign in</a>
            )}
          </div>
        </div>
      </header>

      <div className="docs-body">
        <aside className="docs-sidebar" aria-label="Docs pages">
          <DocsNav sections={bootstrap.sections} current={bootstrap.route.path} />
        </aside>

        <main className="docs-main" id="docs-article" tabIndex={-1}>
          {page ? (
            <>
              {page.breadcrumbs.length ? (
                <nav className="docs-breadcrumbs" aria-label="Breadcrumbs">
                  <ol>
                    {page.breadcrumbs.map((crumb) => (
                      <li key={crumb.title}>{crumb.path ? <a href={crumb.path}>{crumb.title}</a> : <span>{crumb.title}</span>}</li>
                    ))}
                  </ol>
                </nav>
              ) : null}
              <header className="docs-page-header">
                <h1>{page.title}</h1>
                <p className="docs-lede">{page.summary}</p>
              </header>
              {page.outline.length > 2 ? <MobileOutline outline={page.outline} /> : null}
              <Article html={page.html} />
              <nav className="docs-pager" aria-label="Previous and next">
                {page.prev ? (
                  <a className="docs-pager-link" rel="prev" href={page.prev.path}>
                    <span className="micro"><ArrowLeft className="inline size-3" aria-hidden="true" /> Previous</span>
                    {page.prev.title}
                  </a>
                ) : <span />}
                {page.next ? (
                  <a className="docs-pager-link" data-next rel="next" href={page.next.path}>
                    <span className="micro">Next <ArrowRight className="inline size-3" aria-hidden="true" /></span>
                    {page.next.title}
                  </a>
                ) : null}
              </nav>
              <footer className="docs-page-footer">
                <a href={page.editUrl} rel="external noopener"><Pencil className="size-3.5" aria-hidden="true" /> Edit this page on GitHub</a>
                <Badge tone="neutral" variant="hairline" mono icon={null}>CLI {bootstrap.release.cli}</Badge>
                <Badge tone="neutral" variant="hairline" mono icon={null}>server {bootstrap.release.server.split("+")[0]}</Badge>
              </footer>
            </>
          ) : (
            <header className="docs-page-header">
              <h1>Page not found</h1>
              <p className="docs-lede">
                There is no docs page at this address. <button type="button" className="docs-inline-button" onClick={() => setSearchOpen(true)}>Search the docs</button> or start from the <a href="/docs">docs home</a>.
              </p>
            </header>
          )}
        </main>

        {page && page.outline.length ? <Outline outline={page.outline} /> : null}
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="docs-sheet">
          <SheetTitle className="micro px-5 pt-5">Docs</SheetTitle>
          <nav className="docs-sheet-links" aria-label="Site">
            <a href="/">Home</a>
            <a href={GITHUB_URL} rel="external noopener">GitHub</a>
            {bootstrap.viewer.signedIn ? <a href="/dashboard">Open Dashboard</a> : <a href="/sign-in">Sign in</a>}
          </nav>
          <DocsNav sections={bootstrap.sections} current={bootstrap.route.path} />
        </SheetContent>
      </Sheet>
      <DocsSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}

function NavLink({ path, title, current }: { path: string; title: string; current: string }) {
  return (
    <a className="docs-nav-link" href={path} aria-current={path === current ? "page" : undefined}>
      {title}
    </a>
  )
}

export function DocsNav({ sections, current }: { sections: DocsSectionView[]; current: string }) {
  const ref = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" })
  }, [])
  return (
    <nav ref={ref}>
      {sections.map((section) => (
        <div className="docs-nav-section" key={section.title}>
          <p className="docs-nav-title">
            {section.path ? <a href={section.path} aria-current={section.path === current ? "page" : undefined}>{section.title}</a> : section.title}
          </p>
          {section.pages.length ? (
            <ul>{section.pages.map((item) => <li key={item.path}><NavLink {...item} current={current} /></li>)}</ul>
          ) : null}
          {section.groups.map((group) => (
            <React.Fragment key={group.title}>
              <p className="docs-nav-group">{group.title}</p>
              <ul>{group.pages.map((item) => <li key={item.path}><NavLink {...item} current={current} /></li>)}</ul>
            </React.Fragment>
          ))}
        </div>
      ))}
    </nav>
  )
}

/** The article, plus what only a browser adds: copy buttons on code. */
function Article({ html }: { html: string }) {
  const ref = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll<HTMLButtonElement>("button.docs-copy").forEach((button) => { button.hidden = false })
    const onClick = async (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.docs-copy")
      if (!button) return
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "")
        button.textContent = "Copied"
      } catch {
        button.textContent = "Select and copy"
      }
      window.setTimeout(() => { button.textContent = "Copy" }, 1600)
    }
    root.addEventListener("click", onClick)
    return () => root.removeEventListener("click", onClick)
  }, [html])
  return <article ref={ref} className="docs-prose" dangerouslySetInnerHTML={{ __html: html }} />
}

type OutlineItem = { id: string; text: string; level: number }

/** The heading the reader is in: the last one above a line a quarter of the way down the window. */
function useActiveHeading(outline: OutlineItem[]) {
  const [active, setActive] = React.useState(outline[0]?.id)
  React.useEffect(() => {
    const onScroll = () => {
      const line = window.innerHeight * 0.25
      let current = outline[0]?.id
      for (const item of outline) {
        const element = document.getElementById(item.id)
        if (element && element.getBoundingClientRect().top <= line) current = item.id
      }
      setActive(current)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [outline])
  return active
}

function Outline({ outline }: { outline: OutlineItem[] }) {
  const active = useActiveHeading(outline)
  return (
    <aside className="docs-outline" aria-label="On this page">
      <p className="micro">On this page</p>
      <ul>
        {outline.map((item) => (
          <li key={item.id} data-level={item.level}>
            <a href={`#${item.id}`} aria-current={item.id === active ? "location" : undefined}>{item.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function MobileOutline({ outline }: { outline: OutlineItem[] }) {
  return (
    <details className="docs-outline-mobile">
      <summary>On this page</summary>
      <ul>
        {outline.map((item) => (
          <li key={item.id} data-level={item.level}><a href={`#${item.id}`}>{item.text}</a></li>
        ))}
      </ul>
    </details>
  )
}
