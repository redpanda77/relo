/**
 * A Relo film: AV1, then HEVC, then H.264 from one folder (`relo-<name>-<codec>.mp4` and a poster), as
 * marketing/films/web.sh writes them. It loads nothing until it nears the viewport, plays muted while on
 * screen and pauses when it leaves; play/pause and sound buttons; reduced motion never autoplays. The page
 * that shows it allows the folder's origin in its CSP `media-src` (the server's film settings).
 */
import { Pause, Play, Volume2, VolumeX } from "lucide-react"
import * as React from "react"

import "@/components/film-player.css"

/** Smallest first: each browser plays the first source it can decode. */
const SOURCES = [
  { codec: "av1", type: 'video/mp4; codecs="av01.0.09M.10, mp4a.40.2"' },
  { codec: "hevc", type: 'video/mp4; codecs="hvc1.1.6.L123.B0, mp4a.40.2"' },
  { codec: "h264", type: "video/mp4" },
]

export function FilmPlayer({ base, name, label, poster = "poster.jpg" }: { base: string; name: string; label: string; poster?: string }) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = React.useState(true)
  const [playing, setPlaying] = React.useState(false)
  const [reducedMotion] = React.useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)

  React.useEffect(() => {
    const video = videoRef.current
    if (!video || typeof IntersectionObserver === "undefined") return
    // Start fetching a screen before it arrives; play only while most of it is visible.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && video.preload === "none") {
          video.preload = "auto"
          video.load()
        }
      },
      { rootMargin: "600px 0px" },
    )
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.intersectionRatio >= 0.55 && !reducedMotion) void video.play().catch(() => undefined)
        else if (entry.intersectionRatio < 0.2) video.pause()
      },
      { threshold: [0, 0.2, 0.55, 1] },
    )
    near.observe(video)
    seen.observe(video)
    const onHidden = () => document.hidden && video.pause()
    document.addEventListener("visibilitychange", onHidden)
    return () => {
      near.disconnect()
      seen.disconnect()
      document.removeEventListener("visibilitychange", onHidden)
    }
  }, [reducedMotion])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }
  const toggleSound = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
    if (!video.muted && video.paused) void video.play().catch(() => undefined)
  }

  return (
    <div className="film-frame">
      <video
        ref={videoRef}
        muted
        playsInline
        loop
        preload="none"
        poster={`${base}/${poster}`}
        aria-label={label}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        {SOURCES.map((source) => (
          <source key={source.codec} src={`${base}/relo-${name}-${source.codec}.mp4`} type={source.type} />
        ))}
      </video>
      <div className="film-controls">
        <button type="button" className="film-button" onClick={togglePlay} aria-label={playing ? "Pause the film" : "Play the film"}>
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </button>
        <button type="button" className="film-button" onClick={toggleSound} aria-label={muted ? "Turn the sound on" : "Mute the film"}>
          {muted ? <VolumeX className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
          <span>{muted ? "Sound on" : "Mute"}</span>
        </button>
      </div>
    </div>
  )
}
