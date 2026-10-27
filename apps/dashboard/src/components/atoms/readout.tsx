import { AnimatedNumber } from "@/components/atoms/animated-number"
import { cn } from "@/lib/utils"

/**
 * A gauge tag: a pill docked on its quadrant of the Now deck's ring, the count in rounded numerals
 * and a mono label, in its meaning's colour when lit (a dashed pill at zero). Its place is the
 * stylesheet's (`.now-deck-readouts > [data-readout]:nth-child(n)`), the server's first frame paints
 * the same markup. `dim` is the offline look (numbers at white 60%); a count rolls to its new value.
 */
export function Readout({
  label,
  value,
  color,
  lit,
  dim = false,
  className,
}: {
  label: string
  value: number | string
  color: string
  lit: boolean
  dim?: boolean
  className?: string
}) {
  return (
    <div className={cn("now-tag", className)} data-readout={label} data-lit={lit || undefined} data-dim={dim || undefined} style={{ ["--tone" as string]: color }}>
      <span className="readout-value numeral">{typeof value === "number" ? <AnimatedNumber value={value} /> : value}</span>
      <span className="readout-label">{label}</span>
    </div>
  )
}
