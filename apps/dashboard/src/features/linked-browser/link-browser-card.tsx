import { KeyRound, Lock, QrCode as QrIcon, Smartphone } from "lucide-react"
import { LazyMotion } from "motion/react"
import { useCallback, useEffect, useState, type ReactNode } from "react"

import { CrossfadeText } from "@/components/atoms/animated-height"
import { CheckDraw } from "@/components/atoms/check-draw"
import { IconTile } from "@/components/atoms/icon-tile"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { linkCode, type BrowserLink, type BrowserLinkState, type LinkRequestError } from "@/lib/e2ee/browser-link"
import { useBrowserLink } from "@/features/linked-browser/use-browser-link"
import { LINK_STEPS, LINK_TITLE, linkPayload } from "@/features/linked-browser/link-text"
import { QrCode } from "@/features/linked-browser/qr-code"
import { loadMotionFeatures } from "@/lib/motion"

const POLL_MS = 3_000
/** Polls the server while the QR code is on screen; the link's state then changes in place, with no reload. */
function useLinkPolling(link: BrowserLink | null, active: boolean, onLinked?: () => void) {
  useEffect(() => {
    if (!link || !active) return
    // Linking unmounts the prompt before the request settles, so the callback must not depend on it.
    let fired = false
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return
      void link
        .checkLinked()
        .then((linked) => {
          if (linked && !fired) {
            fired = true
            onLinked?.()
          }
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [link, active, onLinked])
}

type Unlinked = Extract<BrowserLinkState, { status: "unlinked" }>

/**
 * The QR code and its steps. It stays still and unclipped while a breathing dot says Relo is
 * waiting; once the phone has linked it, a checkmark draws over the code before the page reloads.
 */
function LinkQr({ state, linked = false }: { state: Unlinked; linked?: boolean }) {
  return (
    <div className="grid justify-items-start gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-5">
      <div className="relative w-44 rounded-lg sm:w-48">
        <QrCode value={linkPayload(state.browserId, state.identityKey)} label="QR code to link this browser" className="w-44 sm:w-48" />
        {linked ? (
          <span className="qr-done" data-slot="qr-linked">
            <LazyMotion features={loadMotionFeatures} strict>
              <CheckDraw className="size-14" />
            </LazyMotion>
          </span>
        ) : null}
      </div>
      <div className="grid gap-2 text-sm">
        <p className="text-foreground">{LINK_STEPS}</p>
        <p className="text-muted-foreground">
          Then scan this code. Your phone signs this browser&apos;s key, and computers start encrypting for it too. Signing in alone
          never gives a browser keys.
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {linked ? null : <span className="waiting-dot" aria-hidden="true" />}
          <CrossfadeText>{linked ? "Linked. Items sent from now on open here…" : "Waiting for your iPhone…"}</CrossfadeText>
        </p>
      </div>
    </div>
  )
}

/** How long the checkmark holds over the QR code before it gives way to the page. */
const LINKED_HOLD_MS = 900

/**
 * The last QR state, kept for the moment after the phone links it: a checkmark draws over the code,
 * then the code gives way to the page, which opens its encrypted items in place (no reload).
 */
function useLinkedMoment(state: BrowserLinkState) {
  const [moment, setMoment] = useState<{ state: BrowserLinkState; qr: Unlinked | null; linked: boolean }>(() => ({
    state,
    qr: state.status === "unlinked" ? state : null,
    linked: false,
  }))
  if (moment.state !== state) {
    // Adjusting state while rendering (React's sanctioned pattern): the check shows in this paint.
    setMoment({
      state,
      qr: state.status === "unlinked" ? state : moment.qr,
      linked: state.status === "linked" && moment.state.status === "unlinked",
    })
  }
  const holding = moment.linked
  useEffect(() => {
    if (!holding) return
    const timer = window.setTimeout(() => setMoment((current) => ({ ...current, qr: null, linked: false })), LINKED_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [holding])
  return { qr: holding ? moment.qr : null }
}

/** How long before the owner may send the request to the iPhone again (the server's own limit). */
const RESEND_MS = 30_000

type Flow = { mode: "idle" } | { mode: "sending" } | { mode: "waiting"; sentAt: number } | { mode: "qr"; note?: string }

const REQUEST_ERRORS: Record<LinkRequestError, string> = {
  no_phone: "No iPhone can get this yet: Relo isn't signed in there, or its notifications are off. Scan the code instead.",
  too_soon: "Already sent. Check your iPhone, or send again in a few seconds.",
  already_linked: "This browser is already linked.",
  browser_not_found: "This browser's keys changed. Reload the page and try again.",
  not_ready: "This browser's keys are still being prepared. Try again in a moment.",
  failed: "Relo could not reach your iPhone. Try again, or scan the code instead.",
}

/** The browser's link code, worked out once per key (5200 hashes, a few milliseconds). */
function useLinkCode(identityKey: string | null) {
  const [code, setCode] = useState<{ key: string; code: string } | null>(null)
  useEffect(() => {
    if (!identityKey) return
    let active = true
    void linkCode(identityKey).then((next) => { if (active) setCode({ key: identityKey, code: next }) }, () => undefined)
    return () => { active = false }
  }, [identityKey])
  return code?.key === identityKey ? code.code : null
}

/** Counts down to the moment the request may go again; null once it may. */
function useResendIn(sentAt: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (sentAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [sentAt])
  if (sentAt === null) return null
  const left = Math.ceil((sentAt + RESEND_MS - now) / 1_000)
  return left > 0 ? left : null
}

/**
 * The ways to link this browser: send the request to the iPhone (it shows the same link code to compare), or scan a
 * QR code there. Shared by Now's card and the Account page; the caller polls while `onActive` says a request is out.
 */
function LinkFlow({
  link,
  state,
  linked,
  onActive,
}: {
  link: BrowserLink | null
  state: Unlinked
  linked: boolean
  onActive: (active: boolean) => void
}) {
  const [flow, setFlow] = useState<Flow>({ mode: "idle" })
  const [problem, setProblem] = useState<string | null>(null)
  const code = useLinkCode(state.identityKey)
  const resendIn = useResendIn(flow.mode === "waiting" ? flow.sentAt : null)
  useEffect(() => { onActive(flow.mode === "waiting" || flow.mode === "qr") }, [flow.mode, onActive])

  const send = useCallback(async () => {
    if (!link) return
    setProblem(null)
    setFlow({ mode: "sending" })
    const result = await link.requestLink().catch(() => ({ ok: false as const, error: "failed" as const }))
    if (result.ok) setFlow({ mode: "waiting", sentAt: Date.now() })
    else if (result.error === "no_phone") setFlow({ mode: "qr", note: REQUEST_ERRORS.no_phone })
    else if (result.error === "too_soon") { setFlow({ mode: "waiting", sentAt: Date.now() }); setProblem(REQUEST_ERRORS.too_soon) }
    else { setFlow({ mode: "idle" }); setProblem(REQUEST_ERRORS[result.error]) }
  }, [link])

  if (linked && flow.mode !== "qr") {
    return (
      <div className="link-flow">
        <p className="link-status" role="status" data-done="true">
          <span className="link-status-check" aria-hidden="true">
            <LazyMotion features={loadMotionFeatures} strict><CheckDraw className="size-4" /></LazyMotion>
          </span>
          <CrossfadeText>Linked. Items sent from now on open here…</CrossfadeText>
        </p>
      </div>
    )
  }

  if (flow.mode === "qr") {
    return (
      <div className="link-flow">
        {flow.note ? <p className="link-note" role="status">{flow.note}</p> : null}
        <LinkQr state={state} linked={linked} />
        {linked ? null : (
          <div className="link-actions">
            <Button size="sm" variant="ghost" onClick={() => setFlow({ mode: "idle" })}>
              <Smartphone aria-hidden="true" /> Send to my iPhone instead
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (flow.mode === "waiting") {
    return (
      <div className="link-flow">
        <div className="link-code-panel">
          <p className="link-code-label">Link code</p>
          <p className="link-code" aria-label={code ? `Link code ${code}` : "Link code loading"}>
            {code ? code.split(" ").map((group) => <span key={group}>{group}</span>) : <span className="link-code-loading">· · ·</span>}
          </p>
          <p className="link-code-hint">
            Open the notification on your iPhone and approve <strong>{link?.displayName ?? "this browser"}</strong> only if it shows this
            code.
          </p>
        </div>
        {problem ? <p className="link-note" role="status">{problem}</p> : null}
        <div className="link-footer">
          <p className="link-status" role="status">
            <span className="waiting-dot" aria-hidden="true" />
            Waiting for your iPhone…
          </p>
          <div className="link-actions">
            <Button size="sm" variant="ghost" disabled={resendIn !== null} onClick={() => void send()}>
              {resendIn !== null ? `Send again in ${resendIn}s` : "Send again"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFlow({ mode: "qr" })}>
              <QrIcon aria-hidden="true" /> Scan a code instead
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="link-flow">
      {problem ? <p className="link-note" role="alert">{problem}</p> : null}
      <div className="link-actions">
        <Button size="sm" disabled={!link || flow.mode === "sending"} onClick={() => void send()}>
          <Smartphone aria-hidden="true" /> {flow.mode === "sending" ? "Sending…" : "Send to my iPhone"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setFlow({ mode: "qr" })}>
          <QrIcon aria-hidden="true" /> Scan a QR code
        </Button>
      </div>
    </div>
  )
}

/** The card's head: the lock mark, a quiet label, the title and why it matters. */
function LinkHead({ titleAs: Title = "h2" }: { titleAs?: "h2" | "h3" }) {
  return (
    <div className="link-head">
      <span className="link-mark" aria-hidden="true"><Lock /></span>
      <div className="link-titles">
        <p className="link-eyebrow">End-to-end encrypted</p>
        <Title className="link-title">{LINK_TITLE}</Title>
      </div>
      <p className="link-lede">
        Your agents seal some cards so only your devices can read them. Approve this browser from your iPhone to open them here.
      </p>
    </div>
  )
}

/** Now's card: shown only while this browser can be linked, gone once it is (after the linked moment). */
export function LinkBrowserBanner({
  accountId,
  link,
  onLinked,
}: {
  accountId: string
  link?: BrowserLink | null
  onLinked?: () => void
}) {
  const { link: resolved, state } = useBrowserLink(accountId, link)
  const [active, setActive] = useState(false)
  const moment = useLinkedMoment(state)
  useLinkPolling(resolved, active && state.status === "unlinked", onLinked)
  const shown = state.status === "unlinked" ? state : moment.qr
  if (!shown) return null
  return (
    <section className="link-card" aria-label={LINK_TITLE}>
      <LinkHead />
      <LinkFlow link={resolved} state={shown} linked={state.status === "linked"} onActive={setActive} />
    </section>
  )
}

/** The Account page section: the QR code when unlinked, and what this browser can read once linked. */
export function LinkBrowserSection({
  accountId,
  link,
  onLinked,
}: {
  accountId: string
  link?: BrowserLink | null
  onLinked?: () => void
}) {
  const { link: resolved, state } = useBrowserLink(accountId, link)
  const [active, setActive] = useState(false)
  const moment = useLinkedMoment(state)
  useLinkPolling(resolved, active && state.status === "unlinked", onLinked)
  let body: ReactNode
  if (moment.qr) body = <LinkFlow link={resolved} state={moment.qr} linked onActive={setActive} />
  else switch (state.status) {
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
          This browser reads end-to-end encrypted items{state.linkedBy ? `, linked by ${state.linkedBy}` : ""}. Items sent before it was linked stay
          readable only on your iPhone. Unlink it on your iPhone in Settings → Devices.
        </p>
      )
      break
    case "unlinked":
      body = <LinkFlow link={resolved} state={state} linked={false} onActive={setActive} />
      break
  }
  return (
    <Card id="linked-browser" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <IconTile icon={KeyRound} tone="violet" />
          {LINK_TITLE}
        </CardTitle>
        <CardDescription>
          End-to-end encrypted items open only on devices that hold keys. Approve this browser from your iPhone to read them here.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
