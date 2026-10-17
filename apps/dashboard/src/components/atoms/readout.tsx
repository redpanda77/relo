import { AnimatedNumber } from "@/components/atoms/animated-number"
import { cn } from "@/lib/utils"

/**
 * An instrument readout: a mono label over flat rounded numerals, in its meaning's colour when lit.
 * A count rolls to its new value; the colour fades as it lights.
 */
export function Readout({
  label,
  value,
  color,
  lit,
  className,
}: {
  label: string
  value: number | string
  color: string
  lit: boolean
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-readout={label} data-lit={lit || undefined} style={{ ["--n" as string]: typeof value === "number" ? Math.min(value, 10) : 0, ["--tone" as string]: color }}>
      <span className="readout-label micro truncate" style={lit ? { color } : undefined}>{label}</span>
      <span className="readout-value numeral text-[1.75rem] leading-none" style={{ color: lit ? color : "var(--muted-foreground)" }}>
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </span>
    </div>
  )
}
