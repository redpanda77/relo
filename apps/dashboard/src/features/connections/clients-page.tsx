import { TerminalSquare } from "lucide-react"
import * as React from "react"

import { Empty, Section } from "@/components/page"
import {
  ConnectionDisclosure,
  ConnectionList,
  DestructiveAction,
  OperationStatus,
} from "@/features/connections/components"
import type { ConnectionClient } from "@/features/connections/types"
import { formatConnectionDate } from "@/features/connections/utils"
import { PresentationPolicyControl } from "@/features/presentation-policy/presentation-policy-control"
import { relativeTime } from "@/lib/format"
import type { ConnectionsService } from "@/services/connections-service"

function ClientRow({
  client,
  api,
  onRevoke,
}: {
  client: ConnectionClient
  api: ConnectionsService
  onRevoke(id: string): void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  return (
    <li aria-busy={pending}>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{client.label}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {client.lastUsedAt ? `Used ${relativeTime(client.lastUsedAt)}` : "Not used yet"}
            {client.expiresAt ? ` · expires ${formatConnectionDate(client.expiresAt)}` : ""}
          </p>
        </div>
      </div>
      <ConnectionDisclosure label="Manage">
        <div className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Can: {client.scopes.length ? client.scopes.join(", ") : "nothing"}
          </p>
          <PresentationPolicyControl
            scopeLabel={client.label}
            initialPolicy={client.effectiveLiveActivityPolicy}
            initialSource={client.liveActivityPolicySource}
            canInherit
            onSave={(policy) => api.saveClientLiveActivityPolicy(client.id, policy)}
            onReset={() => api.resetClientLiveActivityPolicy(client.id)}
          />
          <div className="flex items-center justify-between gap-3">
            <OperationStatus pending={pending} error={error} pendingLabel="Revoking…" />
            <DestructiveAction
              label="Revoke"
              title={`Revoke ${client.label}?`}
              description="This client stops working immediately. Run relo auth login to connect it again."
              pending={pending}
              onConfirm={() => {
                setPending(true)
                setError(null)
                void api
                  .revokeClient(client.id)
                  .then(() => onRevoke(client.id))
                  .catch((cause) => setError(cause instanceof Error ? cause.message : "Request failed."))
                  .finally(() => setPending(false))
              }}
            />
          </div>
        </div>
      </ConnectionDisclosure>
    </li>
  )
}

export function ClientsSection({
  initial,
  total,
  api,
}: {
  total: number
  initial: ConnectionClient[]
  api: ConnectionsService
}) {
  const [clients, setClients] = React.useState(initial)
  return (
    <Section title="CLI clients">
      {clients.length ? (
        <ConnectionList ariaLabel="CLI clients">
          {clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              api={api}
              onRevoke={(id) => setClients((current) => current.filter((item) => item.id !== id))}
            />
          ))}
        </ConnectionList>
      ) : (
        <Empty title="No CLI clients yet" description="Run relo auth login on your computer and approve it here." />
      )}
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
