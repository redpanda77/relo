// A line that scrolls when it is longer than its room (components/Live activities/MarqueeTextView.swift): the text twice
// with a 20 pt gap, shifted left by (width + 10) at 30 pt per second, linear, after `minDuration` seconds, forever.
// Shorter text sits still.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"

export const MARQUEE_SPEED = 30
export const MARQUEE_GAP = 20

/** The scroll's distance and duration for a text of `textWidth` pt, or null when it fits `frameWidth`. */
export function marqueeMotion(textWidth: number, frameWidth: number): { distance: number; duration: number } | null {
  if (!(textWidth > frameWidth) || frameWidth <= 0) return null
  return { distance: textWidth + 10, duration: textWidth / MARQUEE_SPEED }
}

export function Marquee({ text, minDuration = 3, className, style }: { text: string; minDuration?: number; className?: string; style?: CSSProperties }) {
  const frame = useRef<HTMLSpanElement>(null)
  const first = useRef<HTMLSpanElement>(null)
  const [scroll, setScroll] = useState<{ distance: number; duration: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const next = marqueeMotion(first.current?.offsetWidth ?? 0, frame.current?.clientWidth ?? 0)
      setScroll((prev) => (prev?.distance === next?.distance && prev?.duration === next?.duration ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (frame.current) ro.observe(frame.current)
    return () => ro.disconnect()
  }, [text])

  return (
    <span ref={frame} className={`ro-marquee ${className ?? ""}`} style={style} title={text}>
      <span
        key={text}
        className="ro-marquee-run"
        style={scroll ? ({ ["--ro-dist" as string]: `-${scroll.distance}px`, animation: `ro-marquee ${scroll.duration}s linear ${minDuration}s infinite` } as CSSProperties) : undefined}
      >
        <span ref={first}>{text}</span>
        {scroll && <span style={{ marginLeft: MARQUEE_GAP }} aria-hidden>{text}</span>}
      </span>
    </span>
  )
}
