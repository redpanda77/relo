/**
 * Opens a work's plan from its sealed card text (docs/ENCRYPTION-PROTOCOL.md, v2: phases by id), the way the
 * iPhone's `InboxSealedNotice.openingPlan` does: labels are matched by step id, never by position unless the
 * v1 list and the plan agree in length.
 */

/** What the server writes in place of a label it may not read. */
export const isPlaceholderLabel = (label: string) => /^Step \d+$/u.test(label.trim())

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)

/**
 * Opens a plan's sealed text into `plan` and `rounds` (mutating the opened copy): step labels and details by
 * step id from `phases[].steps[]`, round titles and outcomes from the phase `r<n>`. A placeholder ("Step 3") is
 * never a label. Without v2 phases the v1 list matches by position only when the counts agree.
 */
export function openPlanText(content: Json, plan: unknown, rounds: unknown): void {
  const phases = Array.isArray(content.phases) ? content.phases.filter(isJson) : []
  const labels = new Map<string, string>()
  const details = new Map<string, string>()
  for (const phase of phases) {
    for (const step of Array.isArray(phase.steps) ? phase.steps.filter(isJson) : []) {
      const id = str(step.id)
      if (!id) continue
      const label = str(step.label)
      if (label && !isPlaceholderLabel(label) && !labels.has(id)) labels.set(id, label)
      const detail = str(step.detail)
      if (detail && !details.has(id)) details.set(id, detail)
    }
  }
  if (Array.isArray(plan)) {
    const legacy = Array.isArray(content.steps) && content.steps.length === plan.length ? content.steps : null
    plan.forEach((item, index) => {
      if (!isJson(item)) return
      const id = str(item.id)
      const positional = legacy ? str(legacy[index]) : undefined
      const label = (id ? labels.get(id) : undefined) ?? (positional && !isPlaceholderLabel(positional) ? positional : undefined)
      if (label && !str(item.label)) item.label = label
      const detail = id ? details.get(id) : undefined
      if (detail && !str(item.detail)) item.detail = detail
    })
  }
  if (Array.isArray(rounds)) {
    for (const round of rounds) {
      if (!isJson(round)) continue
      const phase = phases.find((candidate) => candidate.id === `r${String(round.n)}`)
      const title = str(phase?.title)
      const outcome = str(phase?.outcome)
      if (title && !str(round.title)) round.title = title
      if (outcome && !str(round.outcome)) round.outcome = outcome
    }
  }
}

