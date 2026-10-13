import { z } from "zod"

import {
  testLabBootstrapSchema,
  type BuilderDraft,
  type TestLabBootstrap,
} from "@/features/test-lab/types"
import {
  launchRunReceiptSchema,
  type LaunchRunReceipt,
} from "@/features/test-lab/launch-receipt"

export type LiveRunStatus = {
  id: string
  title: string
  status: string
  state: string
  progress: number | null
  generation: number
  sequence: number
  ownerKind:
    | "provider_run"
    | "service_run"
    | "manual_key"
    | "credential_session"
    | "dashboard_test"
  presentation: Record<string, unknown> | null
  targets: Array<{ name: string }>
  delivery: {
    state: string | null
    summary: { durableCommands?: number; apnsJobs?: number }
  } | null
  interaction: {
    kind: string | null
    state: string | null
    action: string | null
    respondedAt: string | null
  } | null
  currentCommandReceipts: Array<{ receivedAt: string | null }>
  activityKit?: { state: string | null; summary: string | null }
}

export interface TestLabService {
  launchRun(draft: BuilderDraft): Promise<LaunchRunReceipt>
  getSnapshot(): Promise<TestLabBootstrap>
  getRunStatus(runId: string, signal?: AbortSignal): Promise<LiveRunStatus>
  updateRun(runId: string, presentation: Record<string, unknown>): Promise<void>
  waitRun(
    runId: string,
    kind: "approval" | "yes_no",
    prompt: string
  ): Promise<void>
  finishRun(runId: string): Promise<void>
  finishAll(): Promise<void>
}

const launchRunResponseSchema = z.object({
  activity: z.object({
    id: z.string().min(1),
    generation: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    operation: z.enum(["start", "update"]),
  }),
  reused: z.boolean(),
  resumed: z.boolean(),
})

export function readBootstrap(
  documentRoot: Document = document
): TestLabBootstrap {
  const node = documentRoot.getElementById("relo-dashboard-bootstrap")
  if (!node?.textContent)
    throw new Error("Test Lab bootstrap data is unavailable.")
  return testLabBootstrapSchema.parse(JSON.parse(node.textContent))
}

function presentationFromDraft(draft: BuilderDraft) {
  const progress = Math.min(1, Math.max(0, draft.progress / 100))
  const steps = draft.stepLabels
    .split(",")
    .map((label, index) => ({
      id: `step_${index + 1}`,
      label: label.trim(),
      state:
        index + 1 < draft.stepCurrent
          ? "complete"
          : index + 1 === draft.stepCurrent
            ? "current"
            : "pending",
    }))
    .filter((item) => item.label)
    .slice(0, 8)
  const requestedProgressType = "progress_bar"
  const needsProgress =
    draft.visual !== "steps" &&
    (draft.visual === "progress_bar" ||
      draft.visual === "progress_ring" ||
      draft.behavior === "progress")
  const components = [
    ...(draft.visual === "steps"
      ? [
          {
            id: "named_steps",
            type: "steps",
            colorRole: "thread",
            items: steps,
          },
        ]
      : []),
    ...(needsProgress
      ? [
          {
            id: "measured_progress",
            type: requestedProgressType,
            colorRole: "project",
            value: progress,
            label: draft.progressLabel.trim() || null,
          },
        ]
      : []),
  ]
  const componentIDs = components.map((component) => component.id)
  const progressID = components.find((component) =>
    component.type.startsWith("progress_")
  )?.id
  const stepsID = components.find((component) => component.type === "steps")?.id
  const behavior =
    draft.behavior === "approval"
      ? {
          type: "approval",
          primary: { action: "approve", label: draft.primaryLabel },
          secondary: { action: "deny", label: draft.secondaryLabel },
        }
      : draft.behavior === "yes_no"
        ? {
            type: "yes_no",
            primary: { action: "yes", label: draft.primaryLabel },
            secondary: { action: "no", label: draft.secondaryLabel },
          }
        : { type: draft.behavior }
  const state =
    draft.behavior === "approval" || draft.behavior === "yes_no"
      ? { kind: "needs_action", tone: "attention", icon: "needs_action" }
      : { kind: "active", tone: "live", icon: draft.symbol }
  return {
    content: {
      header: draft.header.trim() || null,
      title: draft.title,
      subtitle: draft.subtitle.trim() || null,
      status: draft.status,
    },
    identity: { project: null, thread: null, direct: true },
    state,
    components,
    surfaces: {
      lock_screen: componentIDs,
      expanded_leading: [],
      expanded_trailing: progressID ? [progressID] : [],
      expanded_bottom: stepsID ? [stepsID] : componentIDs,
      compact_leading: stepsID ? [stepsID] : [],
      compact_trailing: progressID ? [progressID] : componentIDs.slice(0, 1),
      minimal: progressID ? [progressID] : componentIDs.slice(0, 1),
    },
    behavior,
    appearance: {
      theme: draft.theme,
      roles: {
        cardIdentity: "project",
        componentIdentity: "thread",
        statusEmphasis: "state",
      },
      ...(draft.visual === "progress_ring" && needsProgress
        ? { progressDisplay: "ring" }
        : {}),
    },
    privacy: "standard",
  }
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  const payload = (await response.json().catch(() => null)) as
    T | { error?: string } | null
  if (!response.ok) {
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : null
    throw new Error(error || `Request failed (${response.status}).`)
  }
  return payload as T
}

export function createHttpTestLabService(
  initial: TestLabBootstrap
): TestLabService {
  void initial
  return {
    async launchRun(draft) {
      const payload = await jsonRequest<unknown>(
        "/api/dashboard/live-activities/test",
        {
          method: "POST",
          body: JSON.stringify({
            deviceId: draft.deviceId,
            presentation: presentationFromDraft(draft),
          }),
        }
      )
      const result = launchRunResponseSchema.parse(payload)
      return launchRunReceiptSchema.parse({
        activityId: result.activity.id,
        generation: result.activity.generation,
        sequence: result.activity.sequence,
        operation: result.activity.operation,
        reused: result.reused,
        resumed: result.resumed,
      })
    },
    async getSnapshot() {
      const response = await fetch("/dashboard/testing", {
        credentials: "same-origin",
        headers: { accept: "text/html" },
      })
      if (!response.ok) {
        throw new Error(`Test Lab refresh failed (${response.status}).`)
      }
      const documentRoot = new DOMParser().parseFromString(
        await response.text(),
        "text/html"
      )
      return readBootstrap(documentRoot)
    },
    async getRunStatus(runId, signal) {
      const result = await jsonRequest<{ activity: LiveRunStatus }>(
        `/api/dashboard/live-activities/${encodeURIComponent(runId)}/status`,
        { signal }
      )
      return result.activity
    },
    async updateRun(runId, presentation) {
      await jsonRequest(
        `/api/dashboard/live-activities/${encodeURIComponent(runId)}/update`,
        {
          method: "POST",
          body: JSON.stringify({ presentation }),
        }
      )
    },
    async waitRun(runId, kind, prompt) {
      await jsonRequest(
        `/api/dashboard/live-activities/${encodeURIComponent(runId)}/wait`,
        {
          method: "POST",
          body: JSON.stringify({ kind, prompt }),
        }
      )
    },
    async finishRun(runId) {
      await jsonRequest(
        `/api/dashboard/live-activities/${encodeURIComponent(runId)}/end`,
        { method: "POST", body: JSON.stringify({}) }
      )
    },
    async finishAll() {
      await jsonRequest("/api/dashboard/live-activities/end-all", {
        method: "POST",
        body: JSON.stringify({}),
      })
    },
  }
}
