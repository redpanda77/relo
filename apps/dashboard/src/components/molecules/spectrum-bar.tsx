import * as React from "react"

import { SIGNAL_CSS, SIGNAL_LABEL, SIGNAL_RAMP, mixShares, rgbCss, type NowMix } from "@/lib/signal"

const GAP = 3
/** The width a meaning's name needs in the 10.5px tracked mono caption; narrower segments show colour only. */
const labelWidth = (label: string) => label.length * 8.2 + 4

/**
 * Today's proportions by meaning, edge to edge: one thin segmented bar with each meaning's name
 * under the segments wide enough to hold it. Says what the colours mean without repeating counts.
 * Segments grow and shrink to a new mix (flex-grow, 600 ms) and labels fade rather than pop (now.css).
 */
export function SpectrumBar({ mix }: { mix: NowMix }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setWidth(element.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver !== "function") return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shares = mixShares(mix)
  if (!shares.length) return null
  const usable = width - GAP * Math.max(shares.length - 1, 0)
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`Today by kind: ${shares
        .map(({ signal, share }) => `${Math.round(share * 100)} percent ${SIGNAL_LABEL[signal].toLowerCase()}`)
        .join(", ")}`}
      className="flex min-h-[22px] items-start"
      style={{ gap: GAP }}
      data-hud-spectrum
    >
      {shares.map(({ signal, share }) => {
        const { light, deep } = SIGNAL_RAMP[signal]
        // Labels stay mounted and fade when their segment is too narrow, so a shifting mix never pops.
        const fits = usable * share >= labelWidth(SIGNAL_LABEL[signal])
        return (
          <div key={signal} className="spectrum-segment flex min-w-1 flex-col gap-1.5" data-signal={signal} style={{ flexGrow: share, flexShrink: 1, flexBasis: 0 }}>
            <span aria-hidden="true" className="block h-[3px] rounded-full" style={{ background: `linear-gradient(90deg, ${rgbCss(light)}, ${rgbCss(deep)})` }} />
            <span
              aria-hidden="true"
              className="spectrum-label micro whitespace-nowrap tracking-[0.12em]"
              data-fits={fits || undefined}
              style={{ color: SIGNAL_CSS[signal] }}
            >
              {SIGNAL_LABEL[signal]}
            </span>
          </div>
        )
      })}
    </div>
  )
}
