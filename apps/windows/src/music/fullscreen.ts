// Full screen behavior (FullscreenMediaDetection.swift, hideNotchOption): hide the notch for every full-screen app,
// only when the app playing music is the one in full screen, or never. Rust reports full screen (`notch_fullscreen`);
// "the playing app is in front" is `media_foreground_is_source`.

import { useEffect, useState } from "react"
import { fullscreenGet, onFullscreen } from "../bridge"
import { mediaForegroundIsSource } from "./ipc"
import { useMusic } from "./store"
import type { HideNotchOption } from "./types"

/** Pure decision: should the notch hide? */
export function hidesForFullscreen(option: HideNotchOption, fullscreen: boolean, foregroundIsMediaApp: boolean): boolean {
  if (!fullscreen) return false
  switch (option) {
    case "always":
      return true
    case "never":
      return false
    case "nowPlayingOnly":
      return foregroundIsMediaApp
  }
}

/** True while the notch should hide (the music setting; combine with the app's own quiet-in-full-screen rule). */
export function useHideForFullscreen(): boolean {
  const { settings, state } = useMusic()
  const [fullscreen, setFullscreen] = useState(false)
  const [media, setMedia] = useState(false)

  useEffect(() => {
    let alive = true
    void fullscreenGet().then((f) => alive && setFullscreen(f))
    const off = onFullscreen(setFullscreen)
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!fullscreen || settings.hideNotchOption !== "nowPlayingOnly") return setMedia(false)
    let alive = true
    void mediaForegroundIsSource().then((m) => alive && setMedia(m && state.active))
    return () => {
      alive = false
    }
  }, [fullscreen, settings.hideNotchOption, state.appId, state.active])

  return hidesForFullscreen(settings.hideNotchOption, fullscreen, media)
}
