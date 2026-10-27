// Snapshot fixtures: Now summaries the views render without a server (`?snapshot=<name>`). Each is parsed with the
// contract's own schema (`nowSummarySchema`), so a fixture that drifts from the server's shape fails loudly.
// `owner-state-v1` is the shared contract fixture mirrored in apps/ios.

import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import type { QuestionSpec } from "../answers"
import empty from "./empty.json"
import failed from "./failed.json"
import question from "./question.json"
import ownerState from "../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json"

export interface Snapshot {
  summary: NowSummary
  /** Question kinds by question id (the Now summary does not carry them). */
  questions: Record<string, QuestionSpec>
}

const QUESTIONS: Record<string, QuestionSpec> = {
  "int_00000000-0000-4000-8000-000000000011": { kind: "approval", prompt: "Approve the deploy of v0.18.116?" },
  "int_00000000-0000-4000-8000-000000000012": {
    kind: "choice",
    prompt: "Which table first?",
    options: [
      { id: "users", label: "users" },
      { id: "events", label: "events" },
      { id: "billing", label: "billing" },
    ],
  },
}

const SOURCES: Record<string, { now: unknown; questions: Record<string, QuestionSpec> }> = {
  "owner-state-v1": { now: ownerState.nowSummary, questions: {} },
  empty: { now: empty, questions: {} },
  failed: { now: failed, questions: {} },
  question: { now: question, questions: QUESTIONS },
}

/** `?snapshot=long`: the shared fixture with every title, status, project and step made long (the notch never cuts them off). */
function lengthen(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => lengthen(v, key))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lengthen(v, k)]))
  if (typeof value === "string" && ["title", "status", "project", "currentStep", "outcome"].includes(key)) return `${value} across the whole monorepo including the generated clients and every package`
  return value
}
SOURCES.long = { now: lengthen(ownerState.nowSummary), questions: {} }

export const SNAPSHOT_NAMES = Object.keys(SOURCES)

export function loadSnapshot(name: string): Snapshot | null {
  const source = SOURCES[name]
  if (!source) return null
  return { summary: nowSummarySchema.parse(source.now), questions: source.questions }
}
