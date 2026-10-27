import { PROJECT_PALETTE } from "@relo/notification-contracts"

/**
 * A project's colour by its palette slot, from the contracts' one table (`PROJECT_PALETTE`), so a project
 * reads the same on the Dashboard, the iPhone, the Mac and the notch. The server stores only the slot.
 */
export const PROJECT_COLORS = PROJECT_PALETTE

export function projectColor(slot: number): string {
  const count = PROJECT_COLORS.length
  return PROJECT_COLORS[((slot % count) + count) % count]!
}
