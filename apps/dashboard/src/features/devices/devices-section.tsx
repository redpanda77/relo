import { Globe, Laptop, Smartphone, Trash2, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { SECTION_CAPTION_CLASS } from "@/components/list"
import { seenDot } from "@/lib/machine-seen"
import { MachineCard, MachineList } from "@/components/molecules/machine-card"
import { SystemButton, SystemCard } from "@/components/molecules/system-card"
import { ActionButton } from "@/components/molecules/action-button"
import { DestructiveAction } from "@/components/molecules/confirmation-action"
import { Notice } from "@/components/molecules/notice"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  createHttpDevicesService,
  type DeviceRow,
  type DevicesService,
  type DevicesView,
} from "@/features/devices/devices-service"
import { AddComputerControl } from "@/features/onboarding/connect-computer"
import { LinkBrowserSection } from "@/features/linked-browser/link-browser-card"
import { useBrowserLink } from "@/features/linked-browser/use-browser-link"
import type { BrowserLink } from "@/lib/e2ee/browser-link"
import { relativeTime } from "@/lib/format"
import type { NeonTone } from "@/lib/status-tone"
import { playCue } from "@/lib/sound"
import { useShake } from "@/lib/use-shake"

const httpService = createHttpDevicesService()
const REFRESH_MS = 60_000

type Tone = Extract<NeonTone, "mint" | "yellow" | "neutral">

/** One plain line per device: what it can do with encrypted content. */
function encryptionStatus(device: DeviceRow): { text: string; tone: Tone } {
  switch (device.status) {
    case "can_read":
      return { text: "Can read your encrypted cards", tone: "mint" }
    case "pending":
      return { text: "Waiting for approval", tone: "yellow" }
    case "simulator":
      return { text: "Simulator", tone: "neutral" }
    case "unlinked":
      return { text: "Not linked — can't read encrypted content", tone: "neutral" }
    case "encrypts":
      return { text: "Sends encrypted cards", tone: "mint" }
    case "no_keys":
      return device.kind === "computer"
        ? { text: "Not set up for encryption", tone: "neutral" }
        : { text: "Not set up yet — open Relo on it", tone: "neutral" }
  }
}

const removeCopy: Record<DeviceRow["kind"], string> = {
  phone: "It is signed out and can no longer read anything. Cards only it could open are deleted.",
  computer: "Its CLI key stops working and it can no longer send cards. Add it again with Add a computer to connect it.",
  browser: "It is signed out of encryption and can no longer read anything. It needs to be linked from your iPhone again.",
}

const icons: Record<DeviceRow["kind"], LucideIcon> = { phone: Smartphone, computer: Laptop, browser: Globe }

function ApproveDialog({
  device,
  twoFactor,
  onApprove,
}: {
  device: DeviceRow
  twoFactor: boolean
  onApprove(code?: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [form, shake] = useShake<HTMLFormElement>()
  const codeField = useRef<HTMLInputElement>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim()
    setBusy(true)
    setError("")
    try {
      await onApprove(twoFactor ? code : undefined)
      playCue("linked")
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval failed.")
      // A wrong code: the form shakes and the code is selected for the next try.
      shake(codeField.current)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); setError("") }}>
      <SystemButton primary onClick={() => setOpen(true)}>Approve</SystemButton>
      <DialogContent>
        <form ref={form} className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Approve {device.name}?</DialogTitle>
            <DialogDescription>
              It will be able to read your encrypted cards. Approve it only if you just signed in on it yourself.
            </DialogDescription>
          </DialogHeader>
          {twoFactor ? (
            <div className="grid gap-2">
              <Label htmlFor={`approve-code-${device.id}`}>Code from your authenticator app</Label>
              <Input
                ref={codeField}
                id={`approve-code-${device.id}`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </div>
          ) : null}
          <OperationStatus error={error || null} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <ActionButton type="submit" pending={busy} failed={Boolean(error)} pendingLabel="Approving…" successLabel={null}>
              Approve
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeviceItem({
  device,
  thisBrowser,
  canApprove,
  twoFactor,
  onApprove,
  onRemove,
}: {
  device: DeviceRow
  thisBrowser: boolean
  canApprove: boolean
  twoFactor: boolean
  onApprove(code?: string): Promise<void>
  onRemove(): Promise<void>
}) {
  const [pending, setPending] = useState<"Removal" | "Decline" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const Icon = device.kind === "computer" && device.icon ? COMPUTER_ICON_META[device.icon].glyph : icons[device.kind]
  const status = encryptionStatus(device)
  const remove = (verb: "Removal" | "Decline") => {
    setPending(verb)
    setError(null)
    void onRemove()
      .catch((cause) => setError(cause instanceof Error ? cause.message : `${verb} failed.`))
      .finally(() => setPending(null))
  }
  const meta = [
    device.model && device.model !== device.name ? device.model : null,
    device.lastSeenAt ? `seen ${relativeTime(device.lastSeenAt)}` : null,
    device.notificationsOff ? "notifications off" : null,
    device.approvedBy ? `approved by ${device.approvedBy}` : null,
    device.linkedBy ? `linked by ${device.linkedBy}` : null,
  ].filter(Boolean)
  const removeAction = (
    <DestructiveAction
      label="Remove"
      title={`Remove ${device.name}?`}
      description={removeCopy[device.kind]}
      pending={pending === "Removal"}
      disabled={pending !== null}
      failed={Boolean(error)}
      pendingLabel="Removing…"
      size="sm"
      icon={<Trash2 aria-hidden="true" />}
      compact
      onConfirm={() => remove("Removal")}
    />
  )
  const approval = device.status === "pending"
  if (approval) {
    // A new phone, computer or browser waiting for the owner: the orange system card (board C4).
    return (
      <SystemCard
        tone="orange"
        edge
        role="region"
        aria-busy={pending !== null || undefined}
        icon={<Icon />}
        eyebrow={`New ${device.kind} \u00b7 Waiting for approval`}
        title={device.name}
        actions={
          <>
            {canApprove ? (
              <ApproveDialog device={device} twoFactor={twoFactor} onApprove={onApprove} />
            ) : (
              <SystemButton primary href="#linked-browser">Link this browser from your iPhone first</SystemButton>
            )}
            <DestructiveAction
              label="Decline"
              title={`Decline ${device.name}?`}
              description="It is signed out and can never read your encrypted cards. To use it again, sign in on it and approve it."
              pending={pending === "Decline"}
              disabled={pending !== null}
              failed={Boolean(error)}
              pendingLabel="Declining…"
              size="sm"
              onConfirm={() => remove("Decline")}
            />
          </>
        }
      >
        {meta.length ? `${meta.join(" \u00b7 ")}. ` : ""}It will be able to read your encrypted cards once you approve it.
        <OperationStatus error={error} className="mt-1" />
      </SystemCard>
    )
  }
  return (
    <MachineCard
      busy={pending !== null}
      glyph={Icon}
      dot={seenDot(device.lastSeenAt)}
      name={
        <>
          {device.name}
          {thisBrowser ? <span className="machine-tag">This browser</span> : null}
        </>
      }
      summary={[status.text, ...meta.map((part) => String(part).replace(/^seen /, "Last seen "))].join(" \u00b7 ")}
      actions={removeAction}
      note={error ? <OperationStatus error={error} /> : undefined}
    />
  )
}

const GROUPS: { kind: DeviceRow["kind"]; title: string }[] = [
  { kind: "phone", title: "Phones" },
  { kind: "computer", title: "Computers" },
  { kind: "browser", title: "Browsers" },
]

/**
 * Account → Devices, like WhatsApp's linked devices: every phone, computer and browser on the
 * account, what each can read, and Remove; a pending phone is approved here from a linked browser.
 */
export function DevicesSection({
  accountId,
  service = httpService,
  link,
  onLinked,
  scope = "devices",
}: {
  accountId: string
  /** "devices": phones and browsers (Security). "computers": computers and Add a computer (Computers). */
  scope?: "devices" | "computers"
  service?: DevicesService
  link?: BrowserLink | null
  onLinked?: () => void
}) {
  const { link: resolved, state } = useBrowserLink(accountId, link)
  const [view, setView] = useState<DevicesView | null | undefined>(undefined)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try {
      setView(await service.list())
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Devices could not be loaded.")
    }
  }, [service])

  useEffect(() => {
    let active = true
    const load = () =>
      service.list().then(
        (next) => {
          if (!active) return
          setView(next)
          setError("")
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : "Devices could not be loaded.")
        }
      )
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load()
    }, REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [service])

  const thisBrowserId = state.status === "linked" || state.status === "unlinked" ? state.browserId : null
  const linked = state.status === "linked" && resolved !== null
  // Computers this browser holds back: signed in after its first contact, approved by no device it trusts yet.
  const [waiting, setWaiting] = useState<Array<{ clientId: string; name: string }>>([])
  const [approving, setApproving] = useState<string | null>(null)
  useEffect(() => {
    if (!linked || typeof resolved?.pendingComputers !== "function") return
    let active = true
    void resolved.pendingComputers().then((next) => { if (active) setWaiting(next) }, () => undefined)
    return () => { active = false }
  }, [linked, resolved, view])

  async function approveComputer(clientId: string) {
    if (!resolved) return
    setApproving(clientId)
    try {
      await resolved.approveComputer(clientId)
      setWaiting(await resolved.pendingComputers())
    } finally {
      setApproving(null)
    }
  }

  async function approve(device: DeviceRow, code?: string) {
    if (!resolved || !device.identityKey) throw new Error("Link this browser from your iPhone first.")
    const signed = await resolved.signApproval({ deviceId: device.id, identityKey: device.identityKey })
    await service.approve(device.id, signed, code)
    await refresh()
  }

  async function remove(device: DeviceRow) {
    await service.remove(device)
    if (device.id === thisBrowserId) await resolved?.checkLinked().catch(() => undefined)
    await refresh()
  }

  if (view === null) return null
  return (
    <div className="grid gap-5">
      {view === undefined && !error ? <p className="text-sm text-muted-foreground">Loading devices…</p> : null}
      <Notice show={Boolean(error)} variant="quiet" tone="neutral">
        Devices could not be loaded ({error}). Trying again in a minute.
      </Notice>
      {scope === "computers" && waiting.length > 0 ? (
        <div className="grid gap-3">
          <h4 className={SECTION_CAPTION_CLASS}>Waiting for approval in this browser</h4>
          <MachineList label="Computers waiting for approval" items={waiting} getKey={(computer) => computer.clientId}>
            {(computer) => (
              <SystemCard
                tone="orange"
                edge
                role="region"
                icon={<Laptop />}
                eyebrow="New computer \u00b7 Waiting for approval"
                title={computer.name}
                actions={
                  <ActionButton size="sm" pending={approving === computer.clientId} pendingLabel="Approving…"
                    onClick={() => void approveComputer(computer.clientId)}>
                    Approve
                  </ActionButton>
                }
              >
                It signed in after this browser was linked, so its cards can&apos;t show here yet. Approve it to read them here; your other devices follow your approval too.
              </SystemCard>
            )}
          </MachineList>
        </div>
      ) : null}
      {view
        ? GROUPS.filter(({ kind }) => (kind === "computer") === (scope === "computers")).map(({ kind, title }) => {
            const rows = view.devices.filter((device) => device.kind === kind)
            if (!rows.length) return null
            return (
              <div key={kind} className="grid gap-3">
                {scope === "computers" ? null : <h4 className={SECTION_CAPTION_CLASS}>{title}</h4>}
                <MachineList label={title} items={rows} getKey={(device) => device.id}>
                  {(device) => (
                    <DeviceItem
                      device={device}
                      thisBrowser={device.id === thisBrowserId}
                      canApprove={linked}
                      twoFactor={view.twoFactorEnabled}
                      onApprove={(code) => approve(device, code)}
                      onRemove={() => remove(device)}
                    />
                  )}
                </MachineList>
              </div>
            )
          })
        : null}
      {scope === "computers" ? <AddComputerControl /> : null}
      {scope === "devices" && state.status !== "linked" ? <LinkBrowserSection accountId={accountId} link={resolved} onLinked={onLinked} /> : null}
    </div>
  )
}
