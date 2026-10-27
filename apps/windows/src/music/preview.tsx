// Dev harness (not shipped): `vite` then http://localhost:1420/src/music/preview.html?musicMock=1 shows the open player
// and the closed activity in their notch shapes. Inside Tauri it shows live data.

import "@fontsource-variable/inter"
import "../styles.css"
import { createRoot } from "react-dom/client"
import { CLOSED, outline } from "../geometry"
import { ClosedMusic, SneakPeekStrip, closedMusicShape } from "./ClosedMusic"
import { MusicTabView } from "./MusicPlayer"
import { useMusic } from "./store"

function Shape({ w, h, top, bottom, children }: { w: number; h: number; top: number; bottom: number; children: React.ReactNode }) {
  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width={w} height={h}>
        <path d={outline(w, h, top, bottom)} fill="#000" stroke="rgb(255 255 255 / 0.16)" />
      </svg>
      <div style={{ position: "absolute", inset: 0 }}>{children}</div>
    </div>
  )
}

function Preview() {
  const { sneak } = useMusic()
  const closed = (style: "standard" | "inline", peek: boolean) => closedMusicShape({ closedWidth: CLOSED.w, closedHeight: CLOSED.h, sneak: peek, style })
  const std = closed("standard", false)
  const strip = closed("standard", true)
  const inl = closed("inline", true)
  void sneak
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, padding: "0 0 24px" }}>
      <Shape w={640} h={190} top={19} bottom={24}>
        <div style={{ height: 32 }} />
        <div style={{ position: "absolute", left: 19, right: 19, top: 32, bottom: 0 }}>
          <MusicTabView />
        </div>
      </Shape>
      <Shape w={std.width} h={CLOSED.h} top={CLOSED.top} bottom={CLOSED.bottom}>
        <div style={{ padding: "0 14px" }}>
          <ClosedMusic />
        </div>
      </Shape>
      <Shape w={strip.width} h={CLOSED.h + strip.extraHeight} top={CLOSED.top} bottom={CLOSED.bottom}>
        <div style={{ padding: "0 14px" }}>
          <ClosedMusic />
        </div>
        <SneakPeekStrip />
      </Shape>
      <Shape w={inl.width} h={CLOSED.h} top={CLOSED.top} bottom={CLOSED.bottom}>
        <div style={{ padding: "0 14px" }}>
          <ClosedMusic inline />
        </div>
      </Shape>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
