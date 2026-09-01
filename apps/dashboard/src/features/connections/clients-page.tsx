import { KeyRound, TerminalSquare } from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  ConnectionDisclosure,
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
  ConnectionClient,
  ConnectionsClients,
} from "@/features/connections/types"
import { formatConnectionDate } from "@/features/connections/utils"
import { PresentationPolicyControl } from "@/features/presentation-policy/presentation-policy-control"
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
    <article
      aria-busy={pending}
      className="border-b border-border last:border-b-0"
    >
      <div className="px-4 py-4 sm:px-5">
        <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start">
          <ConnectionIconTile icon={TerminalSquare} tone="success" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-[15px] font-semibold">
                {client.label}
              </h3>
              <ConnectionState label="Authorized" tone="success" />
            </div>
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <code className="font-mono text-foreground/80">
                {client.prefix}
              </code>
              <span aria-hidden="true">·</span>
              <code className="truncate font-mono">{client.id}</code>
            </p>
          </div>
          <span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto">
            {client.liveActivityPolicySource === "client"
              ? "Custom presentation"
              : "Inherited presentation"}
          </span>
        </div>
        <div className="mt-4">
          <h3 className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
            Authorized scopes
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {client.scopes.length ? (
              client.scopes.map((scope) => (
                <Badge key={scope} variant="secondary" className="font-mono">
                  {scope}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">No scopes</span>
            )}
          </div>
        </div>
        <dl className="mt-4 grid gap-px overflow-hidden rounded-xl bg-border text-sm sm:grid-cols-3">
          {[
            ["Created", formatConnectionDate(client.createdAt)],
            [
              "Expires",
              client.expiresAt
                ? formatConnectionDate(client.expiresAt)
                : "No expiry",
            ],
            ["Last used", formatConnectionDate(client.lastUsedAt)],
          ].map(([label, value]) => (
            <div key={label} className="bg-background/55 px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ConnectionDisclosure label="Manage client">
        <div className="space-y-5">
          <PresentationPolicyControl
            scopeLabel={client.label}
            initialPolicy={client.effectiveLiveActivityPolicy}
            initialSource={client.liveActivityPolicySource}
            canInherit
            onSave={(policy) =>
              api.saveClientLiveActivityPolicy(client.id, policy)
            }
            onReset={() => api.resetClientLiveActivityPolicy(client.id)}
          />
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <OperationStatus
              pending={pending}
              error={error}
              pendingLabel="Revoking CLI client credential…"
            />
            <div className="ml-auto">
              <DestructiveAction
                label="Revoke client"
                title={`Revoke ${client.label}?`}
                description="This client credential will stop authenticating immediately. This cannot be undone."
                pending={pending}
                onConfirm={() => {
                  setPending(true)
                  setError(null)
                  void api
                    .revokeClient(client.id)
                    .then(() => onRevoke(client.id))
                    .catch((cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Request failed."
                      )
                    )
                    .finally(() => setPending(false))
                }}
              />
            </div>
          </div>
        </div>
      </ConnectionDisclosure>
    </article>
  )
}

export function ClientsPage({
  initial,
  api,
}: {
  initial: ConnectionsClients
  api: ConnectionsService
}) {
  const [clients, setClients] = React.useState(initial.clients)
  return (
    <ConnectionsPageFrame bootstrap={initial}>
      <section className="mt-7 space-y-5" aria-labelledby="clients-heading">
        <ConnectionsSectionHeader
          id="clients-heading"
          title="CLI clients"
          description="Browser-approved agent credentials, their exact scopes, activity presentation, expiry, and last use."
        />
        {clients.length ? (
          <ConnectionList ariaLabel="CLI clients">
            {clients.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                api={api}
                onRevoke={(id) =>
                  setClients((current) =>
                    current.filter((item) => item.id !== id)
                  )
                }
              />
            ))}
          </ConnectionList>
        ) : (
          <Card>
            <CardContent className="flex min-h-36 flex-col items-center justify-center text-center">
              <KeyRound
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 font-medium">No active CLI clients</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Approved client credentials appear here until expiry or
                revocation.
              </p>
            </CardContent>
          </Card>
        )}
        <ConnectionsPager pagination={initial.pagination} />
      </section>
    </ConnectionsPageFrame>
  )
}
