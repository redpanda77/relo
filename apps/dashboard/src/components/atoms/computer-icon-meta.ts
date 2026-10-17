import { Cloud, Hammer, Laptop, Monitor, Server, SquareTerminal, type LucideIcon } from "lucide-react"
import { COMPUTER_ICONS, type ComputerIcon } from "@relo/notification-contracts"

/** The six icons a computer can show (ADR 0011, D4): the label the owner reads and the glyph, in the contract's order. */
export const COMPUTER_ICON_META: Record<ComputerIcon, { label: string; glyph: LucideIcon }> = {
  laptop: { label: "Laptop", glyph: Laptop },
  desktop: { label: "Desktop", glyph: Monitor },
  server: { label: "Server", glyph: Server },
  cloud: { label: "Cloud", glyph: Cloud },
  terminal: { label: "Terminal", glyph: SquareTerminal },
  build: { label: "Build machine", glyph: Hammer },
}

export const COMPUTER_ICON_LIST: ReadonlyArray<ComputerIcon> = COMPUTER_ICONS

