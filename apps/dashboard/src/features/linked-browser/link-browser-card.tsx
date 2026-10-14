import { KeyRound, Lock, QrCode as QrIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type BrowserLink, type BrowserLinkState } from "@/lib/e2ee/browser-link"
import { useBrowserLink } from "@/features/linked-browser/use-browser-link"
import { LINK_STEPS, LINK_TITLE, linkPayload } from "@/features/linked-browser/link-text"
import { QrCode } from "@/features/linked-browser/qr-code"

const POLL_MS = 3_000
/** Polls the server while the QR code is on screen; reloads the page's data once a phone links it. */
function useLinkPolling(link: BrowserLink | null, active: boolean, onLinked: () => void) {
  useEffect(() => {
    if (!link || !active) return
    // Linking unmounts the prompt before the request settles, so the reload must not depend on it.
    let fired = false
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return
      void link
        .checkLinked()
        .then((linked) => {
          if (linked && !fired) {
            fired = true
            onLinked()
          }
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [link, active, onLinked])
}

function LinkQr({ state }: { state: Extract<BrowserLinkState, { status: "unlinked" }> }) {
  return (
    <div className="grid justify-items-start gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-5">
      <QrCode value={linkPayload(state.browserId, state.identityKey)} label="QR code to link this browser" className="w-44 sm:w-48" />
      <div className="grid gap-2 text-sm">
        <p className="text-foreground">{LINK_STEPS}</p>
        <p className="text-muted-foreground">
          Then scan this code. Your phone signs this browser&apos;s key, and computers start encrypting for it too. Signing in alone
          never gives a browser keys.
        </p>
        <p className="micro" role="status">Waiting for your iPhone…</p>
      </div>
    </div>
  )
}

const reloadPage = () => window.location.reload()

/** A compact prompt on Now; the QR code opens on request. Hidden unless this browser can be linked. */
export function LinkBrowserBanner({
  accountId,
  link,
  onLinked = reloadPage,
}: {
  accountId: string
  link?: BrowserLink | null
  onLinked?: () => void
}) {
  const { link: resolved, state } = useBrowserLink(accountId, link)
  const [open, setOpen] = useState(false)
  useLinkPolling(resolved, open && state.status === "unlinked", onLinked)
  if (state.status !== "unlinked") return null
  return (
    <section aria-label={LINK_TITLE} className="glass mb-6 grid gap-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Lock className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-medium text-foreground">{LINK_TITLE}</span>
        </div>
        <Button size="sm" variant={open ? "ghost" : "default"} className="min-h-11 sm:min-h-8" aria-expanded={open} onClick={() => setOpen(!open)}>
          <QrIcon aria-hidden="true" /> {open ? "Hide QR code" : "Show QR code"}
        </Button>
      </div>
      {open ? <LinkQr state={state} /> : null}
    </section>
  )
}

/** The Account page section: the QR code when unlinked, and what this browser can read once linked. */
export function LinkBrowserSection({
  accountId,
  link,
  onLinked = reloadPage,
}: {
  accountId: string
  link?: BrowserLink | null
  onLinked?: () => void
}) {
  const { link: resolved, state } = useBrowserLink(accountId, link)
  useLinkPolling(resolved, state.status === "unlinked", onLinked)
  let body: ReactNode
  switch (state.status) {
    case "unavailable":
      body = <p className="text-sm text-muted-foreground">This browser cannot keep encryption keys (it needs a secure connection and IndexedDB). Encrypted items stay locked here.</p>
      break
    case "starting":
      body = <p className="text-sm text-muted-foreground" role="status">Preparing this browser&apos;s keys…</p>
      break
    case "error":
      body = <p className="text-sm text-destructive" role="alert">{state.message}</p>
      break
    case "linked":
      body = (
        <p className="text-sm text-foreground" role="status">
          This browser reads end-to-end encrypted items{state.linkedBy ? `, linked by ${state.linkedBy}` : ""}. Unlink it on your iPhone in
          Settings → Security.
        </p>
      )
      break
    case "unlinked":
      body = <LinkQr state={state} />
      break
  }
  return (
    <Card id="linked-browser" className="rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
          {LINK_TITLE}
        </CardTitle>
        <CardDescription>
          End-to-end encrypted items open only on devices that hold keys. Link this browser from your iPhone to read them here.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
