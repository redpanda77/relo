import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** A round glyph tinted in a meaning's colour: the leading mark of a log row. Its tint crossfades when the meaning changes (now.css). */
export function SignalGlyph({ icon: Icon, color, mark, className }: { icon?: LucideIcon; color: string; mark?: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("signal-glyph grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold", className)}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {mark ?? (Icon ? <Icon className="size-3.5" /> : null)}
    </span>
  )
}
