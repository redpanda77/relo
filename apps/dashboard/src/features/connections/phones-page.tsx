import { Smartphone, Trash2 } from "lucide-react"
import * as React from "react"

import { IconTile } from "@/components/atoms/icon-tile"
import { StatusDot } from "@/components/atoms/status-dot"
import { Empty, List, Row, Section } from "@/components/list"
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
    <Row
      busy={pending}
      wrap
      leading={<IconTile icon={Smartphone} />}
      title={phone.name}
      status={<StatusDot tone={state === "Ready" ? "mint" : "yellow"} label={state} />}
      meta={
        <>
          {phone.model} · iOS {phone.osVersion}
          {phone.lastSeenAt ? ` · seen ${relativeTime(phone.lastSeenAt)}` : ""}
        </>
      }
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
    >
      <OperationStatus pending={pending} error={error} pendingLabel="Removing phone…" className="px-4 pb-3 text-xs" />
    </Row>
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
      <List
        label="Phones"
        items={phones}
        getKey={(phone) => phone.id}
        empty={<Empty icon={<Smartphone />} title="No phones yet" description="To add an iPhone, open Relo on it and tap Sign in." />}
      >
        {(phone) => (
          <PhoneRow
            phone={phone}
            api={api}
            onRevoke={(id) => setPhones((current) => current.filter((item) => item.id !== id))}
          />
        )}
      </List>
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
