import { StrictMode, startTransition, type ReactNode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import "./features/docs/docs.css"
import App from "./App.tsx"
import { readDashboardBootstrap } from "@/app/bootstrap"
import { preloadAllDashboardPages, preloadDashboardPage } from "@/app/dashboard-page-loaders"
import { setLoadingPage } from "@/app/loading-page"
import { openSealedFirst } from "@/app/sealed-bootstrap"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { TooltipProvider } from "@/components/ui/tooltip"
import { handOffSkeleton, keepSkeletonOnBeat } from "@/app/skeleton-handoff"
import { startHeartbeat } from "@/lib/heartbeat"

/** How long a linked browser waits for its sealed text before showing the page without it. */
const SEALED_BUDGET_MS = 800

const bootstrap = readDashboardBootstrap()
const root = createRoot(document.getElementById("root")!)
const render = (page: ReactNode) =>
  root.render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark" storageKey="relo-dashboard-theme">
        <TooltipProvider>{page}</TooltipProvider>
      </ThemeProvider>
    </StrictMode>
  )

// A docs page is already on screen (the server rendered its article): mount only once the docs layout
// has loaded, so React never replaces the article with an empty loading frame.
if (bootstrap.kind === "docs")
  void import("@/features/docs/docs-site").then(({ DocsSite }) => render(<DocsSite bootstrap={bootstrap} />))
else if (bootstrap.kind === "auth") render(<App bootstrap={bootstrap} />)
else {
  // The server painted this page's structure (dashboard-skeleton.ts). The page's heartbeat keeps
  // the beat its core was already breathing on, the rest of its loops join it, then render once the page's code is here and a linked browser has opened its
  // sealed text (or the budget ran out), so React's first commit replaces the skeleton with the
  // real page at the same geometry, never with a loading fallback. The render is a transition, so
  // the skeleton stays on screen until that commit.
  startHeartbeat()
  keepSkeletonOnBeat()
  setLoadingPage(bootstrap.kind, bootstrap.shell.title)
  void Promise.all([
    preloadDashboardPage(bootstrap).catch(() => undefined),
    openSealedFirst(bootstrap, SEALED_BUDGET_MS),
  ]).then(([, page]) => {
    const handOff = handOffSkeleton()
    startTransition(() => render(<App bootstrap={page} />))
    handOff()
    preloadAllDashboardPages()
  })
}
