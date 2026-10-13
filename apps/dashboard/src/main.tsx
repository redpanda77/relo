import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { readDashboardBootstrap } from "@/app/bootstrap"
import { preloadAllDashboardPages } from "@/app/dashboard-page-loaders"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { TooltipProvider } from "@/components/ui/tooltip"

const bootstrap = readDashboardBootstrap()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="relo-dashboard-theme">
      <TooltipProvider>
        <App bootstrap={bootstrap} />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)

if (bootstrap.kind !== "auth") preloadAllDashboardPages()
