// The title bar Relo's own windows draw themselves (Settings, Home) now that they have no native one: the Mac hides its
// title bar and lets the content run to the top edge (ReloGlass.prepare), so this is a transparent strip over the top of
// the window, a drag region with the Windows caption buttons at the right. Rust side: src-tauri/src/chrome.rs.
//
// Usage: render `<TitleBar title="Relo Settings" />` as the LAST child of a `position: relative` full-window root, so it
// sits over the content; leave `var(--chrome-h)` (32px) of room at the top of whatever should not run under it.
// The window needs `decorations: false`, `transparent: true`, `shadow: true` in tauri.conf.json and
// `chrome::apply_custom_chrome` in setup; its capability needs core:window:allow-start-dragging and
// core:window:allow-toggle-maximize (the drag region and double-click use them).
// It also sets `data-glass="on|off"` (a desktop backdrop is behind the page or not) and `data-maximized` on <html>.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { chromeClose, chromeMinimize, chromeReady, chromeSnapRect, chromeState, chromeToggleMaximize, glassActive, onChromeMax, onChromeState, type ChromeState } from "./ipc"
import "./chrome.css"

export interface TitleBarProps {
  /** The window's name, small at the left (the Windows convention; the Mac shows none). */
  title?: string
  /** Replaces the default Relo mark at the left. */
  icon?: ReactNode
  /** Extra content between the title and the buttons (it can take clicks; the rest of the bar drags). */
  children?: ReactNode
  /** Hide the maximize button for a window that cannot be maximized. */
  noMaximize?: boolean
}

const MARK = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
    <path d="M8 1.8l5.2 3v6.4L8 14.2l-5.2-3V4.8z" />
  </svg>
)

const GLYPH = {
  min: <path d="M0 5h10" />,
  max: <rect x="0.5" y="0.5" width="9" height="9" rx="1.2" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" />
      <path d="M2.5 2.5V1.7A1.2 1.2 0 013.7.5H8.3a1.2 1.2 0 011.2 1.2v4.6a1.2 1.2 0 01-1.2 1.2H7.5" />
    </>
  ),
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
}

function Glyph({ kind }: { kind: keyof typeof GLYPH }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPH[kind]}
    </svg>
  )
}

export function TitleBar({ title, icon, children, noMaximize }: TitleBarProps) {
  const [state, setState] = useState<ChromeState>({ maximized: false, focused: true })
  const [maxState, setMaxState] = useState({ hover: false, pressed: false })
  const maxRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void chromeState().then(setState)
    // "sim" is the dev preview's stand-in for the desktop blur (settings/main.tsx).
    void glassActive().then((on) => {
      if (document.documentElement.dataset.glass !== "sim") document.documentElement.dataset.glass = on ? "on" : "off"
    })
    chromeReady()
    const offs = [onChromeState(setState), onChromeMax(setMaxState)]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    document.documentElement.toggleAttribute("data-maximized", state.maximized)
  }, [state.maximized])

  // Tell Rust where the maximize button is, so Windows 11 shows Snap Layouts over it.
  useEffect(() => {
    const el = maxRef.current
    if (!el) return
    const send = () => {
      const r = el.getBoundingClientRect()
      const d = window.devicePixelRatio || 1
      chromeSnapRect(Math.round(r.left * d), Math.round(r.top * d), Math.round(r.width * d), Math.round(r.height * d))
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(document.documentElement)
    window.addEventListener("resize", send)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", send)
      chromeSnapRect(0, 0, 0, 0)
    }
  }, [noMaximize, state.maximized])

  const maxLabel = state.maximized ? "Restore" : "Maximize"
  return (
    <header className="relo-titlebar" data-tauri-drag-region data-focused={state.focused ? "" : undefined}>
      <div className="relo-titlebar-id" aria-hidden>
        <span className="relo-titlebar-mark">{icon ?? MARK}</span>
        {title && <span className="relo-titlebar-title">{title}</span>}
      </div>
      {children}
      <div className="relo-caption" role="group" aria-label="Window controls">
        <button type="button" className="cap" aria-label="Minimize" title="Minimize" onClick={chromeMinimize}>
          <Glyph kind="min" />
        </button>
        {!noMaximize && (
          <button
            ref={maxRef}
            type="button"
            className="cap"
            aria-label={maxLabel}
            title={maxLabel}
            data-hover={maxState.hover ? "" : undefined}
            data-pressed={maxState.pressed ? "" : undefined}
            onClick={chromeToggleMaximize}
          >
            <Glyph kind={state.maximized ? "restore" : "max"} />
          </button>
        )}
        <button type="button" className="cap" data-close="" aria-label="Close" title="Close" onClick={chromeClose}>
          <Glyph kind="close" />
        </button>
      </div>
    </header>
  )
}
