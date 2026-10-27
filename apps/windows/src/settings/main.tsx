import "@fontsource-variable/inter"
import "./settings.css"
import { createRoot } from "react-dom/client"
import { glassActive } from "../chrome/ipc"
import { SettingsApp } from "./SettingsApp"
import { settingsStore } from "./store"

// Development only: `settings.html?preview=1&page=<id>` opens the pages (not the onboarding) of a signed-in PC in a plain
// browser, so they can be seen and screenshotted without the app. `&glass=sim` stands in for the Acrylic desktop blur
// (a colourful wallpaper under the Mac's tint), `&onboarding=1` shows the first-run flow. Never active in a build.
const params = new URLSearchParams(location.search)
if (import.meta.env.DEV && params.get("preview") === "1") {
  if (params.get("glass") === "sim") document.documentElement.dataset.glass = "sim"
  void settingsStore.start().then(() =>
    settingsStore.update(
      params.get("onboarding") === "1"
        ? { onboardingDone: false }
        : { onboardingDone: true, onboarding: null, serverOrigin: "https://relo.example.com", accountEmail: "owner@example.com", lastPage: params.get("page") },
    ),
  )
}

// A desktop backdrop behind the page (glass.rs) means a transparent page; without one the page paints its own base.
void glassActive().then((on) => {
  if (document.documentElement.dataset.glass !== "sim") document.documentElement.dataset.glass = on ? "on" : "off"
})

createRoot(document.getElementById("root")!).render(<SettingsApp />)
