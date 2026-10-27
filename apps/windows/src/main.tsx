import "@fontsource-variable/inter"
import "./styles.css"
import { createRoot } from "react-dom/client"
import { Notch } from "./Notch"
import { NotchBoundary, logUncaughtErrors } from "./NotchBoundary"
import { registerBuiltinTabs } from "./relo/builtinTabs"
import { isMirrorWindow, silenceMirror } from "./mirror"

// Every error is written to relo-windows.log: a notch that fails must leave a trace, never just vanish.
logUncaughtErrors()
// The tabs beyond Relo (System, Music, Shelf) in the Mac's order, before the first render.
registerBuiltinTabs()
// A mirror notch (one per extra display, "Show on all displays") makes no sound: the main notch plays the cues and speaks.
if (isMirrorWindow()) silenceMirror()
createRoot(document.getElementById("root")!).render(
  <NotchBoundary>
    <Notch />
  </NotchBoundary>,
)
