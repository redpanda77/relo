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

import { InboxFeature } from "@/features/inbox/inbox-feature"
import { DeliveryRow } from "@/features/inbox/components"
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
    const { container } = render(
      <InboxFeature
        bootstrap={overview}
        service={inboxService}
        onApprovalSuccess={onSuccess}
      />
    )

    const authorize = screen.getByRole("button", { name: "Authorize" })
    expect(authorize).toHaveAttribute("data-action", "approve-approval")
    expect(authorize).toHaveAttribute("data-code", "ABCD-EFGH")
    expect(authorize.className).toContain("min-h-11")
    expect(screen.getByText("Approval expires")).toBeVisible()
    const credentialExpiry = screen.getByText("Credential expires")
    expect(credentialExpiry).toBeVisible()
    expect(
      credentialExpiry.compareDocumentPosition(authorize) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(authorize)

    await waitFor(() =>
      expect(inboxService.decideApproval).toHaveBeenCalledWith(
        "ABCD-EFGH",
        "approve"
      )
    )
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(
      container.querySelector('a[href="/dashboard/inbox/notifications"]')
    ).toBeInTheDocument()
    const pendingResponse = container.querySelector(
      '[data-slot="pending-response-link"] [data-slot="card"]'
    )
    expect(pendingResponse).toHaveAttribute("data-tone", "warning")
    expect(pendingResponse).not.toHaveAttribute("data-live")
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

    const authorize = screen.getByRole("button", { name: "Authorize" })
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
      .getByText("Relo CLI")
      .closest<HTMLElement>('[data-slot="card"]')
    const secondCard = screen
      .getByText("Release CLI")
      .closest<HTMLElement>('[data-slot="card"]')
    expect(firstCard).not.toBeNull()
    expect(secondCard).not.toBeNull()
    fireEvent.click(
      within(firstCard!).getByRole("button", { name: "Authorize" })
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
      .getByText("Relo CLI")
      .closest<HTMLElement>('[data-slot="card"]')!
    const secondCard = screen
      .getByText("Release CLI")
      .closest<HTMLElement>('[data-slot="card"]')!
    fireEvent.click(
      within(firstCard).getByRole("button", { name: "Authorize" })
    )
    fireEvent.click(within(secondCard).getByRole("button", { name: "Deny" }))

    first.resolve()
    await waitFor(() =>
      expect(
        within(firstCard).getByRole("button", { name: "Authorize" })
      ).toBeEnabled()
    )
    expect(reload).not.toHaveBeenCalled()

    second.resolve()
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it("keeps server-rendered approval totals aligned with stale action cards", async () => {
    vi.useFakeTimers()
    const inboxService = service()
    inboxService.getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        revision: 2,
        counts: {
          notifications: 40,
          deliveries: 3,
          approvals: 0,
          devices: 1,
        },
        devices: [],
        clients: [],
      })
      .mockRejectedValueOnce(new Error("offline"))
    render(
      <InboxFeature
        bootstrap={overview}
        service={inboxService}
        onApprovalSuccess={vi.fn()}
      />
    )

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    const summary = within(
      screen.getByRole("region", { name: "Inbox summary" })
    )
    expect(summary.getByText("CLI approvals").parentElement).toHaveTextContent(
      "1"
    )
    expect(summary.getByText("Notifications").parentElement).toHaveTextContent(
      "40"
    )
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(
      screen.getByText(
        "Live totals paused. Showing the last-known refreshed totals."
      )
    ).toBeVisible()
  })

  it("identifies initial server-rendered totals when the first poll fails", async () => {
    vi.useFakeTimers()
    const inboxService = service()
    inboxService.getSnapshot = vi.fn().mockRejectedValue(new Error("offline"))
    render(
      <InboxFeature
        bootstrap={overview}
        service={inboxService}
        onApprovalSuccess={vi.fn()}
      />
    )

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(
      screen.getByText(
        "Live totals paused. Showing the initial server-rendered totals."
      )
    ).toBeVisible()
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

  it("keeps route-backed GET filters, names, selections, and deep links", async () => {
    const history: NotificationHistory = {
      version: 1,
      kind: "notification-history",
      route: {
        path: "/dashboard/inbox/notifications",
        page: 2,
        filters: { kind: "question", state: "active", project: "Kuatzi" },
      },
      filterOptions: { projects: ["Relo notifications", "Kuatzi"] },
      shell: {
        ...shell,
        active: "inbox-notifications",
        title: "Notifications",
      },
      unread: {
        total: 3,
        byProject: [
          { project: "Relo notifications", count: 1 },
          { project: "Kuatzi", count: 2 },
        ],
      },
      notifications: [notification],
      pagination: {
        page: 2,
        pageSize: 25,
        total: 32,
        pageCount: 2,
        previousHref:
          "/dashboard/inbox/notifications?kind=question&state=active&page=1",
        nextHref: null,
      },
    }
    const inboxService = service()
    inboxService.markAllNotificationsRead = vi.fn().mockResolvedValue(undefined)
    render(<InboxFeature bootstrap={history} service={inboxService} />)

    const form = screen
      .getByRole("button", { name: "Apply filters" })
      .closest("form")
    expect(form).toHaveAttribute("method", "get")
    expect(form).toHaveAttribute("action", "/dashboard/inbox/notifications")
    expect(screen.getByLabelText("Kind")).toHaveAttribute("name", "kind")
    expect(screen.getByLabelText("Kind")).toHaveValue("question")
    expect(screen.getByLabelText("State")).toHaveAttribute("name", "state")
    expect(screen.getByLabelText("State")).toHaveValue("active")
    expect(screen.getByLabelText("State")).toHaveTextContent("Running")
    expect(screen.getByLabelText("Project")).toHaveAttribute("name", "project")
    expect(screen.getByLabelText("Project")).toHaveValue("Kuatzi")
    expect(form).not.toHaveClass("rounded-2xl", "bg-card/75")
    expect(screen.getByRole("link", { name: /release gate/i })).toHaveAttribute(
      "href",
      `/dashboard/inbox/notifications/${eventId}`
    )
    const notificationCard = document.querySelector(
      '[data-slot="notification-card"]'
    )
    expect(notificationCard).toHaveClass("status-card", "rounded-2xl")
    expect(notificationCard).toHaveAttribute("data-tone", "active")
    expect(notificationCard).toHaveAttribute("data-live", "true")
    expect(
      notificationCard?.querySelector(".status-icon-tile")
    ).toBeInTheDocument()
    expect(
      within(notificationCard as HTMLElement).getByLabelText("Status: active")
    ).toBeVisible()
    expect(
      screen.getByRole("region", { name: "Origin Test Lab" })
    ).toBeVisible()
    expect(
      within(notificationCard as HTMLElement).getByText("Developer's iPhone")
    ).toBeVisible()
    expect(
      within(notificationCard as HTMLElement).getByText(
        "Review the production build"
      )
    ).toBeVisible()
    expect(
      within(notificationCard as HTMLElement).getByLabelText("Link attached")
    ).toBeVisible()
    expect(screen.getByText(/3 unread/i)).toBeVisible()
    expect(screen.getByText(/Kuatzi 2/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    await waitFor(() =>
      expect(inboxService.markAllNotificationsRead).toHaveBeenCalledOnce()
    )
    expect(screen.getByText(/0 unread/i)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument()
  })

  it("renders canonical activity state and origin context instead of the event default", () => {
    const history = {
      version: 1,
      kind: "notification-history",
      route: {
        path: "/dashboard/inbox/notifications",
        page: 1,
        filters: { kind: "live_activity", state: "ended", project: null },
      },
      filterOptions: { projects: ["Relo notifications"] },
      shell: {
        ...shell,
        active: "inbox-notifications",
        title: "Notifications",
      },
      notifications: [
        {
          ...notification,
          title: "Codex · Relo notifications",
          body: "Earlier update",
          source: "Codex",
          kind: "live_activity",
          state: "ended",
          activity: liveActivity,
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

    const card = document.querySelector('[data-slot="notification-card"]')
    expect(card).toHaveAttribute("data-tone", "success")
    expect(card).not.toHaveAttribute("data-live")
    expect(
      within(card as HTMLElement).getByLabelText("Status: ended")
    ).toBeVisible()
    expect(
      within(card as HTMLElement).getByText(
        "Correct activity lifecycle history"
      )
    ).toBeVisible()
    expect(
      screen.getByRole("heading", {
        name: "Thread: Dashboard lifecycle audit",
      })
    ).toBeVisible()
    expect(within(card as HTMLElement).getByText("Complete")).toBeVisible()
    expect(within(card as HTMLElement).getByText(/generation 2/i)).toBeVisible()
    expect(
      within(card as HTMLElement).getByText(/update event · sequence 4 of 6/i)
    ).toBeVisible()
    const originGroup = document.querySelector(
      '[data-slot="notification-origin-group"]'
    )
    expect(originGroup).toBeInTheDocument()
    expect(
      within(originGroup as HTMLElement).getByRole("heading", {
        name: "Codex",
      })
    ).toBeVisible()
    expect(
      within(originGroup as HTMLElement).getByRole("heading", {
        name: "Project: Relo notifications",
      })
    ).toBeVisible()
    expect(
      within(originGroup as HTMLElement).getByRole("link", {
        name: /correct activity lifecycle history/i,
      })
    ).toBeVisible()
  })

  it("groups scattered records by origin, then project, then thread", () => {
    const contextual = (
      id: string,
      project: string,
      threadId: string,
      threadName: string,
      taskTitle: string
    ) => ({
      ...notification,
      id,
      title: taskTitle,
      source: "Developer Mac Codex",
      kind: "notification",
      state: "recorded",
      context: {
        ...emptyContext,
        providerName: "Codex",
        computer: "Mac",
        project,
        providerThreadId: threadId,
        threadName,
        taskTitle,
      },
    })
    const history: NotificationHistory = {
      version: 1,
      kind: "notification-history",
      route: {
        path: "/dashboard/inbox/notifications",
        page: 1,
        filters: { kind: null, state: null, project: null },
      },
      filterOptions: { projects: ["Relo notifications", "Kuatzi"] },
      shell: {
        ...shell,
        active: "inbox-notifications",
        title: "Notifications",
      },
      notifications: [
        contextual(
          "ntf_kuatzi-one",
          "Kuatzi",
          "thread-kuatzi",
          "Kuatzi",
          "First task"
        ),
        contextual(
          "ntf_relo",
          "Relo notifications",
          "thread-relo",
          "Relo",
          "Other task"
        ),
        contextual(
          "ntf_kuatzi-two",
          "Kuatzi",
          "thread-kuatzi",
          "Kuatzi",
          "Second task"
        ),
      ],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 3,
        pageCount: 1,
        previousHref: null,
        nextHref: null,
      },
    }

    render(<InboxFeature bootstrap={history} />)

    expect(
      document.querySelectorAll('[data-slot="notification-origin-group"]')
    ).toHaveLength(1)
    expect(
      document.querySelectorAll('[data-slot="notification-project-group"]')
    ).toHaveLength(2)
    const kuatzi = screen.getByRole("group", { name: "Project Kuatzi" })
    expect(within(kuatzi).getAllByText("2 records")).toHaveLength(2)
    expect(
      within(kuatzi).getByRole("heading", { name: "Thread: Kuatzi" })
    ).toBeVisible()
    expect(within(kuatzi).getAllByRole("link")).toHaveLength(2)
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

  it("labels and consolidates context-free CLI calls without synthetic threads", () => {
    const history: NotificationHistory = {
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
      notifications: ["one", "two", "three"].map((id) => ({
        ...notification,
        id: `ntf_direct-${id}`,
        title: `Direct call ${id}`,
        source: "developer-mac-codex",
        requesterKind: "cli",
      })),
      pagination: {
        page: 1,
        pageSize: 25,
        total: 3,
        pageCount: 1,
        previousHref: null,
        nextHref: null,
      },
    }

    render(<InboxFeature bootstrap={history} />)

    expect(screen.getByText("Origin: Direct CLI")).toBeVisible()
    expect(screen.getByRole("heading", { name: "Direct CLI" })).toBeVisible()
    expect(
      document.querySelectorAll('[data-slot="notification-thread-group"]')
    ).toHaveLength(0)
    const directGroup = screen.getByRole("group", {
      name: "Project Direct CLI",
    })
    expect(within(directGroup).getAllByRole("link")).toHaveLength(3)

    const summary = within(directGroup)
      .getByRole("heading", { name: "Direct CLI" })
      .closest("summary")
    expect(summary).not.toBeNull()
    fireEvent.click(summary as HTMLElement)
    expect(directGroup).not.toHaveAttribute("open")
  })

  it("filters recent Inbox records with the project chip", () => {
    const contextual = {
      ...notification,
      id: "ntf_project",
      title: "Project notification",
      context: { ...emptyContext, project: "Kuatzi" },
    }
    render(
      <InboxFeature
        bootstrap={{
          ...overview,
          recentNotifications: [notification, contextual],
        }}
      />
    )

    const project = screen.getByLabelText("Project", { selector: "select" })
    expect(
      within(project).getByRole("option", { name: "Direct CLI" })
    ).toBeVisible()
    expect(
      within(project).getByRole("option", { name: "Kuatzi" })
    ).toBeVisible()

    fireEvent.change(project, { target: { value: "project:Kuatzi" } })
    const recent = screen.getByRole("region", { name: "Recent notifications" })
    expect(within(recent).getByText("Project notification")).toBeVisible()
    expect(within(recent).queryByText("Release gate")).not.toBeInTheDocument()
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

  it("exposes only the server-validated destination as an external action", () => {
    const detail: NotificationDetail = {
      version: 1,
      kind: "notification-detail",
      route: {
        path: `/dashboard/inbox/notifications/${eventId}`,
        backHref: "/dashboard/inbox/notifications",
      },
      shell: { ...shell, active: "inbox-notifications", title: "Release gate" },
      notification: {
        ...notification,
        serviceTitle: null,
        privacy: "standard",
        targetMode: "devices",
        updatedAt: now,
        expiresAt: now,
        destination: {
          state: "safe",
          href: "https://example.test/releases/42",
        },
      },
      activity: null,
      interaction: {
        kind: "question",
        state: "responded",
        action: "reply",
        prompt: "Ship it?",
        responseText: "yes",
        respondingDevice: { id: "dev_public", name: "Developer's iPhone" },
        createdAt: now,
        expiresAt: now,
        respondedAt: now,
      },
      deliveries: [
        {
          id: "job_delivery-test",
          notificationId: eventId,
          title: "Release gate",
          source: "Test Lab",
          deviceName: "Developer's iPhone",
          transport: "apns",
          state: "accepted",
          attemptCount: 1,
          providerMessageId: "provider-safe-id",
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
      evidenceTimeline: [],
      receipts: [
        { kind: "answer", deviceName: "Developer's iPhone", createdAt: now },
      ],
    }
    render(<InboxFeature bootstrap={detail} />)

    const destination = screen.getByRole("link", { name: /open attached link/i })
    expect(destination).toHaveAttribute(
      "href",
      "https://example.test/releases/42"
    )
    expect(destination).toHaveAttribute("rel", "noopener noreferrer")
    expect(screen.getAllByText(/example\.test/).length).toBeGreaterThan(0)
    const detailDelivery = document.querySelector(
      '[data-slot="delivery-detail-row"]'
    )
    expect(detailDelivery).toBeInTheDocument()
    expect(detailDelivery?.querySelector("a")).toBeNull()
    expect(
      detailDelivery?.querySelector('[data-slot="delivery-card"]')
    ).toHaveAttribute("data-tone", "success")
    expect(
      detailDelivery?.querySelector(".status-icon-tile")
    ).toBeInTheDocument()
    const historyRow = render(<DeliveryRow delivery={detail.deliveries[0]} />)
    expect(within(historyRow.container).getByRole("link")).toHaveAttribute(
      "href",
      `/dashboard/inbox/notifications/${eventId}`
    )
    expect(
      screen.getByRole("link", { name: /back to history/i })
    ).toHaveAttribute("href", "/dashboard/inbox/notifications")
  })

  it("shows complete Live Activity identity, lifecycle, and timeline in detail", () => {
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
        title: "Correct activity lifecycle history",
      },
      notification: {
        ...notification,
        source: "Codex",
        kind: "live_activity",
        title: "Codex · Relo notifications",
        body: "",
        state: "ended",
        serviceTitle: null,
        privacy: "standard",
        targetMode: "explicit",
        updatedAt: now,
        expiresAt: now,
        destination: { state: "not-set", href: null },
      },
      activity: {
        ...liveActivity,
        threadHistory: [
          {
            id: liveActivity.id,
            generation: 2,
            state: "ended",
            title: liveActivity.title,
            status: "Complete",
            taskTitle: "Correct activity lifecycle history",
            createdAt: now,
            updatedAt: now,
            endedAt: now,
            terminalReason: "explicit_end",
            current: true,
          },
          {
            id: "act_77777777-7777-4777-8777-777777777777",
            generation: 1,
            state: "ended",
            title: liveActivity.title,
            status: "Complete",
            taskTitle: "Audit lifecycle history",
            createdAt: now,
            updatedAt: now,
            endedAt: now,
            terminalReason: "explicit_end",
            current: false,
          },
        ],
        timeline: [
          {
            operation: "start",
            sequence: 1,
            state: "active",
            status: "Planning",
            createdAt: now,
          },
          {
            operation: "end",
            sequence: 6,
            state: "ended",
            status: "Complete",
            createdAt: now,
          },
        ],
        presentationLeases: [
          {
            deviceId: "dev_88888888-8888-4888-8888-888888888888",
            deviceName: "Developer's iPhone",
            state: "ended",
            reason: "terminal_command_applied",
            relevanceScore: 0,
            lastCommandSequence: 6,
            selectedAt: now,
            lastAppliedAt: now,
            endedAt: now,
          },
        ],
        relationships: [
          {
            id: "rel_dashboard-lifecycle",
            kind: "continuation",
            direction: "predecessor",
            relatedActivity: {
              id: "act_77777777-7777-4777-8777-777777777777",
              title: "Audit lifecycle history",
              state: "ended",
              generation: 1,
            },
            actor: "dashboard",
            reason: "same_origin_generation",
            provenance: "runtime",
            createdAt: now,
          },
        ],
        correlationDecisions: [
          {
            id: "cor_dashboard-lifecycle",
            outcome: "resumed",
            matchedBy: "origin",
            actor: "dashboard",
            reason: "same_origin_generation",
            provenance: "runtime",
            relationshipId: "rel_dashboard-lifecycle",
            createdAt: now,
          },
        ],
      },
      interaction: null,
      deliveries: [],
      evidenceTimeline: [],
      receipts: [],
    } as NotificationDetail
    render(<InboxFeature bootstrap={detail} />)

    expect(
      screen.getAllByText("Correct activity lifecycle history").length
    ).toBeGreaterThan(1)
    expect(screen.getByText("Dashboard lifecycle fixed")).toBeVisible()
    expect(
      screen.getAllByText(/Dashboard lifecycle audit/).length
    ).toBeGreaterThan(0)
    expect(screen.getByText("Relo notifications")).toBeVisible()
    expect(screen.getByText(liveActivity.originThreadId)).toBeVisible()
    expect(screen.getByText("codex-run-dashboard-lifecycle")).toBeVisible()
    expect(
      screen.getByRole("heading", { name: "Lifecycle timeline" })
    ).toBeVisible()
    expect(
      screen.getByRole("heading", {
        name: "Task instructions and activity generations",
      })
    ).toBeVisible()
    expect(screen.getAllByText("Audit lifecycle history").length).toBeGreaterThan(1)
    expect(
      screen.getByRole("heading", { name: "Relationship and correlation evidence" })
    ).toBeVisible()
    expect(screen.getByText("continuation predecessor")).toBeVisible()
    expect(screen.getByText("resumed")).toBeVisible()
    expect(screen.getByText("Selected")).toBeVisible()
    expect(screen.getByText("Planning")).toBeVisible()
    expect(screen.getAllByText("Complete").length).toBeGreaterThan(0)
    expect(
      screen.getByText(
        /APNs acceptance only confirms that Apple accepted the push/
      )
    ).toBeVisible()
    expect(screen.queryByText("No message body.")).not.toBeInTheDocument()
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

    expect(
      screen.getByText(
        "APNs accepted for at least one target · iOS display unconfirmed"
      )
    ).toBeVisible()
    expect(screen.getByText("No app confirmation yet")).toBeVisible()
    expect(screen.getByRole("heading", { level: 2, name: "Delivery evidence" })).toBeVisible()
    expect(screen.getByText("provider accepted")).toBeVisible()
    expect(
      screen.getByText(/Provider acceptance and app confirmation are separate/)
    ).toBeVisible()
    fireEvent.click(
      screen.getByRole("button", { name: "Show Live Activity again" })
    )
    await waitFor(() =>
      expect(inboxService.reactivateActivity).toHaveBeenCalledWith(
        liveActivity.id
      )
    )
    expect(
      screen.getByText(
        "A fresh Live Activity presentation was queued for the dismissed phone."
      )
    ).toBeVisible()
  })
})
