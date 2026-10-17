import { Activity } from "lucide-react"
import * as React from "react"

import { IconTile } from "@/components/atoms/icon-tile"
import { DestructiveAction } from "@/components/molecules/confirmation-action"
import { OperationStatus } from "@/components/molecules/operation-status"
import { errorText } from "@/features/connections/computer-panel/error-text"
import { PanelBox } from "@/features/connections/computer-panel/shared"
import { scopeSentences } from "@/features/connections/scope-copy"
import type { ConnectionComputer, ConnectionHarnessCredential } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"
import type { ConnectionsService } from "@/services/connections-service"

/** A hooks credential and its own Revoke: hooks only report whether a session is working or waiting on you. */
export function HookCredentialRow({
  credential,
  api,
  onRevoked,
}: {
  credential: ConnectionHarnessCredential
  api: ConnectionsService
  onRevoked(id: string): void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  return (
    <li className="px-4 py-3" aria-busy={pending || undefined}>
      <div className="flex items-center gap-3">
        <IconTile icon={Activity} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{credential.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {credential.lastUsedAt ? `Used ${relativeTime(credential.lastUsedAt)}` : "Not used yet"}
          </p>
        </div>
        <DestructiveAction
          label="Revoke"
          title={`Revoke ${credential.name}?`}
          description="Hooks on that computer stop reporting sessions. Cards and questions keep working. Run relo setup to turn hooks on again."
          pending={pending}
          failed={Boolean(error)}
          pendingLabel="Revoking…"
          size="sm"
          onConfirm={() => {
            setPending(true)
            setError(null)
            void api
              .revokeHarnessCredential(credential.id)
              .then(() => onRevoked(credential.id))
              .catch((cause) => setError(errorText(cause)))
              .finally(() => setPending(false))
          }}
        />
      </div>
      <OperationStatus pending={pending} error={error} pendingLabel="Revoking…" className="mt-2 text-xs" />
    </li>
  )
}

export function Access({
  computer,
  api,
  onHookRevoked,
  onSignedOut,
}: {
  computer: ConnectionComputer
  api: ConnectionsService
  onHookRevoked(id: string): void
  onSignedOut(): void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const sentences = scopeSentences(computer.scopes)
  return (
    <div className="grid gap-5">
      <div>
        <p className="mb-1.5 text-sm font-medium">This computer can</p>
        {sentences.length ? (
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {sentences.map((sentence) => (
              <li key={sentence} className="flex gap-2">
                <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                {sentence}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing</p>
        )}
      </div>
      {computer.hooks.length ? (
        <div>
          <p className="mb-1.5 text-sm font-medium">Hooks credential</p>
          <PanelBox>
            <ul className="divide-y divide-[var(--divider)]" aria-label="Hooks credentials">
              {computer.hooks.map((hook) => (
                <HookCredentialRow key={hook.id} credential={hook} api={api} onRevoked={onHookRevoked} />
              ))}
            </ul>
          </PanelBox>
        </div>
      ) : null}
      <div className="grid gap-2 border-t border-[var(--divider)] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[48ch] text-sm text-muted-foreground">
            Signing out cuts this computer off at once.
          </p>
          <DestructiveAction
            label="Sign this computer out"
            title={`Sign ${computer.name} out?`}
            description="This computer stops sending cards immediately. Add it again from Devices to connect it."
            pending={pending}
            failed={Boolean(error)}
            pendingLabel="Signing out…"
            onConfirm={() => {
              setPending(true)
              setError(null)
              void api
                .revokeClient(computer.loginId)
                .then(onSignedOut)
                .catch((cause) => {
                  setError(errorText(cause))
                  setPending(false)
                })
            }}
          />
        </div>
        <OperationStatus pending={pending} error={error} pendingLabel="Signing out…" className="text-xs" />
      </div>
    </div>
  )
}
