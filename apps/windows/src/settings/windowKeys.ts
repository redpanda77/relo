// The Settings window's own keys, the Mac's menu shortcuts: Command-comma opens Settings, Command-Q quits (K03).
// Here the window is Settings itself, so Ctrl+, brings it forward on the page it shows.

export type WindowKeyAction = "settings" | "quit"

/** The action a key press means, or null. Plain Ctrl (no Alt, Shift or Meta) with `,` or `q`. */
export function shortcutAction(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): WindowKeyAction | null {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null
  if (e.key === ",") return "settings"
  if (e.key === "q" || e.key === "Q") return "quit"
  return null
}
