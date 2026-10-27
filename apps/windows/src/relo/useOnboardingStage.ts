// The staged onboarding as the notch holds it: the latest `onboarding_stage` event, as a presentation (relo/onboarding.ts).

import { listen } from "@tauri-apps/api/event"
import { useEffect, useMemo, useRef, useState } from "react"
import { inTauri } from "../bridge"
import { ONBOARDING_STAGE_EVENT, onboardingPresentation, parseStage, type OnboardingStage } from "./onboarding"
import type { Presentation } from "./presentation"

/** Dev: `?stage=working|yourTurn|failed|done` stages the onboarding without the Settings window (screenshots, a browser). */
function devStage(): OnboardingStage | null {
  if (typeof location === "undefined") return null
  const params = new URLSearchParams(location.search)
  const phase = params.get("stage")
  if (!phase) return null
  return parseStage({ phase, stepsDone: Number(params.get("done") ?? 1), stepsTotal: Number(params.get("total") ?? 5), title: params.get("title") ?? undefined, status: params.get("status") })
}

export function useOnboardingStage(): { stage: OnboardingStage | null; presentation: Presentation | null } {
  const [stage, setStage] = useState<OnboardingStage | null>(devStage)
  const startedAt = useRef(stage?.startedAt || Date.now())
  const had = useRef(stage !== null)
  useEffect(() => {
    if (!inTauri) return
    const off = listen<unknown>(ONBOARDING_STAGE_EVENT, (e) => setStage(parseStage(e.payload)))
    return () => void off.then((fn) => fn())
  }, [])
  if (stage && !had.current) startedAt.current = stage.startedAt || Date.now()
  had.current = stage !== null
  const presentation = useMemo(() => (stage ? onboardingPresentation(stage, startedAt.current) : null), [stage])
  return { stage, presentation }
}
