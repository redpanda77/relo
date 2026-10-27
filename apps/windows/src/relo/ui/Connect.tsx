// The open notch before this PC has a Now to show: "See your agents here" with a Sign in button, in the Mac sheet's
// words (ReloOnboardingSignInView, BrowserSignInSession). The sign-in itself is the in-app window titled "Sign in to
// Relo"; the browser is mentioned only when that window could not open (`signInInBrowser`). Minimal on purpose: the
// server address field appears only while no address is known or the owner wants another, then one Sign in button.
// It reports the height it needs like the Panel does.

import { useLayoutEffect, useRef, useState } from "react"
import { PlasmaOrb } from "../visual/PlasmaOrb"
import { useReloMode } from "./mode"
import { COLORS } from "./theme"
import { SIGN_IN_WORDS } from "./words"

export interface ConnectProps {
  connection: "starting" | "signedOut" | "signingIn" | "connecting" | "live" | "offline" | "needsSignIn"
  problem: string | null
  serverOrigin: string | null
  accountEmail: string | null
  /** The sign-in page was opened in the system browser because its own window could not open. */
  signInInBrowser?: boolean
  onSignIn: (origin?: string) => void
  onCancel: () => void
  onRetry: () => void
  /** A text field has the keyboard: the notch stays open and takes keystrokes until it ends. */
  onEditing: (editing: boolean) => void
  onFit: (height: number) => void
}

const PAD = 14

export function Connect({ connection, problem, serverOrigin, accountEmail, signInInBrowser = false, onSignIn, onCancel, onRetry, onEditing, onFit }: ConnectProps) {
  const box = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)

  useLayoutEffect(() => {
    const measure = () => onFit(Math.ceil((box.current?.offsetHeight ?? 0) + PAD * 2))
    measure()
    const ro = new ResizeObserver(measure)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [onFit])

  const { openHome } = useReloMode()
  const asksToSignIn = connection === "signedOut" || connection === "needsSignIn"
  const askingForOrigin = (connection === "signedOut" || connection === "needsSignIn") && (!serverOrigin || changing)
  const value = draft ?? serverOrigin ?? ""
  const submit = () => {
    onEditing(false)
    setChanging(false)
    onSignIn(value.trim() ? value : undefined)
  }

  // Starting: the Mac shows a small spinner and nothing else (ReloNotchView.connectionContent .starting).
  if (connection === "starting") {
    return (
      <div style={{ padding: `${PAD}px 0` }}>
        <div ref={box} className="grid place-items-center" style={{ minHeight: 60 }} role="status" aria-label={headline(connection)}>
          <span className="ro-spin" aria-hidden />
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: `${PAD}px 0`, ["--tone" as string]: COLORS.signalCoral }}>
      <div ref={box} className={asksToSignIn ? "flex flex-col gap-3" : "flex flex-col items-center gap-2 text-center"}>
        {asksToSignIn ? (
          // ReloSignInPanel: the orb (44), the headline and its line, the button on the right.
          <div className="flex items-center gap-[14px] px-3">
            <div style={{ width: 44, height: 44, flex: "none" }}><PlasmaOrb mood="clear" size={44} /></div>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="text-[14px] font-semibold text-white">{headline(connection)}</div>
              <div className="text-[11px] [overflow-wrap:anywhere]" style={{ color: COLORS.secondaryText }}>{detail(connection, serverOrigin, accountEmail, signInInBrowser)}</div>
            </div>
            <button type="button" className="pill" data-prominent="" onClick={openHome}>{SIGN_IN_WORDS.openRelo}</button>
          </div>
        ) : (
          <>
            <div className="text-[14px] font-semibold text-white">{headline(connection)}</div>
            <div className="max-w-[460px] text-[11px] [overflow-wrap:anywhere]" style={{ color: COLORS.secondaryText }}>{detail(connection, serverOrigin, accountEmail, signInInBrowser)}</div>
          </>
        )}

        {askingForOrigin && (
          <input
            className="w-[300px] rounded-lg border border-white/15 bg-white/[0.07] px-3 py-1.5 text-[12px] text-white outline-none placeholder:text-white/35 focus:border-white/35"
            placeholder="relo.example.com or http://192.168.1.5:8180"
            aria-label="Relo server address"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onPointerDown={() => onEditing(true)}
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && value.trim() && submit()}
          />
        )}

        {problem && <div className="max-w-[460px] text-[11px] [overflow-wrap:anywhere]" style={{ color: COLORS.yellow }}>{problem}</div>}

        <div className="flex items-center gap-2" style={{ ["--tone" as string]: COLORS.cyan }}>
          {(connection === "signedOut" || connection === "needsSignIn") && (
            <>
              <button type="button" className="pill" data-prominent="" disabled={!serverOrigin && !value.trim()} onClick={submit}>
                {connection === "needsSignIn" ? "Sign in again" : "Sign in"}
              </button>
              {serverOrigin && !askingForOrigin && (
                <button type="button" className="pill" onClick={() => { setDraft(null); setChanging(true) }}>Change</button>
              )}
            </>
          )}
          {connection === "signingIn" && (
            <>
              <button type="button" className="pill" data-prominent="" onClick={() => onSignIn()}>{signInInBrowser ? "Open the browser again" : "Show the window"}</button>
              <button type="button" className="pill" onClick={onCancel}>Cancel</button>
            </>
          )}
          {connection === "offline" && <button type="button" className="pill" data-prominent="" onClick={onRetry}>Try again</button>}
        </div>
      </div>
    </div>
  )
}

export function headline(connection: ConnectProps["connection"]): string {
  switch (connection) {
    case "starting":
    case "connecting":
      return "Connecting to Relo…"
    case "signingIn":
      return "Signing in…"
    case "offline":
      return "Relo is offline"
    case "needsSignIn":
      return SIGN_IN_WORDS.headlineAgain
    default:
      return SIGN_IN_WORDS.headline
  }
}

export function detail(connection: ConnectProps["connection"], origin: string | null, email: string | null, inBrowser = false): string {
  switch (connection) {
    case "starting":
      return "Starting Relo…"
    case "connecting":
      return `Reading your work from ${origin ?? "your server"}…`
    case "signingIn":
      return inBrowser ? "Finish signing in in the browser. If you use an iPhone, approve this PC there to read private work." : "Finish signing in in the Sign in to Relo window. If you use an iPhone, approve this PC there to read private work."
    case "offline":
      return `The last state stays here until ${origin ?? "the server"} answers.`
    case "needsSignIn":
      return `The server signed this PC out${email ? ` of ${email}` : ""}. ${SIGN_IN_WORDS.detail}`
    default:
      return SIGN_IN_WORDS.detail
  }
}
