// Music for Relo on Windows. How to wire it (files this change does not own):
//
//   1. Open notch tab (src/relo/tabs.ts):      registerTab(musicTab)            // id "home", the Mac's Music tab
//   2. Closed notch (Notch.tsx), when `useClosedMusic({ hiddenForFullscreen }).show`:
//        width  = closedMusicShape({ closedWidth: CLOSED.w, closedHeight: CLOSED.h, sneak, style }).width
//        content = <ClosedMusic closedHeight={CLOSED.h} />, and <SneakPeekStrip /> under it for the standard peek
//   3. Settings (src/settings/SettingsApp.tsx): see the registration comment in src/settings/media.tsx
//   4. Full screen: `const hide = useHideForFullscreen()` (media.json `hideNotchOption`), OR-ed with the app's own rule.

import type { ReactNode } from "react"
import { createElement } from "react"
import { MusicTabView } from "./MusicPlayer"
import { NoteIcon } from "./icons"

export { ClosedMusic, SneakPeekStrip, closedMusicShape, closedMusicExtraWidth, useClosedMusic } from "./ClosedMusic"
export { MusicTabView, AlbumArt, Slider, timeString } from "./MusicPlayer"
export { SlotConfig } from "./SlotConfig"
export { useHideForFullscreen, hidesForFullscreen } from "./fullscreen"
export { useMusic, musicStore, createMusicStore, shouldSneak, SNEAK_MS } from "./store"
export { useMediaSettings, mediaSettings } from "./settings"
export type { MediaSettings, MediaState } from "./types"

/** Shape of `TabDefinition` in src/relo/tabs.ts (view is a component without props; height 190 as on the Mac). */
export const musicTab: { id: string; label: string; icon: ReactNode; view: () => ReactNode; height: number } = {
  id: "home",
  label: "Music",
  icon: createElement(NoteIcon, { size: 14 }),
  view: MusicTabView,
  height: 190,
}
