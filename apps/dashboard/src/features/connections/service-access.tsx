import { LockOpen, ShieldCheck } from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/card"
import { ActionButton } from "@/components/molecules/action-button"
import { OperationStatus } from "@/components/molecules/operation-status"
import {
  SERVICE_SCOPES,
  type ConnectionService,
  type ServiceScope,
} from "@/features/connections/types"
import type { ServiceAccess } from "@/services/connections-service"

/** The scope registry's `hooks:*` family in the owner's words (docs/site/guides/apps.md). */
const SERVICE_SCOPE_COPY: Record<
  ServiceScope,
  { label: string; detail: string }
> = {
  "hooks:notify": {
    label: "Send notifications",
    detail: "Notices and questions to your phones, and managing its own events.",
  },
  "hooks:cards": {
    label: "Post Live Activity cards",
    detail: "Starts, updates and ends its own cards.",
  },
  "hooks:works": {
    label: "Report work",
    detail: "Starts, updates and finishes its own works.",
  },
  "hooks:read": {
    label: "Read its own items",
    detail: "Its own events and the answers to its questions.",
  },
}

/** The row's quiet chip for a service allowed to send readable content on an encrypted account. */
export function ReadableChip() {
  return (
    <Badge
      tone="yellow"
      variant="hairline"
      icon={<LockOpen className="size-3" aria-hidden="true" />}
      label="Readable: may send readable content when encryption is required"
    >
      Readable
    </Badge>
  )
}

function sameScopes(left: ServiceScope[], right: ServiceScope[]) {
  return left.length === right.length && left.every((scope) => right.includes(scope))
}

/** Server refusals arrive as codes; the owner reads words. */
function plainError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ""
  if (message === "not_found")
    return "This webhook no longer exists. Reload the page to see your current webhooks."
  if (!message || /^[a-z_]+$/.test(message) || message.startsWith("["))
    return "Relo could not save these settings. Check your connection and try again."
  return message
}

/**
 * What one webhook service may do and whether it may send readable content. The owner changes a draft;
 * the row's settings change only after the server accepts them.
 */
export function ServiceAccessControl({
  service,
  onSave,
}: {
  service: Pick<ConnectionService, "id" | "title" | "readableAllowed" | "scopes">
  onSave(change: Partial<ServiceAccess>): Promise<void>
}) {
  const [scopes, setScopes] = React.useState<ServiceScope[]>(service.scopes)
  const [readable, setReadable] = React.useState(service.readableAllowed)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)

  const scopesChanged = !sameScopes(scopes, service.scopes)
  const readableChanged = readable !== service.readableAllowed
  const changed = scopesChanged || readableChanged
  const id = `service-access-${service.id}`
  const lastScopeNote = `${id}-last`

  function toggle(scope: ServiceScope, checked: boolean) {
    setSuccess(null)
    setScopes((current) =>
      checked
        ? SERVICE_SCOPES.filter((item) => item === scope || current.includes(item))
        : current.filter((item) => item !== scope)
    )
  }

  async function save() {
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      await onSave({
        ...(scopesChanged ? { scopes } : {}),
        ...(readableChanged ? { readableAllowed: readable } : {}),
      })
      setSuccess("Access saved.")
    } catch (cause) {
      setError(plainError(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      aria-labelledby={`${id}-title`}
      aria-busy={pending || undefined}
      className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !pending) void save()
      }}
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">
            Access
          </h3>
          <p className="mt-0.5 max-w-[65ch] text-sm text-muted-foreground">
            What {service.title} may do with its secret.
          </p>
        </div>
      </div>

      <fieldset className="mt-4 min-w-0" disabled={pending}>
        <legend className="text-sm font-medium text-foreground">What it may do</legend>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {SERVICE_SCOPES.map((scope) => {
            const checked = scopes.includes(scope)
            const last = checked && scopes.length === 1
            const copy = SERVICE_SCOPE_COPY[scope]
            return (
              <label
                key={scope}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent"
              >
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                  checked={checked}
                  disabled={last}
                  aria-describedby={last ? lastScopeNote : `${id}-${scope}-detail`}
                  onChange={(event) => toggle(scope, event.currentTarget.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{copy.label}</span>
                  <span id={`${id}-${scope}-detail`} className="block text-xs text-muted-foreground">
                    {copy.detail}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        {scopes.length === 1 ? (
          <p id={lastScopeNote} className="mt-2 px-2 text-xs text-muted-foreground">
            A webhook keeps at least one permission. To stop it entirely, delete it.
          </p>
        ) : null}
      </fieldset>

      <div className="mt-4 border-t border-white/[0.06] pt-4">
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent">
          <input
            type="checkbox"
            role="switch"
            name="readableAllowed"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            checked={readable}
            disabled={pending}
            aria-describedby={`${id}-readable-detail`}
            onChange={(event) => {
              setSuccess(null)
              setReadable(event.currentTarget.checked)
            }}
          />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">
              May send readable content when encryption is required
            </span>
            <span id={`${id}-readable-detail`} className="block max-w-[65ch] text-xs text-muted-foreground">
              A service cannot seal end to end, so when your account requires encryption, Relo refuses its readable
              content unless you allow it here.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <OperationStatus
          pending={pending}
          error={error}
          success={changed ? null : success}
          pendingLabel="Saving access…"
        />
        <ActionButton
          type="submit"
          variant="outline"
          className="sm:ml-auto"
          disabled={!changed || pending}
          pending={pending}
          failed={Boolean(error)}
          pendingLabel="Saving…"
          successLabel="Saved"
        >
          Save access
        </ActionButton>
      </div>
    </form>
  )
}
