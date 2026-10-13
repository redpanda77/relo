import { ChevronRight } from "lucide-react"
import type * as React from "react"

import { semanticStatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/** One page frame for every dashboard route: a title, optional actions, content. */
export function Page({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: string
  /** One line under the title saying what the page holds. */
  eyebrow?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="canvas min-h-[100dvh] px-4 py-6 outline-none sm:px-8 sm:py-8 lg:px-12 lg:py-12"
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[2rem] leading-tight font-bold tracking-tight text-balance sm:text-[2.375rem]">
              {title}
            </h1>
            {eyebrow ? <p className="mt-1 text-sm text-muted-foreground">{eyebrow}</p> : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
        <div className="mt-8 space-y-10">{children}</div>
      </div>
    </main>
  )
}

export function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const id = `section-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="micro">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A frosted list: rows separated by hairlines, never cards inside cards. */
export function List({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <ul
      aria-label={label}
      className="glass divide-y divide-white/[0.06] overflow-hidden rounded-[20px]"
    >
      {children}
    </ul>
  )
}

export function Row({
  href,
  onClick,
  leading,
  title,
  meta,
  trailing,
  children,
  label,
}: {
  href?: string
  onClick?: () => void
  leading?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  trailing?: React.ReactNode
  children?: React.ReactNode
  label?: string
}) {
  const interactive = Boolean(href || onClick)
  const body = (
    <>
      {leading ? <span className="mt-0.5 shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {meta ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {trailing}
        </span>
      ) : null}
      {interactive ? (
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      ) : null}
    </>
  )
  const rowClass =
    "group flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition-colors"
  return (
    <li>
      {href ? (
        <a
          href={href}
          aria-label={label}
          className={cn(rowClass, "hover:bg-accent focus-visible:bg-accent")}
        >
          {body}
        </a>
      ) : onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(rowClass, "hover:bg-accent focus-visible:bg-accent")}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {children}
    </li>
  )
}

const toneClass: Record<ReturnType<typeof semanticStatusTone>, string> = {
  success: "bg-[var(--status-success)]",
  active: "bg-[var(--status-active)] shadow-[0_0_10px_var(--status-active)]",
  warning: "bg-[var(--status-warning)]",
  danger: "bg-[var(--status-danger)]",
  info: "bg-[var(--status-info)]",
  neutral: "bg-[var(--status-neutral)]",
}

/** State as a colored dot plus its word; color is never the only cue. */
export function Status({ value }: { value: string }) {
  const tone = semanticStatusTone(value)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap capitalize">
      <span
        className={cn("size-1.5 rounded-full", toneClass[tone])}
        aria-hidden="true"
      />
      {value.replaceAll("_", " ")}
    </span>
  )
}

export function Empty({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div className="glass flex flex-col items-center rounded-[20px] px-6 py-12 text-center">
      <span aria-hidden="true" className="brand-orb mb-4 size-10 opacity-80" />
      <p className="text-base font-semibold">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  )
}
