import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "../../index.css"
import { planFixtures } from "@/features/inbox/plan-fixtures"
import { PlanTree } from "@/features/inbox/plan-tree"
import { ThemeProvider } from "@/components/theme-provider"

/** Development preview of the plan tree: one panel per fixture, at the detail column's width. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="relo-plan-preview-theme">
      <main style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 24, padding: 24, maxWidth: 1400, margin: "0 auto" }}>
        {planFixtures.map((fixture, index) => (
          <div key={fixture.name} className="glass" style={{ padding: 18, borderRadius: 20 }}>
            <p className="micro" style={{ marginBottom: 12 }}>{fixture.name}</p>
            <PlanTree headingId={`plan-${index}`} entries={fixture.entries} rounds={fixture.rounds} standing={fixture.standing ?? "moving"} />
          </div>
        ))}
      </main>
    </ThemeProvider>
  </StrictMode>
)
