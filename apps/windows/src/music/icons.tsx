// The player's glyphs (the Mac uses SF Symbols): 16-unit viewBox, currentColor.

import type { ReactNode } from "react"
import type { MusicControl } from "./types"

function Svg({ size = 18, filled = false, children }: { size?: number; filled?: boolean; children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const PlayIcon = ({ size }: { size?: number }) => (
  <Svg size={size} filled>
    <path d="M4.2 2.4v11.2a.5.5 0 00.76.43l9-5.6a.5.5 0 000-.86l-9-5.6a.5.5 0 00-.76.43z" />
  </Svg>
)
export const PauseIcon = ({ size }: { size?: number }) => (
  <Svg size={size} filled>
    <rect x="3.6" y="2.4" width="3.2" height="11.2" rx="1" />
    <rect x="9.2" y="2.4" width="3.2" height="11.2" rx="1" />
  </Svg>
)
export const BackwardIcon = ({ size }: { size?: number }) => (
  <Svg size={size} filled>
    <path d="M7.6 3.6v8.8a.4.4 0 01-.62.33L1.5 8.33a.4.4 0 010-.66l5.48-4.4a.4.4 0 01.62.33zM14.4 3.6v8.8a.4.4 0 01-.62.33L8.3 8.33a.4.4 0 010-.66l5.48-4.4a.4.4 0 01.62.33z" />
  </Svg>
)
export const ForwardIcon = ({ size }: { size?: number }) => (
  <Svg size={size} filled>
    <path d="M8.4 3.6v8.8a.4.4 0 00.62.33l5.48-4.4a.4.4 0 000-.66L9.02 3.27a.4.4 0 00-.62.33zM1.6 3.6v8.8a.4.4 0 00.62.33l5.48-4.4a.4.4 0 000-.66L2.22 3.27a.4.4 0 00-.62.33z" />
  </Svg>
)
export const ShuffleIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M1.8 4.5h2.2c3 0 4 7 7 7h3.2M1.8 11.5h2.2c.9 0 1.6-.8 2.2-1.8M8.4 6.4c.7-1.1 1.5-1.9 2.6-1.9h3.2M12 2.6l2.2 1.9L12 6.4M12 9.6l2.2 1.9-2.2 1.9" />
  </Svg>
)
export const RepeatIcon = ({ size, one = false }: { size?: number; one?: boolean }) => (
  <Svg size={size}>
    <path d="M2.4 7.2V6.4a2.4 2.4 0 012.4-2.4h8.4M11 1.8L13.2 4 11 6.2M13.6 8.8v.8a2.4 2.4 0 01-2.4 2.4H2.8M5 9.8L2.8 12 5 14.2" />
    {one && <path d="M7.2 7.6l1-.6v3.6" strokeWidth={1.1} />}
  </Svg>
)
export const HeartIcon = ({ size, filled = false }: { size?: number; filled?: boolean }) => (
  <Svg size={size} filled={filled}>
    <path d="M8 13.6S1.8 10.2 1.8 6a3.1 3.1 0 016.2-.9A3.1 3.1 0 0114.2 6C14.2 10.2 8 13.6 8 13.6z" stroke={filled ? "none" : "currentColor"} />
  </Svg>
)
export const SkipIcon = ({ size, forward }: { size?: number; forward: boolean }) => (
  <Svg size={size}>
    <path d={forward ? "M12.6 8a4.9 4.9 0 11-1.5-3.5M12.9 2.2v2.6h-2.6" : "M3.4 8a4.9 4.9 0 101.5-3.5M3.1 2.2v2.6h2.6"} />
    <text x="8" y="10.2" textAnchor="middle" fontSize="5.6" fontWeight="700" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">
      15
    </text>
  </Svg>
)
export const SpeakerIcon = ({ size, level }: { size?: number; level: 0 | 1 | 2 | 3 }) => (
  <Svg size={size}>
    <path d="M2.4 6.2h2.2L8 3.4v9.2L4.6 9.8H2.4z" fill="currentColor" />
    {level === 0 && <path d="M10.4 6l3.2 4M13.6 6l-3.2 4" />}
    {level >= 1 && <path d="M10.4 6.4a2.4 2.4 0 010 3.2" />}
    {level >= 2 && <path d="M12 4.8a4.6 4.6 0 010 6.4" />}
    {level >= 3 && <path d="M13.5 3.4a6.6 6.6 0 010 9.2" />}
  </Svg>
)
export const NoteIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 12V4.2l7-1.5V10.5M6 12a1.9 1.5 0 11-3.8 0A1.9 1.5 0 016 12zM13 10.5a1.9 1.5 0 11-3.8 0 1.9 1.5 0 013.8 0z" />
  </Svg>
)
export const TrashIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.8 4.2h10.4M6 4.2V2.8h4v1.4M4.2 4.2l.5 9h6.6l.5-9" />
  </Svg>
)

/** The glyph for a slot control in the settings palette (static, no state). */
export function ControlGlyph({ control, size }: { control: MusicControl; size?: number }) {
  switch (control) {
    case "shuffle":
      return <ShuffleIcon size={size} />
    case "previous":
      return <BackwardIcon size={size} />
    case "playPause":
      return <PlayIcon size={size} />
    case "next":
      return <ForwardIcon size={size} />
    case "repeatMode":
      return <RepeatIcon size={size} />
    case "volume":
      return <SpeakerIcon size={size} level={3} />
    case "favorite":
      return <HeartIcon size={size} />
    case "goBackward":
      return <SkipIcon size={size} forward={false} />
    case "goForward":
      return <SkipIcon size={size} forward />
    default:
      return null
  }
}
