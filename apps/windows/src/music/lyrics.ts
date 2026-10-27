// Lyrics (MusicManager.parseLRC / lyricLine). The text comes from LRCLIB through Rust (media_lyrics); this parses the
// synced LRC and finds the line for a position.

export interface LrcLine {
  time: number
  text: string
}

const LRC = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,2}))?\]/

/** `[mm:ss.xx] text` lines to {time, text}, sorted; lines without text or a timestamp are dropped. */
export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const line of lrc.split("\n")) {
    const m = LRC.exec(line)
    if (!m) continue
    const text = line.slice(m.index + m[0].length).trim()
    if (!text) continue
    out.push({ time: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 100 : 0), text })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** The last line at or before `elapsed` (the first line before any has started, as the Mac does). */
export function lineAt(lines: readonly LrcLine[], elapsed: number): string {
  if (lines.length === 0) return ""
  let lo = 0
  let hi = lines.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= elapsed) {
      idx = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return lines[idx].text
}

export interface LyricsView {
  fetching: boolean
  plain: string
  synced: LrcLine[]
}

/** What the lyrics row shows (NotchHomeView): loading, the synced line, the plain text on one line, or none. */
export function lyricsLine(v: LyricsView, elapsed: number): string {
  if (v.fetching) return "Loading lyrics…"
  if (v.synced.length > 0) return lineAt(v.synced, elapsed)
  const t = v.plain.trim()
  return t ? t.replace(/\n/g, " ") : "No lyrics found"
}

/** Persian/Arabic script gets its own font on the Mac (Vazirmatn). */
export function isArabicScript(s: string): boolean {
  return /[؀-ۿ]/.test(s)
}
