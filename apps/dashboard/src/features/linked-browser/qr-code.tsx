import qrcode from "qrcode-generator"
import { useMemo } from "react"

import { cn } from "@/lib/utils"

const QUIET_ZONE = 4

/** The dark modules of `value` as one SVG path, in module units (generated locally, no network). */
function qrPath(value: string): { size: number; d: string } {
  const qr = qrcode(0, "M")
  qr.addData(value, "Byte")
  qr.make()
  const count = qr.getModuleCount()
  let d = ""
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`
    }
  }
  return { size: count + QUIET_ZONE * 2, d }
}

/** A QR code drawn black on white in every theme, so phone cameras read it. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => qrPath(value), [value])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn("block aspect-square w-full max-w-56 rounded-lg", className)}
      data-qr-value={value}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
