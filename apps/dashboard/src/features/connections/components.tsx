import {
  ChevronRight,
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
import { Page } from "@/components/page"
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
    <Page title={bootstrap.shell.title} actions={actions}>
      {children}
    </Page>
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
    <ul
      className="glass divide-y divide-border overflow-hidden rounded-2xl"
      aria-label={ariaLabel}
    >
      {children}
    </ul>
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
    <details className="group/disclosure" open={open}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 px-4 pb-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronRight
          className="size-4 transition-transform group-open/disclosure:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="px-4 pb-5">{children}</div>
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
