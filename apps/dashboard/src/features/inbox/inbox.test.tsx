import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ navigateDashboard: vi.fn() }))
vi.mock("@/state/use-dashboard-route", async (original) => ({
  ...(await original<typeof import("@/state/use-dashboard-route")>()),
  navigateDashboard: navigation.navigateDashboard,
}))

import { InboxFeature } from "@/features/inbox/inbox-feature"
import {
  inboxDashboardBootstrapSchema,
  type DeliveryHistory,
  type InboxOverview,
  type NotificationDetail,
  type NotificationHistory,
} from "@/features/inbox/types"
import type { InboxService, InboxSnapshot } from "@/services/inbox-service"
import { useDashboardSnapshot } from "@/state/use-dashboard-snapshot"
import { defaultInboxActionReconciliation } from "@/state/use-inbox-action"

const now = "2026-08-07T08:00:00.000Z"
const eventId = "ntf_22222222-2222-4222-8222-222222222222"
const emptyContext = {
  providerName: null,
  producerKind: null,
  computer: null,
  account: null,
  project: null,
  providerThreadId: null,
  providerWorkItemId: null,
  threadName: null,
  taskTitle: null,
  threadNameSource: null,
  taskTitleSource: null,
}
const shell = {
  title: "Inbox",
  description: "Durable owner decisions and outcomes.",
  active: "inbox" as const,
  releaseIdentity: "test-release",
  account: {
    id: "acc_public",
    initial: "K",
    name: "Relo Owner",
    email: "owner@example.test",
  },
  counts: { pending: 2, notifications: 32, deliveries: 2 },
}
const notification = {
  id: eventId,
  title: "Release gate",
  body: "Review the production build",
  source: "Test Lab",
  requesterKind: "cli" as const,
  kind: "question",
  state: "active",
  createdAt: now,
  destination: {
    state: "safe" as const,
    href: "https://example.test/releases/42",
  },
  targetDeviceNames: ["Developer's iPhone"],
  response: null,
  context: emptyContext,
  originThreadId: null,
  activity: null,
}

const liveActivity = {
  id: "act_66666666-6666-4666-8666-666666666666",
  operation: "update",
  eventSequence: 4,
  generation: 2,
  sequence: 6,
  state: "ended",
  title: "Codex · Relo notifications",
  status: "Complete",
  detail: "Dashboard lifecycle fixed",
  progress: null,
  originThreadId: "org_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  conversationId: "cnv_77777777-7777-4777-8777-777777777777",
  workItemId: "wrk_88888888-8888-4888-8888-888888888888",
  lifecycle: { provider: "codex", runId: "codex-run-dashboard-lifecycle" },
  context: {
    providerName: "Codex",
    producerKind: "agent",
    computer: "developer-mac-codex",
    account: "work",
    project: "Relo notifications",
    providerThreadId: "019fe2d8-9b96-7f03-8b2c-83101432f6a4",
    providerWorkItemId: "turn-dashboard-lifecycle",
    threadName: "Dashboard lifecycle audit",
    taskTitle: "Correct activity lifecycle history",
    threadNameSource: "provider",
    taskTitleSource: "prompt_summary",
  },
  createdAt: now,
  updatedAt: now,
  staleAt: now,
  expiresAt: now,
  endedAt: now,
  terminalReason: "explicit_end",
  terminalActor: "provider:codex",
  terminalPolicy: "producer_terminal",
  terminalTransitionAt: now,
  presentationPresetId: "system.agent.informational",
  presentationPresetRevision: 1,
  presentationPolicySource: "system",
}

const overview: InboxOverview = {
  version: 1,
  kind: "inbox-overview",
  route: { path: "/dashboard", page: 1 },
  shell,
  summary: {
    pendingResponses: 1,
    pendingApprovals: 1,
    notifications: 32,
    deliveries: 2,
  },
  pendingResponses: [
    {
      notificationId: eventId,
      title: "Release gate",
      source: "Test Lab",
      kind: "question",
      state: "pending",
      prompt: "Ship it?",
      targetDeviceNames: ["Developer's iPhone"],
      createdAt: now,
      expiresAt: now,
    },
  ],
  approvalRequests: [
    {
      userCode: "ABCD-EFGH",
      clientName: "Relo CLI",
      requestedScopes: ["notifications:write"],
      approvalExpiresAt: now,
      credentialExpiresAt: now,
    },
  ],
  approvalPagination: {
    page: 1,
    pageSize: 25,
    total: 1,
    pageCount: 1,
    previousHref: null,
    nextHref: null,
  },
  recentNotifications: [notification],
}

function service(): InboxService {
  return {
    decideApproval: vi.fn().mockResolvedValue(undefined),
    reactivateActivity: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue({
      revision: 1,
      counts: { notifications: 32, deliveries: 2, approvals: 1, devices: 1 },
      devices: [],
      clients: [],
    }),
  }
}

function deferred<Result>() {
  let resolve!: (value: Result) => void
  const promise = new Promise<Result>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function SnapshotProbe({
  inboxService,
  intervalMs = 10,
}: {
  inboxService: InboxService
  intervalMs?: number
}) {
  const { snapshot } = useDashboardSnapshot(inboxService, intervalMs)
  return (
    <output aria-label="Snapshot revision">
      {snapshot?.revision ?? "none"}
    </output>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("Inbox feature contracts", () => {
  it("validates the discriminated bootstrap and treats hostile strings as data", () => {
    const hostile = structuredClone(overview) as InboxOverview & {
      credentialHash?: string
    }
    hostile.shell.description = '</script><img src=x onerror="alert(1)">'
    hostile.credentialHash = "must-not-cross-the-boundary"
    const parsed = inboxDashboardBootstrapSchema.parse(hostile)
    expect(parsed.shell.description).toContain("<img")
    expect(parsed).not.toHaveProperty("credentialHash")
  })

  it("preserves approval action hooks and performs an explicit owner decision", async () => {
    const inboxService = service()
    const onSuccess = vi.fn()
    render(
      <InboxFeature
        bootstrap={overview}
        service={inboxService}
        onApprovalSuccess={onSuccess}
      />
    )

    const authorize = screen.getByRole("button", { name: "Approve" })
    expect(authorize).toHaveAttribute("data-action", "approve-approval")
    expect(authorize).toHaveAttribute("data-code", "ABCD-EFGH")
    expect(authorize.className).toContain("min-h-11")
    // The owner sees what the client asks for and for how long before approving.
    const request = authorize.closest("li")!
    expect(request).toHaveTextContent("ABCD-EFGH")
    expect(request).toHaveTextContent("notifications:write")
    expect(request).toHaveTextContent("access until")
    fireEvent.click(authorize)

    await waitFor(() =>
      expect(inboxService.decideApproval).toHaveBeenCalledWith(
        "ABCD-EFGH",
        "approve"
      )
    )
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(within(screen.getByRole("list", { name: "Needs you" })).getByRole("button", { name: "Open Release gate" })).toBeVisible()
  })

  it("coalesces a same-code double decision into one mutation", async () => {
    const pending = deferred<void>()
    const inboxService = service()
    inboxService.decideApproval = vi.fn(() => pending.promise)
    render(
      <InboxFeature
        bootstrap={overview}
        service={inboxService}
        onApprovalSuccess={vi.fn()}
      />
    )

    const authorize = screen.getByRole("button", { name: "Approve" })
    fireEvent.click(authorize)
    fireEvent.click(authorize)
    expect(inboxService.decideApproval).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled()

    pending.resolve()
    await waitFor(() => expect(authorize).toBeEnabled())
  })

  it("tracks concurrent approval codes independently", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const concurrent = structuredClone(overview)
    concurrent.approvalRequests.push({
      ...concurrent.approvalRequests[0],
      userCode: "IJKL-MNOP",
      clientName: "Release CLI",
    })
    const inboxService = service()
    inboxService.decideApproval = vi.fn((code) =>
      code === "ABCD-EFGH" ? first.promise : second.promise
    )
    render(
      <InboxFeature
        bootstrap={concurrent}
        service={inboxService}
        onApprovalSuccess={vi.fn()}
      />
    )

    const firstCard = screen
      .getByText("Connect Relo CLI")
      .closest<HTMLElement>("li")
    const secondCard = screen
      .getByText("Connect Release CLI")
      .closest<HTMLElement>("li")
    expect(firstCard).not.toBeNull()
    expect(secondCard).not.toBeNull()
    fireEvent.click(
      within(firstCard!).getByRole("button", { name: "Approve" })
    )
    expect(
      within(firstCard!).getByRole("button", { name: "Deny" })
    ).toBeDisabled()
    expect(
      within(secondCard!).getByRole("button", { name: "Deny" })
    ).toBeEnabled()

    fireEvent.click(within(secondCard!).getByRole("button", { name: "Deny" }))
    first.resolve()
    await waitFor(() =>
      expect(
        within(firstCard!).getByRole("button", { name: "Deny" })
      ).toBeEnabled()
    )
    expect(
      within(secondCard!).getByRole("button", { name: "Deny" })
    ).toBeDisabled()
    expect(inboxService.decideApproval).toHaveBeenCalledTimes(2)

    second.resolve()
    await waitFor(() =>
      expect(
        within(secondCard!).getByRole("button", { name: "Deny" })
      ).toBeEnabled()
    )
  })

  it("waits for every production-default decision before reconciling", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const concurrent = structuredClone(overview)
    concurrent.approvalRequests.push({
      ...concurrent.approvalRequests[0],
      userCode: "IJKL-MNOP",
      clientName: "Release CLI",
    })
    const inboxService = service()
    inboxService.decideApproval = vi.fn((code) =>
      code === "ABCD-EFGH" ? first.promise : second.promise
    )
    const reload = vi
      .spyOn(defaultInboxActionReconciliation, "reload")
      .mockImplementation(() => undefined)
    render(<InboxFeature bootstrap={concurrent} service={inboxService} />)

    const firstCard = screen
      .getByText("Connect Relo CLI")
      .closest<HTMLElement>("li")!
    const secondCard = screen
      .getByText("Connect Release CLI")
      .closest<HTMLElement>("li")!
    fireEvent.click(
      within(firstCard).getByRole("button", { name: "Approve" })
    )
    fireEvent.click(within(secondCard).getByRole("button", { name: "Deny" }))

    first.resolve()
    await waitFor(() =>
      expect(
        within(firstCard).getByRole("button", { name: "Approve" })
      ).toBeEnabled()
    )
    expect(reload).not.toHaveBeenCalled()

    second.resolve()
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it("ignores stale snapshot revisions and aborts the active request on unmount", async () => {
    vi.useFakeTimers()
    const fresh = {
      revision: 10,
      counts: { notifications: 10, deliveries: 2, approvals: 1, devices: 1 },
      devices: [],
      clients: [],
    }
    const stale = { ...fresh, revision: 5 }
    const inboxService = service()
    inboxService.getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(fresh)
      .mockResolvedValueOnce(stale)
    const view = render(<SnapshotProbe inboxService={inboxService} />)

    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByLabelText("Snapshot revision")).toHaveTextContent("10")
    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByLabelText("Snapshot revision")).toHaveTextContent("10")

    let activeSignal: AbortSignal | undefined
    inboxService.getSnapshot = vi.fn((signal) => {
      activeSignal = signal
      return new Promise<InboxSnapshot>(() => undefined)
    })
    view.rerender(<SnapshotProbe inboxService={inboxService} intervalMs={11} />)
    await act(async () => vi.advanceTimersByTimeAsync(11))
    expect(activeSignal?.aborted).toBe(false)
    view.unmount()
    expect(activeSignal?.aborted).toBe(true)
  })

  it("does not advertise an attached link when none was validated", () => {
    const history = {
      version: 1,
      kind: "notification-history",
      route: {
        path: "/dashboard/inbox/notifications",
        page: 1,
        filters: { kind: null, state: null, project: null },
      },
      filterOptions: { projects: [] },
      shell: {
        ...shell,
        active: "inbox-notifications",
        title: "Notifications",
      },
      notifications: [
        {
          ...notification,
          destination: { state: "not-set", href: null },
        },
      ],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 1,
        pageCount: 1,
        previousHref: null,
        nextHref: null,
      },
    } as NotificationHistory

    render(<InboxFeature bootstrap={history} />)

    expect(screen.queryByLabelText("Link attached")).not.toBeInTheDocument()
  })

  it("requires confirmation and settles a reconciliation-required delivery", async () => {
    const deliveryId = "job_55555555-5555-4555-8555-555555555555"
    const history: DeliveryHistory = {
      version: 1,
      kind: "delivery-history",
      route: { path: "/dashboard/inbox/deliveries", page: 1 },
      shell: {
        ...shell,
        active: "inbox-delivery",
        title: "Delivery attempts",
      },
      deliveries: [
        {
          id: deliveryId,
          notificationId: eventId,
          title: "Build progress",
          source: "Codex",
          deviceName: "Developer's iPhone",
          transport: "live_activity",
          state: "reconciliation_required",
          attemptCount: 1,
          providerMessageId: null,
          error: {
            code: "known_transport_outcome_persistence_failed",
            message: "The APNs result could not be committed.",
          },
          reconciliation: {
            required: true,
            allowedActions: ["retry", "cancel"],
            resolvedAction: null,
          },
          acceptedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 1,
        pageCount: 1,
        previousHref: null,
        nextHref: null,
      },
    }
    const inboxService = service()
    inboxService.reconcileDelivery = vi
      .fn()
      .mockResolvedValue({ state: "retry", replayed: false })
    vi.spyOn(window, "confirm").mockReturnValue(true)

    render(<InboxFeature bootstrap={history} service={inboxService} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry safe update" }))

    await waitFor(() =>
      expect(inboxService.reconcileDelivery).toHaveBeenCalledWith(
        deliveryId,
        "retry"
      )
    )
    expect(window.confirm).toHaveBeenCalledWith(
      "Confirm: retry this sequence-safe Live Activity command?"
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry safe update" })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByLabelText("Status: retry")).toBeVisible()
  })

  it("keeps provider acceptance separate and can show a dismissed activity again", async () => {
    const detail = {
      version: 1,
      kind: "notification-detail",
      route: {
        path: `/dashboard/inbox/notifications/${eventId}`,
        backHref: "/dashboard/inbox/notifications",
      },
      shell: {
        ...shell,
        active: "inbox-notifications",
        title: "Delivery evidence",
      },
      notification: {
        ...notification,
        source: "Codex",
        kind: "live_activity",
        state: "active",
        serviceTitle: null,
        privacy: "standard",
        targetMode: "explicit",
        updatedAt: now,
        expiresAt: now,
        destination: { state: "not-set", href: null },
      },
      activity: {
        ...liveActivity,
        state: "active",
        steps: { done: 1, total: 3, current: "Build" },
        updates: 7,
        stepItems: [
          { label: "Plan", state: "complete" },
          { label: "Build", state: "current" },
          { label: "Ship", state: "pending" },
        ],
        threadHistory: [],
        timeline: [],
        presentationLeases: [
          {
            deviceId: "dev_88888888-8888-4888-8888-888888888888",
            deviceName: "Developer's iPhone",
            state: "not_presented",
            reason: "device_dismissed",
            relevanceScore: 0.9,
            lastCommandSequence: 3,
            selectedAt: now,
            lastAppliedAt: null,
            endedAt: null,
          },
        ],
        relationships: [],
        correlationDecisions: [],
      },
      interaction: null,
      deliveries: [
        {
          id: "job_delivery-evidence",
          notificationId: eventId,
          title: notification.title,
          source: "Codex",
          deviceName: "Developer's iPhone",
          transport: "live_activity",
          state: "accepted",
          attemptCount: 1,
          providerMessageId: "provider-evidence-id",
          error: null,
          reconciliation: {
            required: false,
            allowedActions: [],
            resolvedAction: null,
          },
          acceptedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidenceTimeline: [
        {
          id: "evd_provider_accepted_44444444-4444-4444-8444-444444444444",
          notificationId: eventId,
          deliveryId: "job_77777777-7777-4777-8777-777777777777",
          attemptId: "att_44444444-4444-4444-8444-444444444444",
          deviceId: "dev_88888888-8888-4888-8888-888888888888",
          activityId: liveActivity.id,
          stage: "provider_accepted",
          stageOrder: 50,
          state: "accepted",
          detailCode: "accepted",
          serialization: {
            canonicalIntent: "sha256:aaaaaaaaaaaa",
            deviceProjection: "sha256:bbbbbbbbbbbb",
            providerBytes: "sha256:cccccccccccc",
          },
          occurredAt: now,
        },
      ],
      receipts: [],
    } as NotificationDetail

    const inboxService = service()
    render(<InboxFeature bootstrap={detail} service={inboxService} />)

    // Apple acceptance is its own step; with no receipt the phone is never claimed.
    // A Live Activity shows no delivery timeline up front; the evidence lives under Technical details.
    expect(screen.getByRole("heading", { name: "Mission" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Delivery" })).toBeNull()
    expect(screen.getByText("Copy ID")).toBeInTheDocument()
    expect(screen.queryByText(liveActivity.id)).toBeNull()
    fireEvent.click(screen.getByText("Technical details"))
    expect(screen.getByText("Accepted by Apple")).toBeVisible()
    expect(screen.queryByText(/^Received on/)).toBeNull()
    expect(screen.queryByRole("link", { name: /open link/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Show on iPhone again" }))
    await waitFor(() =>
      expect(inboxService.reactivateActivity).toHaveBeenCalledWith(
        liveActivity.id
      )
    )

  })

  it("says what is true now, shows the question once, and confirms before withdrawing", async () => {
    const future = new Date(Date.now() + 15 * 60_000).toISOString()
    const prompt = "The checks passed. Deploy now?"
    const detail = {
      version: 1,
      kind: "notification-detail",
      route: {
        path: `/dashboard/inbox/notifications/${eventId}`,
        backHref: "/dashboard/inbox/notifications",
      },
      shell: { ...shell, active: "inbox-notifications", title: "Notification" },
      notification: {
        ...notification,
        title: "Deploy 0.7.50 to production?",
        body: prompt,
        source: "Codex",
        kind: "question",
        state: "active",
        serviceTitle: null,
        privacy: "standard",
        targetMode: "explicit",
        updatedAt: now,
        expiresAt: future,
        readAt: now,
        destination: { state: "not-set", href: null },
      },
      activity: null,
      interaction: {
        kind: "approval",
        state: "pending",
        action: null,
        prompt,
        responseText: null,
        respondingDevice: null,
        createdAt: now,
        expiresAt: future,
        respondedAt: null,
      },
      deliveries: [],
      evidenceTimeline: [],
      receipts: [],
    } as unknown as NotificationDetail
    const inboxService = {
      ...service(),
      withdrawNotification: vi.fn().mockResolvedValue(undefined),
    }
    render(<InboxFeature bootstrap={detail} service={inboxService} />)

    expect(screen.getByText("Waiting for your answer")).toBeVisible()
    expect(screen.getAllByText(prompt)).toHaveLength(1)
    expect(
      screen.getByText(/Answer from the notification on your iPhone/)
    ).toBeVisible()
    expect(screen.getByText("Sent")).toBeVisible()
    expect(screen.queryByText("Accepted by Apple")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }))
    expect(
      await screen.findByRole("alertdialog", { name: "Withdraw this notification?" })
    ).toBeVisible()
    expect(inboxService.withdrawNotification).not.toHaveBeenCalled()
    const confirm = screen
      .getAllByRole("button", { name: "Withdraw" })
      .find((button) => button.closest('[role="alertdialog"]'))!
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(inboxService.withdrawNotification).toHaveBeenCalledWith(eventId)
    )
    expect(await screen.findByText("Withdrawn")).toBeVisible()
  })

  it("shows Source › Project › Topic on each row and the source alone without context", () => {
    const withContext = {
      ...notification,
      id: "ntf_33333333-3333-4333-8333-333333333333",
      title: "Deploy finished",
      source: "Codex",
      context: { ...emptyContext, project: "Relo", threadName: "Releases" },
    }
    render(
      <InboxFeature
        bootstrap={{ ...overview, pendingResponses: [], approvalRequests: [], recentNotifications: [withContext, notification] }}
        service={service()}
      />
    )
    const activity = within(screen.getByRole("list", { name: "Activity" }))
    expect(activity.getByLabelText("Codex › Relo › Releases")).toBeVisible()
    expect(activity.getByText("Releases")).toBeVisible()
    expect(activity.getByLabelText("Test Lab")).toBeVisible()
    expect(activity.getByText("Test Lab")).toBeVisible()
    expect(screen.queryByRole("list", { name: "Needs you" })).toBeNull()
  })

  it("shows a lock instead of sealed placeholders and never shows a handle", () => {
    const sealedContext = { ...emptyContext, project: "p-abcdefghijklmnop", threadName: "t-abcdefghijklmnop" }
    const sealedNotice = {
      ...notification,
      id: "ntf_66666666-6666-4666-8666-666666666666",
      kind: "notification",
      state: "recorded",
      encrypted: true,
      title: "Encrypted notification",
      body: "Open Relo on your iPhone to read this.",
      source: "Claude Code",
      context: sealedContext,
    }
    render(
      <InboxFeature
        bootstrap={{
          ...overview,
          approvalRequests: [],
          pendingResponses: [{ ...overview.pendingResponses[0]!, encrypted: true, title: "Encrypted question",
            prompt: "Open Relo on your iPhone to read this question." }],
          recentNotifications: [sealedNotice],
        }}
        service={service()}
      />
    )
    const activity = within(screen.getByRole("list", { name: "Activity" }))
    expect(activity.getByText("End-to-end encrypted · open on iPhone to read")).toBeVisible()
    expect(activity.getByLabelText("Claude Code › Encrypted project › Encrypted topic")).toBeVisible()
    expect(activity.getByRole("button", { name: "Open encrypted item" })).toBeVisible()
    const needsYou = within(screen.getByRole("list", { name: "Needs you" }))
    expect(needsYou.getByText("End-to-end encrypted · open on iPhone to read")).toBeVisible()
    const page = document.body.textContent ?? ""
    for (const hidden of ["Encrypted notification", "Encrypted question", "Open Relo on your iPhone", "p-abcdefghijklmnop", "t-abcdefghijklmnop"])
      expect(page).not.toContain(hidden)
  })

  it("opens a sealed question as a lock pointing to the iPhone, keeping its state", () => {
    const sealedPrompt = "Open Relo on your iPhone to read this question."
    const detail = {
      version: 1,
      kind: "notification-detail",
      route: { path: `/dashboard/inbox/notifications/${eventId}`, backHref: "/dashboard/inbox/notifications" },
      shell: { ...shell, active: "inbox-notifications", title: "Notification" },
      notification: {
        ...notification,
        encrypted: true,
        title: "Encrypted question",
        body: sealedPrompt,
        kind: "question",
        serviceTitle: null,
        privacy: "private",
        targetMode: "explicit",
        updatedAt: now,
        expiresAt: now,
        readAt: now,
        destination: { state: "not-set", href: null },
      },
      activity: null,
      interaction: {
        kind: "approval", encrypted: true, state: "expired", action: null, prompt: sealedPrompt,
        responseText: null, respondingDevice: null, createdAt: now, expiresAt: now, respondedAt: null,
      },
      deliveries: [],
      evidenceTimeline: [],
      receipts: [],
    } as unknown as NotificationDetail
    render(<InboxFeature bootstrap={detail} service={service()} />)
    expect(screen.getByText("End-to-end encrypted · open on iPhone to read")).toBeVisible()
    expect(screen.getByText("Expired without an answer")).toBeVisible()
    expect(document.body.textContent).not.toContain("Encrypted question")
    expect(document.body.textContent).not.toContain(sealedPrompt)
  })

  it("filters the recent list by project without a round trip", () => {
    const other = {
      ...notification,
      id: "ntf_44444444-4444-4444-8444-444444444444",
      title: "Sync complete",
      context: { ...emptyContext, project: "Recovery" },
    }
    const relo = { ...notification, context: { ...emptyContext, project: "Relo" } }
    render(<InboxFeature bootstrap={{ ...overview, recentNotifications: [relo, other] }} service={service()} />)
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "project:Recovery" } })
    const activity = within(screen.getByRole("list", { name: "Activity" }))
    expect(activity.getByText("Sync complete")).toBeVisible()
    expect(activity.queryByText("Release gate")).toBeNull()
  })

  it("filters history on the server across every page", () => {
    const history = {
      version: 1,
      kind: "notification-history",
      route: { path: "/dashboard/inbox/notifications", page: 2, filters: { kind: "question", state: null, project: null } },
      filterOptions: { projects: ["Relo", "Kuatzi"] },
      shell: { ...shell, active: "inbox-notifications" },
      notifications: [notification, { ...notification, id: "ntf_55555555-5555-4555-8555-555555555555" }],
      pagination: { page: 2, pageSize: 25, total: 27, pageCount: 2, previousHref: "/dashboard/inbox/notifications?page=1", nextHref: null },
    } as NotificationHistory
    render(<InboxFeature bootstrap={history} service={service()} />)
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "Kuatzi" } })
    expect(navigation.navigateDashboard).toHaveBeenCalledWith("/dashboard/inbox/notifications?project=Kuatzi&kind=question")
  })

})
