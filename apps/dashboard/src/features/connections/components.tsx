import {
  Cable,
  ChevronRight,
  KeyRound,
  Link2,
  Smartphone,
  type LucideIcon,
} from "lucide-react"
import type * as React from "react"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import type {
  ConnectionsDashboardBootstrap,
  ConnectionsPagination,
} from "@/features/connections/types"

export function ConnectionsPageFrame({
  bootstrap,
  actions,
  children,
}: {
  bootstrap: ConnectionsDashboardBootstrap
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="canvas min-h-[100dvh] px-4 py-7 sm:px-6 lg:px-10 lg:py-10"
    >
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
              {bootstrap.shell.title}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {bootstrap.shell.description}
            </p>
          </div>
          {actions}
        </header>
        <ConnectionsTabs bootstrap={bootstrap} />
        {children}
      </div>
    </main>
  )
}

function ConnectionsTabs({
  bootstrap,
}: {
  bootstrap: ConnectionsDashboardBootstrap
}) {
  const items = [
    {
      id: "connections-pairing",
      label: "Pair iPhone",
      description: "Secure QR setup",
      href: "/dashboard/connections/pairing",
      icon: Link2,
      value: "Setup",
    },
    {
      id: "connections-services",
      label: "Services",
      description: "Webhook senders",
      href: "/dashboard/connections/services",
      icon: Cable,
      value: String(bootstrap.summary.services),
    },
    {
      id: "connections-phones",
      label: "Phones",
      description: "Registered devices",
      href: "/dashboard/connections/phones",
      icon: Smartphone,
      value: String(bootstrap.summary.phones),
    },
    {
      id: "connections-clients",
      label: "CLI clients",
      description: "Agent credentials",
      href: "/dashboard/connections/clients",
      icon: KeyRound,
      value: String(bootstrap.summary.clients),
    },
  ] as const
  return (
    <nav aria-label="Connections views" className="mt-7">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {items.map((item) => {
          const active = bootstrap.shell.active === item.id
          const Icon = item.icon
          return (
            <a
              key={item.id}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`group grid min-h-[76px] grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 ring-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                active
                  ? "bg-accent text-foreground ring-primary/35"
                  : "bg-card/65 text-muted-foreground ring-foreground/10 hover:bg-card hover:text-foreground"
              }`}
            >
              <span
                className={`grid size-9 place-items-center rounded-[10px] ${
                  active
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground group-hover:text-foreground"
                }`}
                aria-hidden="true"
              >
                <Icon className="size-4.5" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-sm font-medium text-foreground">
                  {item.label}
                </strong>
                <span className="mt-0.5 block truncate text-xs">
                  {item.description}
                </span>
              </span>
              <span
                className={`hidden text-xs font-medium tabular-nums sm:inline ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                {item.value}
              </span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}

export function ConnectionsSectionHeader({
  id,
  title,
  description,
  action,
}: {
  id?: string
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  )
}

export function ConnectionList({
  children,
  ariaLabel,
}: {
  children: React.ReactNode
  ariaLabel: string
}) {
  return (
    <div
      className="overflow-hidden rounded-xl bg-card/80 ring-1 ring-foreground/10"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  )
}

export function ConnectionIconTile({
  icon: Icon,
  tone = "neutral",
}: {
  icon: LucideIcon
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    success:
      "bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)] text-[var(--status-success)]",
    warning:
      "bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)] text-[var(--status-warning)]",
    danger: "bg-destructive/10 text-destructive",
    info: "bg-primary/12 text-primary",
  }
  return (
    <span
      className={`grid size-10 shrink-0 place-items-center rounded-xl ${tones[tone]}`}
      aria-hidden="true"
    >
      <Icon className="size-5" />
    </span>
  )
}

export function ConnectionState({
  label,
  tone = "neutral",
}: {
  label: string
  tone?: "neutral" | "success" | "warning" | "danger"
}) {
  const tones = {
    neutral: "text-muted-foreground before:bg-muted-foreground",
    success: "text-[var(--status-success)] before:bg-[var(--status-success)]",
    warning: "text-[var(--status-warning)] before:bg-[var(--status-warning)]",
    danger: "text-destructive before:bg-destructive",
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium capitalize before:size-1.5 before:rounded-full ${tones[tone]}`}
    >
      {label}
    </span>
  )
}

export function ConnectionDisclosure({
  label,
  children,
  open = false,
}: {
  label: string
  children: React.ReactNode
  open?: boolean
}) {
  return (
    <details className="group/disclosure border-t border-border" open={open}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-muted-foreground outline-none hover:bg-accent/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5 [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronRight
          className="size-4 transition-transform group-open/disclosure:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border bg-background/25 px-4 py-5 sm:px-5">
        {children}
      </div>
    </details>
  )
}

export function ConnectionsPager({
  pagination,
}: {
  pagination: ConnectionsPagination
}) {
  if (pagination.pageCount <= 1) return null
  return (
    <div className="mt-6 flex flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
      <span>
        Page {pagination.page} of {pagination.pageCount} · {pagination.total}{" "}
        total
      </span>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            {pagination.previousHref ? (
              <PaginationPrevious
                href={pagination.previousHref}
                className="min-h-11"
              />
            ) : (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled
                aria-label="No previous page"
              >
                Previous
              </Button>
            )}
          </PaginationItem>
          <PaginationItem>
            {pagination.nextHref ? (
              <PaginationNext href={pagination.nextHref} className="min-h-11" />
            ) : (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled
                aria-label="No next page"
              >
                Next
              </Button>
            )}
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

export function OperationStatus({
  pending,
  error,
  pendingLabel,
}: {
  pending: boolean
  error: string | null
  pendingLabel: string
}) {
  if (!pending && !error) return null
  return (
    <p
      role={error ? "alert" : "status"}
      aria-live="polite"
      className={
        error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {error ?? pendingLabel}
    </p>
  )
}

export function ConfirmationAction({
  label,
  title,
  description,
  pending,
  onConfirm,
  variant = "destructive",
}: {
  label: string
  title: string
  description: string
  pending: boolean
  onConfirm(): void
  variant?: "default" | "outline" | "destructive"
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          className="min-h-11"
          disabled={pending}
        >
          {pending ? "Working…" : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            className="min-h-11"
            onClick={onConfirm}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DestructiveAction(
  props: React.ComponentProps<typeof ConfirmationAction>
) {
  return <ConfirmationAction {...props} variant="destructive" />
}
