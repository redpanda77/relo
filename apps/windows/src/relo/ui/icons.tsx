// Small glyphs for the notch (the Mac uses SF Symbols): one per tone, per computer icon (COMPUTER_ICONS in
// packages/contracts/src/computers.ts) and the few controls. 16-unit viewBox, stroke or fill from currentColor.

import type { ReactNode } from "react"
import type { Tone } from "../presentation"

function Svg({ size = 10, children, filled = false }: { size?: number; children: ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function ToneIcon({ tone, size }: { tone: Tone; size?: number }) {
  switch (tone) {
    case "needsYou": // bubble with an exclamation
      return (
        <Svg size={size}>
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          <path d="M8 5.6v2M8 9.2v.1" />
        </Svg>
      )
    case "yourTurn": // raised hand
      return (
        <Svg size={size}>
          <path d="M5 8V3.5M7.5 8V2.5M10 8V3.5M12.5 9V5M5 8l-1.5-1.2M12.5 9c0 3-1.8 4.5-4.5 4.5S5 12 5 10" />
        </Svg>
      )
    case "working": // waveform
      return (
        <Svg size={size}>
          <path d="M2 8v0M5 5v6M8 2.5v11M11 5v6M14 8v0" />
        </Svg>
      )
    case "quiet": // moon
      return (
        <Svg size={size}>
          <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />
        </Svg>
      )
    case "paused":
      return (
        <Svg size={size} filled>
          <rect x="4" y="3" width="2.8" height="10" rx="0.8" />
          <rect x="9.2" y="3" width="2.8" height="10" rx="0.8" />
        </Svg>
      )
    case "done":
      return (
        <Svg size={size}>
          <path d="M3 8.5l3.2 3.2L13 4.5" strokeWidth={2.2} />
        </Svg>
      )
    case "failed":
      return (
        <Svg size={size}>
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth={2.2} />
        </Svg>
      )
    case "dropped":
      return (
        <Svg size={size} filled>
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
        </Svg>
      )
    case "leftUnfinished":
      return (
        <Svg size={size}>
          <path d="M8 2.5l6 10.5H2z" />
          <path d="M8 6.5v3M8 11.2v.1" />
        </Svg>
      )
  }
}

export function ComputerIcon({ name, size = 11 }: { name: string | null; size?: number }) {
  switch (name) {
    case "desktop":
      return (
        <Svg size={size}>
          <rect x="2" y="2.5" width="12" height="8" rx="1.2" />
          <path d="M6 13.5h4M8 10.5v3" />
        </Svg>
      )
    case "server":
      return (
        <Svg size={size}>
          <rect x="2.5" y="2.5" width="11" height="4" rx="1" />
          <rect x="2.5" y="9.5" width="11" height="4" rx="1" />
          <path d="M5 4.5v0M5 11.5v0" />
        </Svg>
      )
    case "cloud":
      return (
        <Svg size={size}>
          <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6 1 2.6 2.6 0 0 1-.3 5z" />
        </Svg>
      )
    case "terminal":
      return (
        <Svg size={size}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M5 6.5l2 1.8-2 1.8M8.8 10.4h2.4" />
        </Svg>
      )
    case "build":
      return (
        <Svg size={size}>
          <path d="M9.5 3a3 3 0 0 0 3.2 4l-6.7 6.2a1.4 1.4 0 0 1-2-2L10.2 5" />
        </Svg>
      )
    default: // laptop
      return (
        <Svg size={size}>
          <rect x="3" y="3" width="10" height="7" rx="1" />
          <path d="M1.5 12.5h13" />
        </Svg>
      )
  }
}

export function Chevron({ size = 9 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 3.5L10.5 8 6 12.5" strokeWidth={2.2} />
    </Svg>
  )
}

export function Lock({ size = 10 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  )
}

export function Check({ size = 11 }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.2 8.2l2 2 3.6-3.8" />
    </Svg>
  )
}

/** A feed that is not answering (LocalMode.offlineSymbol): the exclamation circle for Relo on this PC, the crossed wifi for a server. */
export function OfflineIcon({ local, size = 11 }: { local: boolean; size?: number }) {
  return local ? (
    <Svg size={size}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.4M8 10.6v.1" />
    </Svg>
  ) : (
    <Svg size={size}>
      <path d="M2 6.2a8.5 8.5 0 0 1 12 0M4.2 8.8a5.4 5.4 0 0 1 7.6 0M6.4 11.4a2.3 2.3 0 0 1 3.2 0" />
      <path d="M2.5 2.5l11 11" />
    </Svg>
  )
}

export function ExternalLink({ size = 10 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </Svg>
  )
}
