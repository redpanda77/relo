import { Smartphone } from "lucide-react"
import * as React from "react"

import { Empty, Section } from "@/components/page"
import {
  ConnectionList,
  DestructiveAction,
  OperationStatus,
} from "@/features/connections/components"
import type { ConnectionPhone } from "@/features/connections/types"
import type { ConnectionsService } from "@/services/connections-service"
import { relativeTime } from "@/lib/format"

function readiness(phone: ConnectionPhone): string {
  const notifications = ["authorized", "provisional"].includes(phone.notificationAuthorization)
  const activities = phone.liveActivityAuthorization === "authorized"
  if (notifications && activities) return "Ready"
  if (!notifications && !activities) return "Notifications and Live Activities off"
  return notifications ? "Live Activities off" : "Notifications off"
}

function PhoneRow({
  phone,
  api,
  onRevoke,
}: {
  phone: ConnectionPhone
  api: ConnectionsService
  onRevoke(id: string): void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const state = readiness(phone)
  return (
    <li aria-busy={pending} className="px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{phone.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {phone.model} · iOS {phone.osVersion}
            {phone.lastSeenAt ? ` · seen ${relativeTime(phone.lastSeenAt)}` : ""}
          </p>
        </div>
        <span className={`hidden text-xs sm:inline ${state === "Ready" ? "text-[var(--status-success)]" : "text-[var(--status-warning)]"}`}>
          {state}
        </span>
        <DestructiveAction
          label="Remove"
          title={`Remove ${phone.name}?`}
          description="It is signed out and can no longer read anything. Cards only it could open are deleted. Sign in on the phone again to reconnect it."
          pending={pending}
          onConfirm={() => {
            setPending(true)
            setError(null)
            void api
              .revokePhone(phone.id)
              .then(() => onRevoke(phone.id))
              .catch((cause) => setError(cause instanceof Error ? cause.message : "Request failed."))
              .finally(() => setPending(false))
          }}
        />
      </div>
      <OperationStatus pending={pending} error={error} pendingLabel="Removing phone…" />
    </li>
  )
}

export function PhonesSection({
  initial,
  total,
  api,
}: {
  total: number
  initial: ConnectionPhone[]
  api: ConnectionsService
}) {
  const [phones, setPhones] = React.useState(initial)
  return (
    <Section
      title="Phones"
      action={
        <p className="text-xs text-muted-foreground">
          To add an iPhone, open Relo on it and tap Sign in. Approvals and encryption:{" "}
          <a href="/dashboard/account#devices" className="text-primary underline-offset-4 hover:underline">Devices</a>.
        </p>
      }
    >
      {phones.length ? (
        <ConnectionList ariaLabel="Phones">
          {phones.map((phone) => (
            <PhoneRow
              key={phone.id}
              phone={phone}
              api={api}
              onRevoke={(id) => setPhones((current) => current.filter((item) => item.id !== id))}
            />
          ))}
        </ConnectionList>
      ) : (
        <Empty title="No phones yet" description="To add an iPhone, open Relo on it and tap Sign in." />
      )}
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
