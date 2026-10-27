// MarqueeText: a single line that scrolls to and fro when it does not fit.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"

export function Marquee({ text, color, className, style, minDuration = 4 }: { text: string; color?: string; className?: string; style?: CSSProperties; minDuration?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      if (box.current && inner.current) setOverflow(Math.max(0, Math.ceil(inner.current.scrollWidth - box.current.clientWidth)))
    }
    measure()
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    if (ro && box.current) ro.observe(box.current)
    return () => ro?.disconnect()
  }, [text])

  const dur = Math.max(minDuration, overflow / 28 + 2)
  return (
    <div ref={box} className={className} style={{ overflow: "hidden", whiteSpace: "nowrap", color, ...style }} title={overflow > 0 ? text : undefined}>
      <span
        ref={inner}
        className={overflow > 0 ? "mu-marquee" : undefined}
        style={{ display: "inline-block", ["--mu-shift" as string]: `-${overflow}px`, ["--mu-dur" as string]: `${dur}s` }}
      >
        {text}
      </span>
    </div>
  )
}
