// The Settings window: the Mac's sidebar (Relo, Alerts, Voice / NOTCH: General, Appearance, Media, Shelf, Shortcuts / Advanced, About)
// with the page beside it; or the first-run onboarding until it is done.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { TitleBar } from "../chrome/TitleBar"
import { COLORS } from "../relo/ui/theme"
import { uiCue } from "../sound"
import { onSettingsPage, openSettings, pageTake, quitRelo } from "./ipc"
import { shortcutAction } from "./windowKeys"
import { Onboarding } from "./onboarding/Onboarding"
import { MediaPage } from "./media"
import { PAGE_LIST, type PageMeta } from "./pageList"
import { ShelfPage } from "./shelf"
import { AboutPage, AdvancedPage, AlertsPage, AppearancePage, GeneralPage, ReloPage, ShortcutsPage, VoicePage } from "./pages"
import { useSettings } from "./store"

export interface PageDef extends Omit<PageMeta, "icon"> {
  icon: ReactNode
}

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const POWER = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
    <path d="M8 2v5.2M4.6 4.2a5 5 0 106.8 0" />
  </svg>
)

/** The window's glass: the Mac's ReloGlassBackdrop (blurred desktop, tint, two slow lights in violet and azure, a sheen). The blur
 *  and tint are the system's Acrylic behind a transparent page (glass.rs); this paints the lights and, when no Acrylic is
 *  behind the page, a flat stand-in for the blurred desktop. */
function Backdrop() {
  return (
    <div className="glass-bg" aria-hidden>
      <i className="blob a" />
      <i className="blob b" />
      <i className="sheen" />
    </div>
  )
}

export const PAGES: PageDef[] = PAGE_LIST.map((p) => ({ ...p, icon: svg(p.icon) }))

export function SettingsApp() {
  const { settings, update, loaded } = useSettings()
  const [page, setPage] = useState<string>("relo")
  const pageRef = useRef(page)
  pageRef.current = page

  // Accent and motion apply to this window at once.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--tone", COLORS[settings.accent])
    if (settings.reduceMotion) root.setAttribute("data-reduce-motion", "")
    else root.removeAttribute("data-reduce-motion")
  }, [settings.accent, settings.reduceMotion])

  // The page asked for by open_settings: the one waiting from before this script ran, then later ones.
  useEffect(() => {
    const take = (p: string | null) => p && PAGES.some((d) => d.id === p) && setPage(p)
    void pageTake().then(take)
    return onSettingsPage(take)
  }, [])
  useEffect(() => {
    if (loaded && settings.lastPage && PAGES.some((d) => d.id === settings.lastPage)) setPage((cur) => (cur === "relo" ? settings.lastPage! : cur))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // Ctrl+, brings Settings forward on the page it shows; Ctrl+Q quits (the Mac's Command-comma and Command-Q, K03).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutAction(e)
      if (action === "settings") {
        e.preventDefault()
        void openSettings(pageRef.current)
      } else if (action === "quit") {
        e.preventDefault()
        void quitRelo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!loaded) return null
  if (!settings.onboardingDone) {
    return (
      <div className="shell shell-ob">
        <Backdrop />
        <Onboarding />
        <TitleBar title="Relo Settings" />
      </div>
    )
  }

  const go = (id: string) => {
    // A page turn in Settings sounds `section`; opening Settings and the first page are silent (G14).
    if (id !== page) uiCue("section")
    setPage(id)
    update({ lastPage: id })
  }
  const item = (d: PageDef) => (
    <button key={d.id} type="button" className="side-item" style={{ ["--pc" as string]: d.color, ["--pl" as string]: d.light }} aria-current={page === d.id ? "page" : undefined} onClick={() => go(d.id)}>
      <span className="tile">{d.icon}</span>
      {d.title}
    </button>
  )
  const props = { s: settings, set: update }
  return (
    <div className="shell">
      <Backdrop />
      <nav className="sidebar" aria-label="Settings">
        {PAGES.filter((d) => d.group === "relo").map(item)}
        <div className="side-label">NOTCH</div>
        {PAGES.filter((d) => d.group === "notch").map(item)}
        <div style={{ flex: 1 }} />
        {PAGES.filter((d) => d.group === "app").map(item)}
        <button type="button" className="quit" onClick={() => void quitRelo()}>
          {POWER}
          Quit Relo
        </button>
      </nav>
      <div className="detail">
      <main className="main" key={page}>
        {page === "relo" && <ReloPage {...props} />}
        {page === "alerts" && <AlertsPage {...props} />}
        {page === "voice" && <VoicePage {...props} />}
        {page === "general" && <GeneralPage {...props} />}
        {page === "appearance" && <AppearancePage {...props} />}
        {page === "media" && <MediaPage />}
        {page === "shelf" && <ShelfPage />}
        {page === "shortcuts" && <ShortcutsPage set={update} />}
        {page === "advanced" && <AdvancedPage {...props} onReset={() => setPage("relo")} />}
        {page === "about" && <AboutPage />}
      </main>
      </div>
      <TitleBar title="Relo Settings" />
    </div>
  )
}
