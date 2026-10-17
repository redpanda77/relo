import type { ComputerIcon as ComputerIconName } from "@relo/notification-contracts"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"

import { cn } from "@/lib/utils"

/** A computer's glyph. Decorative: the computer's name beside it is the accessible name. */
export function ComputerIcon({
  icon,
  className,
  style,
}: {
  icon: ComputerIconName
  className?: string
  style?: React.CSSProperties
}) {
  const Glyph = COMPUTER_ICON_META[icon].glyph
  return <Glyph aria-hidden="true" className={cn("size-4", className)} style={style} />
}
