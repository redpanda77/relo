import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { ActivityHistoryPage } from "@/features/test-lab/activity-history-page"

const bootstrap = {
  version: 1 as const,
  kind: "activity-history" as const,
  route: {
    path: "/dashboard/testing/runs/act_test/history",
    backHref: "/dashboard/testing/runs/act_test",
  },
  shell: {
    title: "Release 42",
    description: "Read-only lifecycle act_test.",
    active: "testing" as const,
    releaseIdentity: "test-release",
    account: {
      id: "acc_owner",
      initial: "K",
      name: "Relo Owner",
      email: "owner@example.test",
    },
  },
  activity: {
    id: "act_test",
    key: "dashboard-test-browser",
    title: "Release 42",
    status: "Building",
    detail: "Compiling the notification pipeline",
    progress: 0.68,
    symbol: "shippingbox",
    style: "progress",
    privacy: "standard",
    accentColor: "#ff6b57",
    state: "active",
    generation: 2,
    sequence: 3,
    lifecycle: {
      provider: "codex",
      runId: "codex-run-0123456789abcdef",
    },
    requesterLabel: "Dashboard",
    expiresAt: null,
    staleAt: null,
    createdAt: "2026-08-08T01:00:00.000Z",
    updatedAt: "2026-08-08T01:01:00.000Z",
    endedAt: null,
  },
  targetDevices: [
    {
      id: "dev_test",
      name: "Test iPhone",
      lastSeenAt: "2026-08-08T01:00:00.000Z",
    },
  ],
  operations: [
    {
      operation: "update",
      resultingSequence: 3,
      durableCommands: 1,
      apnsJobs: 1,
      dismissAfterSeconds: null,
      companionActivityId: null,
      createdAt: "2026-08-08T01:01:00.000Z",
    },
  ],
  events: [
    {
      id: "ntf_test",
      kind: "live_activity",
      title: "Release 42",
      state: "active",
      createdAt: "2026-08-08T01:01:00.000Z",
    },
  ],
  relationships: [
    {
      id: "rel_test",
      kind: "continuation",
      direction: "predecessor" as const,
      relatedActivity: {
        id: "act_previous",
        title: "Release 41",
        state: "ended",
        generation: 1,
      },
      actor: "cli",
      reason: "same_origin_generation",
      provenance: "runtime",
      createdAt: "2026-08-08T01:00:00.000Z",
    },
  ],
  correlationDecisions: [
    {
      id: "cor_test",
      outcome: "resumed",
      matchedBy: "origin",
      actor: "cli",
      reason: "same_origin_generation",
      provenance: "runtime",
      relationshipId: "rel_test",
      createdAt: "2026-08-08T01:00:00.000Z",
    },
  ],
}

describe("ActivityHistoryPage", () => {
  afterEach(cleanup)

  test("shows generation, sequence, targets, operations, and durable events", () => {
    render(<ActivityHistoryPage bootstrap={bootstrap} />)
    expect(screen.getByText("Generation 2")).toBeInTheDocument()
    expect(screen.getAllByText("Sequence 3")).toHaveLength(2)
    expect(screen.getByText("codex lifecycle")).toBeInTheDocument()
    expect(screen.getByText("codex-run-0123456789abcdef")).toBeInTheDocument()
    expect(screen.getByText("Test iPhone")).toBeInTheDocument()
    expect(screen.getByText("Release 41")).toBeInTheDocument()
    expect(screen.getByText("resumed")).toBeInTheDocument()
    expect(
      screen.getByText("1 durable commands, 1 APNs jobs")
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Release 42/i })).toHaveAttribute(
      "href",
      "/dashboard/inbox/notifications/ntf_test"
    )
  })

  test("keeps the canonical selected-run return path", () => {
    render(<ActivityHistoryPage bootstrap={bootstrap} />)
    expect(screen.getByRole("link", { name: "Back to run" })).toHaveAttribute(
      "href",
      "/dashboard/testing/runs/act_test"
    )
  })
})
