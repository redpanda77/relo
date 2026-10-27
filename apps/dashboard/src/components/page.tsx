import { ChevronRight } from "lucide-react"
import * as React from "react"

import { CompactBar, type PageBack } from "@/components/molecules/compact-bar"

export type { PageBack }

/**
 * The page's large title, as on iOS, with an optional one-line description. The h1 takes focus
 * after a client navigation (tabIndex -1), so a screen reader starts on the new page's name.
 */
export function PageTitle({ title, eyebrow, kicker = true }: { title: string; eyebrow?: string; kicker?: boolean }) {
  return (
    <div className="min-w-0">
      {kicker ? <p className="page-eyebrow" aria-hidden="true">{`RELO · ${title}`}</p> : null}
      <h1 className="page-title" tabIndex={-1}>
        {title}
      </h1>
      {eyebrow ? <p className="mt-1 text-sm text-muted-foreground">{eyebrow}</p> : null}
    </div>
  )
}

/** Desktop's way back from a detail page: a quiet trail above the title ("History › Notification"). */
function Breadcrumb({ back, title }: { back: PageBack; title: string }) {
  // The current crumb names the kind of page ("Activity") when the page's title is its content.
  return (
    <p className="page-breadcrumb">
      <a href={back.href} data-page-back="true">
        {back.label}
      </a>
      <ChevronRight aria-hidden="true" />
      <span aria-current="page">{title}</span>
    </p>
  )
}

/**
 * One page frame for every dashboard route: a title, optional actions, content. The frame is
 * left-aligned at the gutter, so the title sits in the same place on every page (Now's included).
 * On phones a compact bar takes over the title once it scrolls away; `back` puts a chevron in it
 * (phones) or a breadcrumb above the title (wider screens).
 */
export function Page({
  title,
  eyebrow,
  actions,
  back,
  trail,
  children,
}: {
  title: string
  /** One line under the title saying what the page holds. */
  eyebrow?: string
  actions?: React.ReactNode
  /** The parent page, for a detail page. */
  back?: PageBack
  /** The breadcrumb's current crumb when it is not the title ("History › Activity"). */
  trail?: string
  children: React.ReactNode
}) {
  const mainRef = React.useRef<HTMLElement>(null)
  return (
    <main
      ref={mainRef}
      id="main-content"
      tabIndex={-1}
      className="page canvas outline-none"
      data-has-back={back ? "true" : undefined}
    >
      <CompactBar title={title} back={back} scopeRef={mainRef} />
      <div className="page-frame w-full max-w-[1120px]">
        {back ? <Breadcrumb back={back} title={trail ?? title} /> : null}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <PageTitle title={title} eyebrow={eyebrow} />
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
        <div className="page-stack mt-8">{children}</div>
      </div>
    </main>
  )
}

/**
 * The iPhone's landscape layout for a wide window: the aside (a living deck) holds the left part,
 * still, while the content scrolls beside it. With less room (judged by the space the page really
 * has, so collapsing the sidebar can flip it) the aside leads and the content follows, as in
 * portrait. On phones the compact bar reads its title from the aside's h1.
 */
export function SplitPage({ aside, children }: { aside: React.ReactNode; children: React.ReactNode }) {
  const mainRef = React.useRef<HTMLElement>(null)
  return (
    <main ref={mainRef} id="main-content" tabIndex={-1} className="split-page canvas outline-none">
      <CompactBar scopeRef={mainRef} />
      <div className="split-page-grid">
        <div className="split-page-aside">{aside}</div>
        <div className="split-page-body page-stack">{children}</div>
      </div>
    </main>
  )
}

/** One entry of a page's section index: the section's anchor (`Section`'s `id`) and its title. */
export type IndexedSection = { id: string; title: string }

/**
 * A long settings-style page: on a wide window a sticky index of its sections beside them (each a
 * `Section` with that `id`); narrower, just the sections. Account and Connections share it.
 */
export function IndexedSections({
  label,
  sections,
  children,
}: {
  /** The index's landmark name ("Account sections"). */
  label: string
  sections: readonly IndexedSection[]
  children: React.ReactNode
}) {
  return (
    <div className="section-index-layout">
      <nav aria-label={label} className="section-index">
        <ul>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="page-stack min-w-0">{children}</div>
    </div>
  )
}
