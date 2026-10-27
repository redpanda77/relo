import { Smartphone, Trash2 } from "lucide-react"
import * as React from "react"

import { Empty, Section } from "@/components/list"
import { seenDot } from "@/lib/machine-seen"
import { MachineCard, MachineList } from "@/components/molecules/machine-card"
import { DestructiveAction } from "@/components/molecules/confirmation-action"
import { OperationStatus } from "@/components/molecules/operation-status"
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
    <MachineCard
      busy={pending}
      glyph={Smartphone}
      name={phone.name}
      dot={state === "Ready" ? seenDot(phone.lastSeenAt) : "amber"}
      summary={`${state} \u00b7 ${phone.model} \u00b7 iOS ${phone.osVersion}${phone.lastSeenAt ? ` \u00b7 Last seen ${relativeTime(phone.lastSeenAt)}` : ""}`}
      note={error || pending ? <OperationStatus pending={pending} error={error} pendingLabel="Removing phone…" className="text-xs" /> : undefined}
      actions={
        <DestructiveAction
          label="Remove"
          title={`Remove ${phone.name}?`}
          description="It is signed out and can no longer read anything. Cards only it could open are deleted. Sign in on the phone again to reconnect it."
          pending={pending}
          failed={Boolean(error)}
          pendingLabel="Removing phone…"
          size="sm"
          icon={<Trash2 aria-hidden="true" />}
          compact
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
      }
    />
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
      id="phones"
      title="Phones"
      count={phones.length || undefined}
      description={
        <>
          To add an iPhone, open Relo on it and tap Sign in. Approvals and encryption are in{" "}
          <a href="/dashboard/account#devices" className="text-primary underline-offset-4 hover:underline">Devices</a>.
        </>
      }
    >
      {phones.length ? (
        <MachineList label="Phones" items={phones} getKey={(phone) => phone.id}>
          {(phone) => (
            <PhoneRow
              phone={phone}
              api={api}
              onRevoke={(id) => setPhones((current) => current.filter((item) => item.id !== id))}
            />
          )}
        </MachineList>
      ) : (
        <Empty eyebrow="Phones" title="No phones yet" description="To add an iPhone, open Relo on it and tap Sign in." />
      )}
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
