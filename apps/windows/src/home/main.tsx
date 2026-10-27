import "@fontsource-variable/inter"
import "../relo/ui/relo-ui.css"
import "./home.css"
import { createRoot } from "react-dom/client"
import { HomeApp } from "./HomeApp"

createRoot(document.getElementById("root")!).render(<HomeApp />)
