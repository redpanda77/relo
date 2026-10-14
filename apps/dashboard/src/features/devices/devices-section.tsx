import { Globe, Laptop, Smartphone, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

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
import { DestructiveAction } from "@/features/connections/components"
import {
  createHttpDevicesService,
  type DeviceRow,
  type DevicesService,
  type DevicesView,
} from "@/features/devices/devices-service"
import { LinkBrowserSection } from "@/features/linked-browser/link-browser-card"
import { useBrowserLink } from "@/features/linked-browser/use-browser-link"
import type { BrowserLink } from "@/lib/e2ee/browser-link"
import { relativeTime } from "@/lib/format"

const httpService = createHttpDevicesService()
const REFRESH_MS = 60_000

type Tone = "success" | "warning" | "neutral"

/** One plain line per device: what it can do with encrypted content. */
function encryptionStatus(device: DeviceRow): { text: string; tone: Tone } {
  switch (device.status) {
    case "can_read":
      return { text: "Can read your encrypted cards", tone: "success" }
    case "pending":
      return { text: "Waiting for approval", tone: "warning" }
    case "simulator":
      return { text: "Simulator", tone: "neutral" }
    case "unlinked":
      return { text: "Not linked — can't read encrypted content", tone: "neutral" }
    case "encrypts":
      return { text: "Sends encrypted cards", tone: "success" }
    case "no_keys":
      return device.kind === "computer"
        ? { text: "Not set up for encryption", tone: "neutral" }
        : { text: "Not set up yet — open Relo on it", tone: "neutral" }
  }
}

const toneClass: Record<Tone, string> = {
  success: "text-[var(--status-success)] before:bg-[var(--status-success)]",
  warning: "text-[var(--status-warning)] before:bg-[var(--status-warning)]",
  neutral: "text-muted-foreground before:bg-muted-foreground",
}

const removeCopy: Record<DeviceRow["kind"], string> = {
  phone: "It is signed out and can no longer read anything. Cards only it could open are deleted.",
  computer: "Its CLI key stops working and it can no longer send cards. Run relo auth login on it to connect it again.",
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
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim()
    setBusy(true)
    setError("")
    try {
      await onApprove(twoFactor ? code : undefined)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval failed.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); setError("") }}>
      <Button type="button" className="min-h-11" onClick={() => setOpen(true)}>Approve</Button>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
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
                id={`approve-code-${device.id}`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="min-h-11"
              />
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="min-h-11">Cancel</Button>
            </DialogClose>
            <Button type="submit" className="min-h-11" disabled={busy}>{busy ? "Approving…" : "Approve"}</Button>
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const Icon = icons[device.kind]
  const status = encryptionStatus(device)
  const remove = (verb: string) => {
    setPending(true)
    setError(null)
    void onRemove()
      .catch((cause) => setError(cause instanceof Error ? cause.message : `${verb} failed.`))
      .finally(() => setPending(false))
  }
  const meta = [
    device.model && device.model !== device.name ? device.model : null,
    device.lastSeenAt ? `seen ${relativeTime(device.lastSeenAt)}` : null,
    device.notificationsOff ? "notifications off" : null,
    device.approvedBy ? `approved by ${device.approvedBy}` : null,
    device.linkedBy ? `linked by ${device.linkedBy}` : null,
  ].filter(Boolean)
  return (
    <li aria-busy={pending} className="grid gap-2 px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate">{device.name}</span>
            {thisBrowser ? (
              <span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">This browser</span>
            ) : null}
          </p>
          {meta.length ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta.join(" · ")}</p> : null}
          <p
            className={`mt-1 inline-flex items-center gap-1.5 text-xs font-medium before:size-1.5 before:shrink-0 before:rounded-full ${toneClass[status.tone]}`}
          >
            {status.text}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
          {device.status === "pending" ? (
            <>
              {canApprove ? (
                <ApproveDialog device={device} twoFactor={twoFactor} onApprove={onApprove} />
              ) : (
                <Button asChild variant="outline" className="min-h-11">
                  <a href="#linked-browser">Link this browser from your iPhone first</a>
                </Button>
              )}
              <DestructiveAction
                label="Decline"
                title={`Decline ${device.name}?`}
                description="It is signed out and can never read your encrypted cards. To use it again, sign in on it and approve it."
                pending={pending}
                onConfirm={() => remove("Decline")}
              />
            </>
          ) : (
            <DestructiveAction
              label="Remove"
              title={`Remove ${device.name}?`}
              description={removeCopy[device.kind]}
              pending={pending}
              onConfirm={() => remove("Removal")}
            />
          )}
        </div>
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </li>
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
}: {
  accountId: string
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
    <div className="grid gap-6">
      {view === undefined && !error ? <p className="px-1 text-sm text-muted-foreground">Loading devices…</p> : null}
      {error ? <p className="px-1 text-sm text-muted-foreground">Devices could not be loaded ({error}). Trying again in a minute.</p> : null}
      {view
        ? GROUPS.map(({ kind, title }) => {
            const rows = view.devices.filter((device) => device.kind === kind)
            if (!rows.length) return null
            return (
              <div key={kind} className="grid gap-2">
                <h4 className="px-1 text-sm font-medium text-muted-foreground">{title}</h4>
                <ul aria-label={title} className="glass divide-y divide-white/[0.06] overflow-hidden rounded-[20px]">
                  {rows.map((device) => (
                    <DeviceItem
                      key={device.id}
                      device={device}
                      thisBrowser={device.id === thisBrowserId}
                      canApprove={linked}
                      twoFactor={view.twoFactorEnabled}
                      onApprove={(code) => approve(device, code)}
                      onRemove={() => remove(device)}
                    />
                  ))}
                </ul>
              </div>
            )
          })
        : null}
      {state.status !== "linked" ? <LinkBrowserSection accountId={accountId} link={resolved} onLinked={onLinked} /> : null}
    </div>
  )
}
