import * as React from "react"

import { connectNowLive } from "@/features/inbox/use-now-live"
import { currentBrowserLink } from "@/lib/e2ee/browser-link"
import { createHttpAnswerService, type AnswerableQuestion, type AnswerService } from "@/services/answer-service"

const noSubscription = () => () => undefined

/** This browser's id once its keys exist (linked or not), else undefined. */
function useBrowserId(): string | undefined {
  const link = currentBrowserLink()
  const state = React.useSyncExternalStore(link?.subscribe ?? noSubscription, () => link?.getState() ?? null, () => null)
  return state && "browserId" in state ? state.browserId : undefined
}

/**
 * One question for AnswerControls (components/molecules/answer-controls.tsx) by the `int_…` id of any
 * of its copies (a Now item's `question.id`): the copy the asking computer waits on, with the ids the
 * browser signs, the sender's labels, the deadline and whether a sealed question was sealed to this
 * browser. Null while loading or when gone. The server's change hints read it again, so a question
 * answered on the phone or the notch, expired or withdrawn shows it (`isOpenQuestion`).
 */
export function useAnswerableQuestion(interactionId: string | null, service?: AnswerService): AnswerableQuestion | null {
  const http = React.useMemo(() => service ?? createHttpAnswerService(), [service])
  const browserId = useBrowserId()
  const [loaded, setLoaded] = React.useState<{ id: string; question: AnswerableQuestion | null } | null>(null)
  React.useEffect(() => {
    if (!interactionId) return
    let controller = new AbortController()
    const load = () => {
      controller.abort()
      controller = new AbortController()
      const signal = controller.signal
      http.loadQuestion(interactionId, signal, browserId).then(
        (question) => setLoaded({ id: interactionId, question }),
        () => {
          if (!signal.aborted) setLoaded({ id: interactionId, question: null })
        }
      )
    }
    load()
    const stopLive = connectNowLive(load)
    return () => {
      stopLive()
      controller.abort()
    }
  }, [http, interactionId, browserId])
  return loaded && loaded.id === interactionId ? loaded.question : null
}

/** Still asking: no buttons for a question answered elsewhere, expired or withdrawn. */
export function isOpenQuestion(question: AnswerableQuestion): boolean {
  return question.state === undefined || question.state === "pending"
}
