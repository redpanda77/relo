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
  it("uses the active semantic token without reusing success green", () => {
    const { container } = render(<StatusDot state="active" active />)
    expect(container.querySelector("span")?.textContent).toBe("")
    expect(container.innerHTML).toContain("bg-[var(--status-active)]")
    expect(container.innerHTML).not.toContain("bg-[var(--status-success)]")
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
    fireEvent.change(screen.getByLabelText("Target iPhone"), {
      target: { value: "dev_public_1" },
    })
    fireEvent.change(title, { target: { value: "Persist this draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Launch run" }))
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
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
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
    fireEvent.change(await screen.findByLabelText("Target iPhone"), {
      target: { value: "dev_public_1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Launch run" }))

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

  it("applies the Approval preset and previews both response actions", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/testing?compose=1#activity-builder-panel"
    )
    const approvalPresentation = {
      ...presentation,
      content: {
        header: "Relo",
        title: "Approval needed",
        subtitle: "Review the guarded change",
        status: "Waiting",
      },
      visual: { type: "none" as const },
      behavior: {
        type: "approval" as const,
        primary: { action: "approve", label: "Authorize" },
        secondary: { action: "deny", label: "Reject" },
      },
      components: [],
      surfaces: {
        lock_screen: [],
        expanded_leading: [],
        expanded_trailing: [],
        expanded_bottom: [],
        compact_leading: [],
        compact_trailing: [],
        minimal: [],
      },
    }
    const initial = structuredClone(bootstrap)
    initial.composer.presets.push({
      id: "approval",
      label: "Approval",
      presentation: approvalPresentation,
    })

    render(<TestLabPage initial={initial} service={service()} />)
    fireEvent.change(await screen.findByLabelText("Preset shortcut"), {
      target: { value: "approval" },
    })

    expect(screen.getByLabelText("Behavior")).toHaveValue("approval")
    expect(screen.getByLabelText("Layout recipe")).toHaveValue("none")
    expect(screen.getByLabelText("Title")).toHaveValue("Approval needed")
    const actions = document.querySelector("[data-preview-actions]")
    expect(actions).toHaveTextContent("Reject")
    expect(actions).toHaveTextContent("Authorize")
    expect(actions?.className).toContain("grid-cols-2")
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

    const ids = [
      "activity-device",
      "builder-preset",
      "builder-behavior",
      "builder-visual",
      "builder-symbol",
      "builder-theme",
    ]
    for (const id of ids) {
      const select = await waitFor(() => document.getElementById(id))
      expect(select).toBeInstanceOf(HTMLSelectElement)
      expect(select).toHaveAttribute("data-slot", "native-select")
      expect(select).toHaveAttribute("name", id)
    }

    const deviceSelect = screen.getByLabelText("Target iPhone")
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

  it("shows generation and keeps ActivityKit evidence separate", async () => {
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
    expect((await screen.findAllByText("Generation 2")).length).toBeGreaterThan(
      0
    )
    expect(screen.getAllByText("Sequence 2").length).toBeGreaterThan(0)
    expect(screen.getByText("Reused active generation")).toBeVisible()
    for (const label of [
      "Server",
      "Provider",
      "Phone",
      "ActivityKit",
      "Response",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getByText("No native state reported")).toBeVisible()
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

  it("keeps long public IDs readable and limits active motion to the semantic dot", () => {
    const { container, rerender } = render(
      <Sheet>
        <RunMonitor runs={[run]} onSelect={() => undefined} />
      </Sheet>
    )
    expect(container.querySelector(`[title="${longId}"]`)).toBeVisible()
    expect(
      container.querySelector('.status-card[data-live="true"]')
    ).toBeInTheDocument()
    expect(container.querySelector(".run-row")?.className).not.toContain(
      "animate-"
    )

    rerender(
      <Sheet>
        <RunMonitor
          runs={[{ ...run, state: "ended" }]}
          onSelect={() => undefined}
        />
      </Sheet>
    )
    expect(
      container.querySelector('.status-card[data-live="true"]')
    ).not.toBeInTheDocument()

    const css = readFileSync("src/index.css", "utf8")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toMatch(/\.animate-status-pulse\s*\{\s*display:\s*none;/)
    expect(css).toContain(
      '.status-card[data-live="true"] .status-icon-tile::after'
    )
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
