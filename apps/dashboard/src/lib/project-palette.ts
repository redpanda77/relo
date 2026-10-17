/**
 * Twelve project hues along the neon ramp, one per palette slot, so a project keeps one colour
 * everywhere (Projects, Now, History). The server stores only the slot.
 */
export const PROJECT_COLORS = [
  "#5CE1FF", "#8B7CFF", "#D65CF0", "#FF8A7A", "#34D399", "#FBBF24",
  "#7DD3FC", "#A78BFA", "#F472B6", "#FDBA74", "#6EE7B7", "#FDE047",
] as const

export function projectColor(slot: number): string {
  const count = PROJECT_COLORS.length
  return PROJECT_COLORS[((slot % count) + count) % count]!
}
