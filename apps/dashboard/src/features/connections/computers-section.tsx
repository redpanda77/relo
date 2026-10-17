import { Laptop } from "lucide-react"
import * as React from "react"

import { Empty, List, Section } from "@/components/list"
import { Sheet } from "@/components/ui/sheet"
import { ComputerPanel } from "@/features/connections/computer-panel"
import { HookCredentialRow } from "@/features/connections/computer-panel/access"
import { PanelBox } from "@/features/connections/computer-panel/shared"
import { ComputerRow } from "@/features/connections/computer-row"
import type { ConnectionComputer, ConnectionHarnessCredential } from "@/features/connections/types"
import type { ConnectionsService } from "@/services/connections-service"

function ComputerItem({
  computer,
  api,
  onChange,
  onSignedOut,
}: {
  computer: ConnectionComputer
  api: ConnectionsService
  onChange(id: string, update: (current: ConnectionComputer) => ConnectionComputer): void
  onSignedOut(id: string): void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <ComputerRow computer={computer}>
        <ComputerPanel
          computer={computer}
          api={api}
          onChange={(update) => onChange(computer.id, update)}
          onSignedOut={() => {
            setOpen(false)
            onSignedOut(computer.id)
          }}
        />
      </ComputerRow>
    </Sheet>
  )
}

/** Hooks credentials that show under no computer (minted before computers existed, or by a login signed out since). */
function OtherHooks({ initial, api }: { initial: ConnectionHarnessCredential[]; api: ConnectionsService }) {
  const [hooks, setHooks] = React.useState(initial)
  if (!hooks.length) return null
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-medium">Other hooks credentials</h3>
      <p className="mb-2 max-w-[65ch] text-xs leading-5 text-muted-foreground">
        These belong to no computer you can see here. Hooks only report whether a session is working or waiting on you.
      </p>
      <PanelBox>
        <ul className="divide-y divide-[var(--divider)]" aria-label="Other hooks credentials">
          {hooks.map((hook) => (
            <HookCredentialRow key={hook.id} credential={hook} api={api} onRevoked={(id) => setHooks((current) => current.filter((item) => item.id !== id))} />
          ))}
        </ul>
      </PanelBox>
    </div>
  )
}

/** Connections → Computers: one row per machine that runs Relo (ADR 0011); a row opens its panel. */
export function ComputersSection({
  initial,
  unlinkedHooks,
  total,
  api,
}: {
  initial: ConnectionComputer[]
  unlinkedHooks: ConnectionHarnessCredential[]
  total: number
  api: ConnectionsService
}) {
  const [computers, setComputers] = React.useState(initial)
  const change = React.useCallback(
    (id: string, update: (current: ConnectionComputer) => ConnectionComputer) =>
      setComputers((current) => current.map((computer) => (computer.id === id ? update(computer) : computer))),
    []
  )
  return (
    <Section id="computers" title="Computers" count={computers.length || undefined}>
      <List
        label="Computers"
        items={computers}
        getKey={(computer) => computer.id}
        empty={<Empty icon={<Laptop />} title="No computers yet" description="Add a computer on Devices: one command installs Relo there and signs it in." />}
      >
        {(computer) => (
          <ComputerItem
            computer={computer}
            api={api}
            onChange={change}
            onSignedOut={(id) => setComputers((current) => current.filter((item) => item.id !== id))}
          />
        )}
      </List>
      {total > initial.length ? <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p> : null}
      <OtherHooks initial={unlinkedHooks} api={api} />
    </Section>
  )
}
