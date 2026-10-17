/**
 * The colors offered for "One color": the first eight of the server's accent palette
 * (apps/server/src/presentation-policy.ts `accentPalette`), so a chosen swatch is also a color the
 * server hands out per project. Kept here until contracts export the palette.
 */
export const ACCENT_SWATCHES = [
  { color: "#5CE1FF", name: "Cyan" },
  { color: "#8B7CFF", name: "Violet" },
  { color: "#D65CF0", name: "Orchid" },
  { color: "#4D8DFF", name: "Blue" },
  { color: "#34D399", name: "Mint" },
  { color: "#FBBF24", name: "Amber" },
  { color: "#FF6B57", name: "Coral" },
  { color: "#FF5CA8", name: "Pink" },
] as const

/** The example project's own color in the preview (the second entry of the palette). */
export const PREVIEW_PROJECT_COLOR = ACCENT_SWATCHES[1].color
