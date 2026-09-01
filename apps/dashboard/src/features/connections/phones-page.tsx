import { Radio, Smartphone } from "lucide-react"
import * as React from "react"

import { Card, CardContent } from "@/components/ui/card"
import {
  ConnectionIconTile,
  ConnectionList,
  ConnectionState,
  ConnectionsPageFrame,
  ConnectionsPager,
  ConnectionsSectionHeader,
  DestructiveAction,
  OperationStatus,
} from "@/features/connections/components"
import type {
  ConnectionPhone,
  ConnectionsPhones,
} from "@/features/connections/types"
import { formatConnectionDate } from "@/features/connections/utils"
import type { ConnectionsService } from "@/services/connections-service"

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
  const notificationReady = ["authorized", "provisional"].includes(
    phone.notificationAuthorization
  )
  const activityReady = phone.liveActivityAuthorization === "authorized"

  return (
    <article
      aria-busy={pending}
      className="border-b border-border px-4 py-4 last:border-b-0 sm:px-5"
    >
      <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start">
        <ConnectionIconTile
          icon={Smartphone}
          tone={notificationReady && activityReady ? "success" : "warning"}
        />
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold">{phone.name}</h3>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {phone.id}
          </p>
        </div>
        <div className="col-start-2 flex flex-wrap gap-x-3 gap-y-1 sm:col-start-auto sm:justify-end">
          <ConnectionState
            label={`Notifications ${phone.notificationAuthorization}`}
            tone={notificationReady ? "success" : "warning"}
          />
          <ConnectionState
            label={`Live Activity ${phone.liveActivityAuthorization}`}
            tone={activityReady ? "success" : "warning"}
          />
        </div>
      </div>
      <dl className="mt-4 grid gap-px overflow-hidden rounded-xl bg-border text-sm sm:grid-cols-3">
        {[
          ["Hardware", phone.model],
          ["Software", `iOS ${phone.osVersion} · app ${phone.appVersion}`],
          ["Last seen", formatConnectionDate(phone.lastSeenAt)],
        ].map(([label, value]) => (
          <div key={label} className="bg-background/55 px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 truncate font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <OperationStatus
          pending={pending}
          error={error}
          pendingLabel="Revoking phone and canceling queued delivery…"
        />
        <div className="ml-auto">
          <DestructiveAction
            label="Revoke phone"
            title={`Revoke ${phone.name}?`}
            description="This revokes its credentials, clears push tokens, and cancels queued delivery for this phone."
            pending={pending}
            onConfirm={() => {
              setPending(true)
              setError(null)
              void api
                .revokePhone(phone.id)
                .then(() => onRevoke(phone.id))
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : "Request failed."
                  )
                )
                .finally(() => setPending(false))
            }}
          />
        </div>
      </div>
    </article>
  )
}

export function PhonesPage({
  initial,
  api,
}: {
  initial: ConnectionsPhones
  api: ConnectionsService
}) {
  const [phones, setPhones] = React.useState(initial.phones)
  return (
    <ConnectionsPageFrame bootstrap={initial}>
      <section className="mt-7 space-y-5" aria-labelledby="phones-heading">
        <ConnectionsSectionHeader
          id="phones-heading"
          title="Registered phones"
          description="Delivery readiness and recent contact for every iPhone connected to this server."
        />
        {phones.length ? (
          <ConnectionList ariaLabel="Registered phones">
            {phones.map((phone) => (
              <PhoneRow
                key={phone.id}
                phone={phone}
                api={api}
                onRevoke={(id) =>
                  setPhones((current) =>
                    current.filter((item) => item.id !== id)
                  )
                }
              />
            ))}
          </ConnectionList>
        ) : (
          <Card>
            <CardContent className="flex min-h-36 flex-col items-center justify-center text-center">
              <Radio
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 font-medium">No registered iPhones yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                A phone appears here after completing account registration.
              </p>
            </CardContent>
          </Card>
        )}
        <ConnectionsPager pagination={initial.pagination} />
      </section>
    </ConnectionsPageFrame>
  )
}
