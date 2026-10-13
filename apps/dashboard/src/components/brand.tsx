import { cn } from "@/lib/utils"

/** The orb mark: a hairline ring with a luminous core, the same instrument as the Now deck. */
export function BrandOrb({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("brand-orb size-8", className)} />
}

/** Orb plus the rounded lowercase wordmark, as on the iPhone's Welcome screen. */
export function BrandLockup({
  className,
  orbClassName,
}: {
  className?: string
  orbClassName?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandOrb className={orbClassName} />
      <span className="wordmark text-[1.45rem]">relo</span>
    </span>
  )
}
