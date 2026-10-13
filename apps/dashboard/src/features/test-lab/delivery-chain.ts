import { semanticStatusTone } from "@/lib/status-tone"
import type { TestRun } from "@/features/test-lab/types"

import type {
  DeliveryStage,
  StageState,
} from "@/components/molecules/delivery-chain"

export type { DeliveryStage, StageState }

function fromTone(value: string | null, live: boolean): StageState {
  if (!value) return live ? "waiting" : "skipped"
  const tone = semanticStatusTone(value)
  if (tone === "success") return "done"
  if (tone === "danger") return "failed"
  if (value.toLowerCase() === "active") return "done"
  return live ? "waiting" : "skipped"
}

/**
 * The five hops a test takes, in plain language: Relo accepts it, Apple pushes
 * it, the iPhone confirms it, the Live Activity reports in, and someone answers.
 */
export function deliveryStages(run: TestRun): DeliveryStage[] {
  const live = run.state === "active"
  const { provider, phone, activityKit, response } = run.evidence

  const apple = fromTone(provider.state, live)
  // An answer can only come from a phone that had the request, so it proves receipt even
  // when the phone never reported one (Live Activity pushes do not wake the app).
  const answered = Boolean(response.action)
  const iphone: StageState =
    phone.expected === 0 && !answered
      ? "skipped"
      : answered || phone.confirmed >= phone.expected
        ? "done"
        : live
          ? "waiting"
          : "failed"
  const activity = activityKit.state
    ? fromTone(activityKit.state, live)
    : "skipped"
  const answer: StageState = !response.kind
    ? "skipped"
    : response.action || semanticStatusTone(response.state ?? "") === "success"
      ? "done"
      : semanticStatusTone(response.state ?? "") === "danger"
        ? "failed"
        : live
          ? "waiting"
          : "skipped"

  const stages: DeliveryStage[] = [
    { id: "server", label: "Relo", state: "done", summary: "Accepted the test" },
    {
      id: "apple",
      label: "Apple",
      state: apple,
      summary:
        apple === "done"
          ? "Push accepted"
          : apple === "failed"
            ? "Apple rejected the push"
            : apple === "waiting"
              ? "Sending the push"
              : "No push sent",
    },
    {
      id: "iphone",
      label: "iPhone",
      state: iphone,
      summary:
        iphone === "skipped"
          ? "Receipt not tracked"
          : iphone === "done"
            ? "Received"
            : `${phone.confirmed} of ${phone.expected} received`,
    },
    {
      id: "live-activity",
      label: "Live Activity",
      state: activity,
      summary:
        activityKit.summary ??
        (live ? "Waiting for the iPhone to show it" : "No sign it was shown"),
    },
    {
      id: "response",
      label: "Response",
      state: answer,
      summary: response.action
        ? `Answered “${response.action.replaceAll("_", " ")}”`
        : response.kind
          ? answer === "waiting"
            ? "Waiting for an answer"
            : "No answer"
          : "No answer needed",
    },
  ]

  // Once a hop fails, later hops never ran; show them as not reached.
  const stop = stages.findIndex((stage) => stage.state === "failed")
  return stop < 0
    ? stages
    : stages.map((stage, index) =>
        index > stop && stage.state !== "done"
          ? { ...stage, state: "skipped", summary: "Not reached" }
          : stage
      )
}

/** One plain sentence for where the test is now. */
export function deliveryHeadline(run: TestRun, stages = deliveryStages(run)) {
  const failed = stages.find((stage) => stage.state === "failed")
  if (failed) return { tone: "danger" as const, text: `Stopped at ${failed.label}` }
  const waiting = stages.find((stage) => stage.state === "waiting")
  if (waiting)
    return {
      tone: waiting.id === "response" ? ("warning" as const) : ("active" as const),
      text:
        waiting.id === "response"
          ? "Waiting for an answer"
          : `Waiting on ${waiting.label}`,
    }
  if (run.state === "active") return { tone: "active" as const, text: "Live on iPhone" }
  return { tone: "neutral" as const, text: "Ended" }
}
