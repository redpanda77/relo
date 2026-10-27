// The Settings sidebar's pages: the Mac's (SettingsView.swift `ReloSettingsPage.all`) in the Mac's order. Plain data, so
// tests can check it against the Rust allow-list (src-tauri/src/settings_window.rs PAGES) and the window can render it.

export type PageGroup = "relo" | "notch" | "app"

export interface PageMeta {
  id: string
  title: string
  /** The tile's dark colour (the Mac's `colors[1]`): the tile's bottom and the selected pill. */
  color: string
  /** The tile's light colour (`colors[0]`), its top. */
  light: string
  group: PageGroup
  /** The glyph, as the `d` of a 16x16 stroked SVG path. */
  icon: string
}

export const PAGE_LIST: readonly PageMeta[] = [
  { id: "relo", title: "Relo", color: "#2b8fd6", light: "#5ce1ff", group: "relo", icon: "M8 1.8l5.2 3v6.4L8 14.2l-5.2-3V4.8z" },
  { id: "alerts", title: "Alerts", color: "#ff6b57", light: "#ff9a85", group: "relo", icon: "M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3" },
  { id: "voice", title: "Voice", color: "#7a68ff", light: "#a194ff", group: "relo", icon: "M3 6v4M6 3.5v9M9 5.5v5M12 4v8" },
  { id: "general", title: "General", color: "#666666", light: "#9e9e9e", group: "notch", icon: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11" },
  { id: "appearance", title: "Appearance", color: "#3a6fe0", light: "#5aa2ff", group: "notch", icon: "M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z" },
  { id: "media", title: "Media", color: "#e0457d", light: "#ff7aa8", group: "notch", icon: "M5 3.5l8 4.5-8 4.5z" },
  { id: "shelf", title: "Shelf", color: "#e08e0b", light: "#fbbf24", group: "notch", icon: "M3 13l1.6-5h6.8L13 13M3 13v1.5h10V13" },
  { id: "shortcuts", title: "Shortcuts", color: "#666666", light: "#999999", group: "notch", icon: "M2 5h12v6H2zM4.5 8h.01M7 8h2M11.5 8h.01" },
  { id: "advanced", title: "Advanced", color: "#666666", light: "#999999", group: "app", icon: "M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6M9 3.5v3M6 9.5v3" },
  { id: "about", title: "About", color: "#666666", light: "#999999", group: "app", icon: "M8 7v4.5M8 4.6v.01" },
]

export const PAGE_IDS: readonly string[] = PAGE_LIST.map((p) => p.id)
