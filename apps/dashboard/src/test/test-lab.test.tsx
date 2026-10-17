import { readFileSync } from "node:fs"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { Sheet } from "@/components/ui/sheet"
import { StatusDot } from "@/components/atoms/status-dot"
import { toneFor } from "@/lib/status-tone"
import { RunMonitor } from "@/components/organisms/run-monitor"
import { NotificationPreview } from "@/components/organisms/notification-preview"
import { Progress } from "@/components/ui/progress"
import { TestLabPage } from "@/features/test-lab/test-lab-page"
import {
  rememberLaunchReceipt,
  takeLaunchReceipt,
} from "@/features/test-lab/launch-receipt"
import {
  createHttpTestLabService,
  readBootstrap,
  type LiveRunStatus,
  type TestLabService,
} from "@/services/test-lab-service"
import {
  BUILDER_DRAFT_KEY,
  DEFAULT_BUILDER_DRAFT,
} from "@/state/use-builder-draft"
import type { TestLabBootstrap, TestRun } from "@/features/test-lab/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const longId = "act_01JZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
const presentation = {
  content: {
    header: "Relo",
    title: "Warm launch",
    subtitle: null,
    status: "Building",
  },
  identity: {
    project: null,
    thread: null,
    direct: true,
  },
  state: { kind: "active", tone: "live", icon: "build" },
  components: [{
    id: "measured_progress",
    type: "progress_bar" as const,
    colorRole: "project" as const,
    value: 0.42,
    label: "Building",
  }],
  surfaces: {
    lock_screen: ["measured_progress"],
    expanded_leading: [],
    expanded_trailing: ["measured_progress"],
    expanded_bottom: ["measured_progress"],
    compact_leading: [],
    compact_trailing: ["measured_progress"],
    minimal: ["measured_progress"],
  },
  behavior: { type: "progress" as const },
  appearance: {
    theme: "dark" as const,
    roles: {
      cardIdentity: "project" as const,
      componentIdentity: "thread" as const,
      statusEmphasis: "state" as const,
    },
  },
  privacy: "standard" as const,
}
const run: TestRun = {
  id: longId,
  title: "Warm launch",
  detail: null,
  style: "progress",
  status: "Building",
  state: "active",
  progress: 0.42,
  generation: 2,
  sequence: 2,
  presentation,
  targetDeviceIds: ["dev_public_1"],
  targetDeviceName: null,
  requesterLabel: "Dashboard",
  ownerControlled: true,
  ownerKind: "dashboard_test",
  evidence: {
    provider: { state: null, durableCommands: 1, apnsJobs: 0 },
    phone: { expected: 2, confirmed: 1 },
    activityKit: { state: null, summary: null },
    response: { kind: null, state: null, action: null, respondedAt: null },
  },
  createdAt: null,
  updatedAt: null,
}
const bootstrap: TestLabBootstrap = {
  version: 1,
  kind: "test-lab",
  route: {
    path: "/dashboard/testing",
    selectedActivityId: null,
    compose: false,
  },
  shell: {
    title: "Live Activity Test Lab",
    description: "Evidence",
    active: "testing",
    releaseIdentity: "test",
    account: {
      id: "acct_public",
      initial: "K",
      name: "Relo Owner",
      email: "owner@example.com",
    },
  },
  summary: {
    total: 1,
    active: 1,
    awaitingProvider: 1,
    awaitingPhone: 1,
    awaitingResponse: 0,
  },
  devices: [
    {
      id: "dev_public_1",
      name: "Developer's iPhone",
      model: null,
      appVersion: null,
      osVersion: null,
      notificationAuthorization: "authorized",
      liveActivityAuthorization: "authorized",
      lastSeenAt: null,
      ready: true,
    },
  ],
  runs: [run],
  composer: {
    defaultPreset: "standard",
    presets: [{ id: "standard", label: "Standard", presentation }],
  },
}

function service(overrides: Partial<TestLabService> = {}): TestLabService {
  return {
    launchRun: vi.fn().mockResolvedValue({
      activityId: "act_returned_public_id",
      generation: 2,
      sequence: 3,
      operation: "update",
      reused: true,
      resumed: false,
    }),
    getSnapshot: vi.fn().mockResolvedValue(bootstrap),
    getRunStatus: vi.fn().mockResolvedValue({
      id: run.id,
      title: run.title,
      status: run.status,
      state: "active",
      progress: run.progress,
      generation: run.generation,
      sequence: run.sequence,
      ownerKind: run.ownerKind,
      presentation: run.presentation as unknown as Record<string, unknown>,
      targets: [],
      delivery: null,
      interaction: null,
      currentCommandReceipts: [],
      activityKit: run.evidence.activityKit,
    } satisfies LiveRunStatus),
    updateRun: vi.fn().mockResolvedValue(undefined),
    waitRun: vi.fn().mockResolvedValue(undefined),
    finishRun: vi.fn().mockResolvedValue(undefined),
    finishAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, "", "/dashboard/testing")
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Test Lab contracts", () => {
  it("paints a live state in running cyan, never success mint", () => {
    const { container } = render(<StatusDot tone={toneFor("active")} live />)
    const dot = container.querySelector("span")
    expect(dot?.textContent).toBe("")
    expect(dot?.className).toContain("tone-cyan")
    expect(dot?.className).not.toContain("tone-mint")
    expect(dot?.getAttribute("data-live")).toBe("true")
  })

  it("Zod-validates nullable bootstrap fields and treats hostile strings as data", () => {
    document.body.innerHTML =
      '<script id="relo-dashboard-bootstrap" type="application/json"></script>'
    const hostile = structuredClone(bootstrap)
    hostile.shell.description = '</script><img src=x onerror="alert(1)">'
    delete (
      hostile as unknown as {
        runs: Array<{ evidence: { activityKit?: unknown } }>
      }
    ).runs[0].evidence.activityKit
    document.getElementById("relo-dashboard-bootstrap")!.textContent =
      JSON.stringify(hostile)
    expect(readBootstrap().shell.description).toContain("<img")
    expect(readBootstrap().runs[0].detail).toBeNull()
    expect(readBootstrap().runs[0].evidence.activityKit).toEqual({
      state: null,
      summary: null,
    })
  })

  it("keeps the draft after launch, uses the returned public ID, and resets explicitly", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    const openRun = vi.fn()
    const testService = service()
    render(
      <TestLabPage
        initial={bootstrap}
        service={testService}
        openRun={openRun}
      />
    )
    const title = await screen.findByLabelText("Title")
    fireEvent.change(screen.getByLabelText("iPhone"), {
      target: { value: "dev_public_1" },
    })
    fireEvent.change(title, { target: { value: "Persist this draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Send test" }))
    await waitFor(() =>
      expect(openRun).toHaveBeenCalledWith("act_returned_public_id")
    )
    expect(testService.launchRun).toHaveBeenCalledWith(
      expect.objectContaining({ allowParallel: false })
    )
    expect(JSON.parse(localStorage.getItem(BUILDER_DRAFT_KEY)!).title).toBe(
      "Persist this draft"
    )
    expect(
      JSON.parse(localStorage.getItem(BUILDER_DRAFT_KEY)!).allowParallel
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Start over" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Title")).toHaveValue(
        DEFAULT_BUILDER_DRAFT.title
      )
    )
  })

  it("hydrates a launched run before opening its client-owned route", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    const refreshed = structuredClone(bootstrap)
    refreshed.runs = [
      {
        ...refreshed.runs[0],
        id: "act_returned_public_id",
        generation: 2,
        sequence: 3,
      },
      ...refreshed.runs,
    ]
    const testService = service({
      getSnapshot: vi.fn().mockResolvedValue(refreshed),
    })

    render(<TestLabPage initial={bootstrap} service={testService} />)
    fireEvent.change(await screen.findByLabelText("iPhone"), {
      target: { value: "dev_public_1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send test" }))

    await waitFor(() =>
      expect(document.querySelector("#activity-session")).toHaveAttribute(
        "data-activity-id",
        "act_returned_public_id"
      )
    )
    expect(window.location.pathname).toBe(
      "/dashboard/testing/runs/act_returned_public_id"
    )
    expect(testService.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it("decodes generation metadata without sending client lifecycle policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          activity: {
            id: "act_generation_3",
            generation: 3,
            sequence: 1,
            operation: "start",
          },
          reused: false,
          resumed: true,
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    const receipt = await createHttpTestLabService(bootstrap).launchRun({
      ...DEFAULT_BUILDER_DRAFT,
      deviceId: "dev_public_1",
      allowParallel: false,
    })

    expect(receipt).toEqual({
      activityId: "act_generation_3",
      generation: 3,
      sequence: 1,
      operation: "start",
      reused: false,
      resumed: true,
    })
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      deviceId: "dev_public_1",
    })
    const requestBody = JSON.parse(String(request.body))
    expect(requestBody.presentation).toMatchObject({
      state: { kind: "active", tone: "live", icon: "terminal" },
      identity: { project: null, thread: null, direct: true },
      appearance: {
        roles: {
          cardIdentity: "project",
          componentIdentity: "thread",
          statusEmphasis: "state",
        },
      },
    })
    expect(requestBody).not.toHaveProperty("allowParallel")
    expect(requestBody).not.toHaveProperty("generation")
    expect(requestBody).not.toHaveProperty("reused")
    expect(requestBody).not.toHaveProperty("resumed")
  })

  it("sends and previews named steps as the only visualization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          activity: {
            id: "act_steps",
            generation: 1,
            sequence: 1,
            operation: "start",
          },
          reused: false,
          resumed: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    const draft = {
      ...DEFAULT_BUILDER_DRAFT,
      deviceId: "dev_public_1",
      visual: "steps",
      status: "Level 7",
      progress: 38,
      progressLabel: "188 of 4876",
      stepLabels: "Prepare, Generate, Verify",
      stepCurrent: 2,
    }
    await createHttpTestLabService(bootstrap).launchRun(draft)
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const presentation = JSON.parse(String(request.body)).presentation
    expect(presentation.content.status).toBe("Level 7")
    expect(presentation.components).toEqual([
      expect.objectContaining({
        id: "named_steps",
        type: "steps",
        colorRole: "thread",
        items: [
          { id: "step_1", label: "Prepare", state: "complete" },
          { id: "step_2", label: "Generate", state: "current" },
          { id: "step_3", label: "Verify", state: "pending" },
        ],
      }),
    ])
    expect(presentation.surfaces.lock_screen).toEqual(["named_steps"])

    const { container } = render(<NotificationPreview draft={draft} />)
    expect(container.querySelector("[data-preview-steps]")).toHaveTextContent(
      "Generate"
    )
    expect(
      container.querySelector("[data-preview-steps]")
    ).not.toHaveTextContent("38%")
    expect(container.querySelectorAll("[data-preview-steps] svg")).toHaveLength(
      3
    )
    expect(container.querySelector("[style]")).not.toBeInTheDocument()
  })

  it("picks one notification kind and shows only the fields it needs", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    render(<TestLabPage initial={bootstrap} service={service()} />)
    expect(
      await screen.findByRole("radio", { name: /^Progress/ })
    ).toBeChecked()
    expect(
      document.querySelector("[data-builder-progress-fields]")
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("radio", { name: /^Approval/ }))
    expect(
      document.querySelector("[data-builder-progress-fields]")
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Right button"), {
      target: { value: "Authorize" },
    })
    fireEvent.change(screen.getByLabelText("Left button"), {
      target: { value: "Reject" },
    })
    const draft = JSON.parse(localStorage.getItem(BUILDER_DRAFT_KEY)!)
    expect(draft).toMatchObject({ behavior: "approval", visual: "none" })
    const actions = document.querySelector("[data-preview-actions]")
    expect(actions).toHaveTextContent("Reject")
    expect(actions).toHaveTextContent("Authorize")

    fireEvent.click(screen.getByRole("radio", { name: /^Steps/ }))
    expect(screen.getByLabelText("Step 1")).toHaveValue("Queued")
    fireEvent.click(screen.getByRole("button", { name: "Add step" }))
    expect(screen.getByLabelText("Step 4")).toHaveValue("")
    fireEvent.click(screen.getByLabelText("Make step 3 current"))
    expect(JSON.parse(localStorage.getItem(BUILDER_DRAFT_KEY)!)).toMatchObject({
      behavior: "progress",
      visual: "steps",
      stepCurrent: 3,
    })
  })

  it("sends valid empty JSON for per-run and finish-all terminal mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const service = createHttpTestLabService(bootstrap)

    await service.finishRun("act_terminal")
    await service.finishAll()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/dashboard/live-activities/act_terminal/end",
      expect.objectContaining({ method: "POST", body: "{}" })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/dashboard/live-activities/end-all",
      expect.objectContaining({ method: "POST", body: "{}" })
    )
  })

  it("keeps the builder field contracts on generated native selects", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    const initial = structuredClone(bootstrap)
    initial.devices.push({
      ...initial.devices[0],
      id: "dev_public_unavailable",
      name: "Unavailable iPhone",
      ready: false,
    })

    render(<TestLabPage initial={initial} service={service()} />)

    const ids = ["activity-device", "builder-symbol", "builder-theme"]
    for (const id of ids) {
      const select = await waitFor(() => document.getElementById(id))
      expect(select).toBeInstanceOf(HTMLSelectElement)
      expect(select).toHaveAttribute("data-slot", "native-select")
      expect(select).toHaveAttribute("name", id)
    }

    const deviceSelect = screen.getByLabelText("iPhone")
    expect(deviceSelect).toBeRequired()
    expect(
      deviceSelect.querySelector('option[value="dev_public_unavailable"]')
    ).toBeDisabled()
  })

  it("derives the details Sheet from the route and closes back to the monitor", async () => {
    window.history.replaceState(
      {},
      "",
      `/dashboard/testing/runs/${encodeURIComponent(longId)}#activity-session`
    )
    render(<TestLabPage initial={bootstrap} service={service()} />)
    expect(await screen.findByRole("dialog")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(window.location.pathname).toBe("/dashboard/testing")
    )
  })

  it("shows the delivery chain in plain language and keeps internals in technical details", async () => {
    window.history.replaceState(
      {},
      "",
      `/dashboard/testing/runs/${encodeURIComponent(longId)}#activity-session`
    )
    sessionStorage.setItem(
      "relo:test-lab-recent-launch:v1",
      JSON.stringify({
        activityId: longId,
        generation: 2,
        sequence: 2,
        operation: "update",
        reused: true,
        resumed: false,
      })
    )
    render(<TestLabPage initial={bootstrap} service={service()} />)
    const chain = await waitFor(() => {
      const node = document.querySelector("[data-delivery-chain]")
      if (!node) throw new Error("chain missing")
      return node
    })
    expect(
      [...chain.querySelectorAll("[data-stage]")].map((stage) => [
        stage.getAttribute("data-stage"),
        stage.getAttribute("data-state"),
      ])
    ).toEqual([
      ["server", "done"],
      ["apple", "waiting"],
      ["iphone", "skipped"],
      ["live-activity", "skipped"],
      ["response", "skipped"],
    ])
    expect(chain).toHaveTextContent("Receipt not tracked")
    expect(chain).toHaveTextContent("Waiting for the iPhone to show it")
    expect(screen.getAllByText("Waiting on Apple").length).toBeGreaterThan(0)
    expect(
      screen.getByText("Sent as an update to the test already on this iPhone.")
    ).toBeVisible()
    expect(screen.getByText("Technical details")).toBeVisible()
    expect(screen.getByText("2 (Live Activity 2)")).toBeInTheDocument()
  })

  it("asks before ending a live test", async () => {
    window.history.replaceState(
      {},
      "",
      `/dashboard/testing/runs/${encodeURIComponent(longId)}#activity-session`
    )
    const testService = service()
    render(<TestLabPage initial={bootstrap} service={testService} />)
    fireEvent.click(await screen.findByRole("button", { name: "End test" }))
    expect(
      await screen.findByRole("alertdialog", { name: "End this test?" })
    ).toBeVisible()
    expect(testService.finishRun).not.toHaveBeenCalled()
    const confirm = screen
      .getAllByRole("button", { name: "End test" })
      .find((button) => button.closest('[role="alertdialog"]'))!
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(testService.finishRun).toHaveBeenCalledWith(longId)
    )
    expect(testService.getSnapshot).toHaveBeenCalled()
  })

  it("routes a first-time owner to Connections when no iPhone is ready", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    const initial = structuredClone(bootstrap)
    initial.devices = []
    initial.runs = []
    render(<TestLabPage initial={initial} service={service()} />)
    expect(
      await screen.findByText("Connect an iPhone to start testing")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Connect an iPhone" })
    ).toHaveAttribute("href", "/dashboard/connections")
    expect(screen.getByRole("button", { name: "Send test" })).toBeDisabled()
    expect(document.getElementById("builder-operation")).toHaveTextContent(
      "Connect an iPhone in Connections to send tests."
    )
  })

  it("consumes only an exact, well-formed launch receipt", () => {
    rememberLaunchReceipt({
      activityId: longId,
      generation: 2,
      sequence: 3,
      operation: "update",
      reused: true,
      resumed: false,
    })
    expect(takeLaunchReceipt(longId, 2, 2)).toBeNull()
    expect(takeLaunchReceipt(longId, 2, 3)).toBeNull()

    sessionStorage.setItem("relo:test-lab-recent-launch:v1", "not-json")
    expect(takeLaunchReceipt(longId, 2, 3)).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  it("lists runs as one glass list with a delivery trail and plain status", () => {
    const { container, rerender } = render(
      <Sheet>
        <RunMonitor runs={[run]} onSelect={() => undefined} />
      </Sheet>
    )
    // The shared Row: its button opens the test's sheet; the dot says whether it is live.
    const row = container.querySelector("button.row-hit")
    expect(row).toHaveAttribute("aria-haspopup", "dialog")
    expect(container.querySelector(".run-mark")).toHaveAttribute("data-live", "true")
    expect(row).toHaveTextContent("Warm launch")
    expect(row).toHaveTextContent("Waiting on Apple")
    expect(row?.className).not.toContain("animate-")
    expect(
      container.querySelector("[data-delivery-trail]")?.getAttribute("aria-label")
    ).toBe(
      "Delivery: Relo done, Apple waiting, iPhone waiting, Live Activity not needed, Response not needed"
    )

    rerender(
      <Sheet>
        <RunMonitor
          runs={[{ ...run, state: "ended" }]}
          onSelect={() => undefined}
        />
      </Sheet>
    )
    expect(container.querySelector(".run-mark")).toHaveAttribute(
      "data-live",
      "false"
    )

    const css = readFileSync("src/index.css", "utf8")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toMatch(/\.animate-status-pulse\s*\{\s*display:\s*none;/)
  })

  it("renders notification color and progress without CSP-blocked inline styles", () => {
    const { container } = render(
      <NotificationPreview
        draft={{
          ...DEFAULT_BUILDER_DRAFT,
          accentColor: "#285d49",
          progress: 42,
        }}
      />
    )
    expect(container.querySelector("[style]")).not.toBeInTheDocument()
    expect(
      container.querySelector('stop[stop-color="#285d49"]')
    ).toBeInTheDocument()
    expect(container.querySelector('rect[width="42"]')).toBeInTheDocument()
  })

  it("keeps the ShadCN progress contract without an inline transform", () => {
    const { container } = render(<Progress value={42} aria-label="Progress" />)
    expect(container.querySelector('[data-slot="progress"]')).toHaveAttribute(
      "aria-valuenow",
      "42"
    )
    expect(
      container.querySelector('[data-slot="progress-indicator"] rect')
    ).toHaveAttribute("width", "42")
    expect(container.querySelector("[style]")).not.toBeInTheDocument()
  })
})
