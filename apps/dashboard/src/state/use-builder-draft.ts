import * as React from "react"

import type { BuilderDraft } from "@/features/test-lab/types"

export const BUILDER_DRAFT_KEY = "relo:test-lab-builder-draft:v1"

export const DEFAULT_BUILDER_DRAFT: BuilderDraft = {
  deviceId: "",
  preset: "standard",
  behavior: "progress",
  visual: "progress_bar",
  progress: 36,
  progressLabel: "In progress",
  stepLabels: "Queued, In progress, Complete",
  stepCurrent: 2,
  primaryLabel: "Approve",
  secondaryLabel: "Not now",
  title: "Your order is on the way",
  status: "Preparing notification",
  header: "Relo",
  subtitle: "Live delivery updates",
  symbol: "terminal",
  theme: "dark",
  accentColor: "#ff6b5e",
  allowParallel: false,
}

function loadDraft(): BuilderDraft {
  try {
    const stored = localStorage.getItem(BUILDER_DRAFT_KEY)
    if (!stored) return DEFAULT_BUILDER_DRAFT
    const saved = JSON.parse(stored) as Record<string, unknown>
    delete saved.isPrivate
    return {
      ...DEFAULT_BUILDER_DRAFT,
      ...saved,
      allowParallel: false,
    } as BuilderDraft
  } catch {
    return DEFAULT_BUILDER_DRAFT
  }
}

export function useBuilderDraft(initialPreset: string) {
  const [draft, setDraft] = React.useState<BuilderDraft>(() => ({
    ...loadDraft(),
    preset: localStorage.getItem(BUILDER_DRAFT_KEY)
      ? loadDraft().preset
      : initialPreset,
  }))

  React.useEffect(() => {
    localStorage.setItem(
      BUILDER_DRAFT_KEY,
      JSON.stringify({ ...draft, allowParallel: false })
    )
  }, [draft])

  const update = React.useCallback(
    <Key extends keyof BuilderDraft>(key: Key, value: BuilderDraft[Key]) => {
      setDraft((current) => ({ ...current, [key]: value }))
    },
    []
  )

  const reset = React.useCallback(() => {
    const next = { ...DEFAULT_BUILDER_DRAFT, preset: initialPreset }
    localStorage.removeItem(BUILDER_DRAFT_KEY)
    setDraft(next)
  }, [initialPreset])

  return { draft, update, reset }
}
