import {
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  CircleGauge,
  Gauge,
  ListChecks,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react"
import * as React from "react"

import { NotificationPreview } from "@/components/organisms/notification-preview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { CONNECTIONS_HREF } from "@/features/test-lab/devices"
import type { LaunchRunReceipt } from "@/features/test-lab/launch-receipt"
import type { BuilderDraft, TestDevice } from "@/features/test-lab/types"
import { cn } from "@/lib/utils"
import { navigateDashboard } from "@/state/use-dashboard-route"

type Props = {
  open: boolean
  devices: TestDevice[]
  draft: BuilderDraft
  pending: boolean
  update: <Key extends keyof BuilderDraft>(
    key: Key,
    value: BuilderDraft[Key]
  ) => void
  reset: () => void
  launch: (draft: BuilderDraft) => Promise<LaunchRunReceipt>
  openRun: (runId: string) => void
}

const MAX_STEPS = 8

/** One choice instead of two: each kind fixes both the behavior and the visual. */
const KINDS = [
  {
    id: "progress",
    label: "Progress",
    hint: "A task with a percentage",
    icon: Gauge,
    behavior: "progress",
    visual: "progress_bar",
  },
  {
    id: "ring",
    label: "Ring",
    hint: "A percentage drawn as a gauge",
    icon: CircleGauge,
    behavior: "progress",
    visual: "progress_ring",
  },
  {
    id: "steps",
    label: "Steps",
    hint: "A task moving through named stages",
    icon: ListChecks,
    behavior: "progress",
    visual: "steps",
  },
  {
    id: "approval",
    label: "Approval",
    hint: "Approve or decline from the Lock Screen",
    icon: ShieldCheck,
    behavior: "approval",
    visual: "none",
  },
  {
    id: "yes_no",
    label: "Yes or no",
    hint: "A quick question with two answers",
    icon: CircleHelp,
    behavior: "yes_no",
    visual: "none",
  },
  {
    id: "informational",
    label: "Update",
    hint: "Just text, no controls",
    icon: Bell,
    behavior: "informational",
    visual: "none",
  },
] as const

type KindId = (typeof KINDS)[number]["id"]

function kindOf(draft: BuilderDraft): KindId {
  if (draft.behavior === "approval" || draft.behavior === "yes_no")
    return draft.behavior
  if (draft.visual === "steps") return "steps"
  if (draft.visual === "progress_ring") return "ring"
  if (draft.visual === "progress_bar" || draft.behavior === "progress")
    return "progress"
  return "informational"
}

const SYMBOLS = [
  ["terminal", "Command line"],
  ["code", "Code"],
  ["build", "Build"],
  ["success", "Success"],
  ["warning", "Warning"],
  ["info", "Info"],
  ["question", "Question"],
  ["reply", "Reply"],
  ["image", "Image"],
  ["lock", "Lock"],
] as const

const ACCENTS = [
  ["#ff6b57", "Coral"],
  ["#f5a742", "Amber"],
  ["#5ed8b7", "Mint"],
  ["#5f98ff", "Blue"],
  ["#9278ff", "Violet"],
  ["#ef72aa", "Pink"],
] as const

const THEMES = [
  ["system", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const

function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={htmlFor} className="text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

function StepsEditor({
  labels,
  current,
  onChange,
}: {
  labels: string[]
  current: number
  onChange: (labels: string[], current: number) => void
}) {
  const clean = (value: string) => value.replaceAll(",", " ")
  return (
    <fieldset className="space-y-2" data-builder-steps-control>
      <legend className="mb-2 text-sm font-medium text-muted-foreground">
        Steps · tap the circle on the current one
      </legend>
      <ol className="space-y-1.5">
        {labels.map((label, index) => {
          const position = index + 1
          const isCurrent = position === current
          const done = position < current
          return (
            <li key={index} className="flex items-center gap-2">
              <label
                className={cn(
                  "grid size-11 shrink-0 cursor-pointer place-items-center rounded-full has-focus-visible:outline-2 has-focus-visible:outline-ring"
                )}
              >
                <input
                  type="radio"
                  name="builder-step-current"
                  className="sr-only"
                  checked={isCurrent}
                  onChange={() => onChange(labels, position)}
                  aria-label={`Make step ${position} current`}
                />
                <span
                  className={cn(
                    "grid size-5 place-items-center rounded-full border text-[10px]",
                    isCurrent
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-transparent bg-white/15 text-foreground"
                        : "border-border text-transparent"
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              </label>
              <Input
                value={label}
                aria-label={`Step ${position}`}
                maxLength={24}
                placeholder={`Step ${position}`}
                onChange={(event) => {
                  const next = [...labels]
                  next[index] = clean(event.target.value)
                  onChange(next, current)
                }}
                className="min-h-11"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0 text-muted-foreground"
                aria-label={`Remove step ${position}`}
                disabled={labels.length <= 2}
                onClick={() => {
                  const next = labels.filter((_, i) => i !== index)
                  onChange(next, Math.min(current, next.length))
                }}
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ol>
      {labels.length < MAX_STEPS ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 text-muted-foreground"
          onClick={() => onChange([...labels, ""], current)}
        >
          <Plus aria-hidden="true" />
          Add step
        </Button>
      ) : null}
    </fieldset>
  )
}

export function NewRunSheet({
  open,
  devices,
  draft,
  pending,
  update,
  reset,
  launch,
  openRun,
}: Props) {
  const readyDevices = devices.filter((device) => device.ready)
  const onlyDevice = readyDevices.length === 1 ? readyDevices[0].id : null

  // With exactly one ready iPhone there is nothing to choose.
  React.useEffect(() => {
    if (open && onlyDevice && !draft.deviceId) update("deviceId", onlyDevice)
  }, [draft.deviceId, onlyDevice, open, update])

  const kind = kindOf(draft)
  const stepLabels = draft.stepLabels.split(",").map((label) => label.trim())
  const stepCurrent = Math.min(Math.max(1, draft.stepCurrent), stepLabels.length)

  const chooseKind = (id: KindId) => {
    const next = KINDS.find((candidate) => candidate.id === id)
    if (!next) return
    update("behavior", next.behavior)
    update("visual", next.visual)
  }

  const blocker = !readyDevices.length
    ? "Connect an iPhone in Connections to send tests."
    : !draft.deviceId
      ? "Choose which iPhone to send to."
      : !draft.title.trim()
        ? "Add a title."
        : !draft.status.trim()
          ? "Add a status line."
          : kind === "steps" && stepLabels.filter(Boolean).length < 2
            ? "Name at least two steps."
            : null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (blocker) return
    const named = stepLabels
      .map((label, index) => ({ label, position: index + 1 }))
      .filter((step) => step.label)
    const current = Math.max(
      1,
      named.findIndex((step) => step.position >= stepCurrent) + 1 || named.length
    )
    const receipt = await launch({
      ...draft,
      stepLabels: named.map((step) => step.label).join(", "),
      stepCurrent: current,
    })
    openRun(receipt.activityId)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && navigateDashboard("/dashboard/testing")}
    >
      <SheetTrigger asChild>
        <Button
          className="min-h-11 px-4"
          onClick={() =>
            navigateDashboard(
              "/dashboard/testing?compose=1#activity-builder-panel"
            )
          }
        >
          <Plus aria-hidden="true" />
          New test
        </Button>
      </SheetTrigger>
      <SheetContent
        className="w-full gap-0 overflow-y-auto p-0 outline-none sm:max-w-[960px]! sm:rounded-l-[20px]"
        aria-describedby="new-run-description"
      >
        <SheetHeader className="border-b border-border px-6 py-5 pr-16">
          <SheetTitle className="text-lg">New test</SheetTitle>
          <SheetDescription id="new-run-description" className="sr-only">
            Design a notification and send it to your iPhone.
          </SheetDescription>
        </SheetHeader>
        <form
          id="activity-builder-form"
          onSubmit={submit}
          className="flex flex-1 flex-col"
          noValidate
        >
          <div
            id="activity-builder-panel"
            className="grid flex-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]"
          >
            <aside
              aria-label="Preview"
              className="border-b border-border bg-black/25 lg:border-r lg:border-b-0"
            >
              <div className="px-6 py-8 lg:sticky lg:top-0 lg:py-12">
                <NotificationPreview draft={{ ...draft, stepCurrent }} />
              </div>
            </aside>

            <div className="space-y-8 px-6 py-6">
              <fieldset>
                <legend className="mb-3 text-sm font-medium">
                  What kind of notification?
                </legend>
                <div className="overflow-hidden rounded-xl border border-border">
                  {KINDS.map((option) => {
                    const Icon = option.icon
                    const selected = option.id === kind
                    return (
                      <label
                        key={option.id}
                        className={cn(
                          "flex min-h-14 cursor-pointer items-center gap-3 border-b border-border px-3.5 py-2.5 transition-colors last:border-b-0 has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ring",
                          selected ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
                        )}
                      >
                        <input
                          type="radio"
                          name="builder-kind"
                          value={option.id}
                          checked={selected}
                          onChange={() => chooseKind(option.id)}
                          className="sr-only"
                        />
                        <Icon
                          className={cn(
                            "size-[18px] shrink-0",
                            selected ? "text-foreground" : "text-muted-foreground"
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">
                            {option.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {option.hint}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "grid size-5 shrink-0 place-items-center rounded-full border",
                            selected
                              ? "border-foreground bg-foreground text-background"
                              : "border-border"
                          )}
                          aria-hidden="true"
                        >
                          {selected ? (
                            <Check className="size-3" strokeWidth={3} />
                          ) : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <div className="space-y-4">
                <Field label="Title" htmlFor="builder-title">
                  <Input
                    id="builder-title"
                    name="builder-title"
                    maxLength={80}
                    required
                    value={draft.title}
                    onChange={(e) => update("title", e.target.value)}
                    className="min-h-11"
                  />
                </Field>
                <Field label="Status line" htmlFor="builder-status">
                  <Input
                    id="builder-status"
                    name="builder-status"
                    maxLength={80}
                    required
                    value={draft.status}
                    onChange={(e) => update("status", e.target.value)}
                    className="min-h-11"
                  />
                </Field>

                {kind === "progress" ? (
                  <div
                    className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                    data-builder-progress-fields
                  >
                    <Field label="Progress" htmlFor="builder-progress">
                      <div className="flex min-h-11 items-center gap-3">
                        <input
                          id="builder-progress"
                          name="builder-progress"
                          type="range"
                          min="0"
                          max="100"
                          value={draft.progress}
                          aria-valuetext={`${draft.progress}%`}
                          onChange={(e) =>
                            update("progress", Number(e.target.value))
                          }
                          className="h-1.5 flex-1 cursor-pointer accent-[var(--primary)]"
                        />
                        <output
                          htmlFor="builder-progress"
                          className="w-10 text-right text-sm tabular-nums"
                        >
                          {draft.progress}%
                        </output>
                      </div>
                    </Field>
                    <Field label="Bar label" htmlFor="builder-progress-label">
                      <Input
                        id="builder-progress-label"
                        name="builder-progress-label"
                        maxLength={32}
                        placeholder="Optional"
                        value={draft.progressLabel}
                        onChange={(e) => update("progressLabel", e.target.value)}
                        className="min-h-11"
                      />
                    </Field>
                  </div>
                ) : null}

                {kind === "steps" ? (
                  <StepsEditor
                    labels={stepLabels}
                    current={stepCurrent}
                    onChange={(labels, current) => {
                      update("stepLabels", labels.join(", "))
                      update("stepCurrent", current)
                    }}
                  />
                ) : null}

                {kind === "approval" || kind === "yes_no" ? (
                  <div
                    className="grid grid-cols-2 gap-3"
                    data-builder-action-labels
                  >
                    <Field label="Left button" htmlFor="builder-secondary-label">
                      <Input
                        id="builder-secondary-label"
                        name="builder-secondary-label"
                        maxLength={24}
                        value={draft.secondaryLabel}
                        onChange={(e) => update("secondaryLabel", e.target.value)}
                        className="min-h-11"
                      />
                    </Field>
                    <Field label="Right button" htmlFor="builder-primary-label">
                      <Input
                        id="builder-primary-label"
                        name="builder-primary-label"
                        maxLength={24}
                        value={draft.primaryLabel}
                        onChange={(e) => update("primaryLabel", e.target.value)}
                        className="min-h-11"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              <details className="group border-t border-border pt-2">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronDown
                    className="size-4 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                  More options
                </summary>
                <div className="grid gap-4 pt-3 sm:grid-cols-2">
                  <Field label="App name" htmlFor="builder-header">
                    <Input
                      id="builder-header"
                      name="builder-header"
                      maxLength={40}
                      value={draft.header}
                      onChange={(e) => update("header", e.target.value)}
                      className="min-h-11"
                    />
                  </Field>
                  <Field label="Subtitle" htmlFor="builder-subtitle">
                    <Input
                      id="builder-subtitle"
                      name="builder-subtitle"
                      maxLength={120}
                      value={draft.subtitle}
                      onChange={(e) => update("subtitle", e.target.value)}
                      className="min-h-11"
                    />
                  </Field>
                  <Field label="Icon" htmlFor="builder-symbol">
                    <NativeSelect
                      className="w-full"
                      id="builder-symbol"
                      name="builder-symbol"
                      value={draft.symbol}
                      onChange={(e) => update("symbol", e.target.value)}
                    >
                      {SYMBOLS.map(([symbol, label]) => (
                        <NativeSelectOption key={symbol} value={symbol}>
                          {label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Appearance" htmlFor="builder-theme">
                    <NativeSelect
                      className="w-full"
                      id="builder-theme"
                      name="builder-theme"
                      value={draft.theme}
                      onChange={(e) => update("theme", e.target.value)}
                    >
                      {THEMES.map(([value, label]) => (
                        <NativeSelectOption key={value} value={value}>
                          {label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <fieldset className="sm:col-span-2">
                    <legend className="mb-2 text-sm font-medium text-muted-foreground">
                      Accent
                    </legend>
                    <div className="flex flex-wrap items-center gap-1">
                      {ACCENTS.map(([color, name]) => (
                        <label
                          key={color}
                          className="grid size-11 cursor-pointer place-items-center rounded-full has-focus-visible:outline-2 has-focus-visible:outline-ring"
                        >
                          <input
                            type="radio"
                            name="builder-accent"
                            className="sr-only"
                            checked={draft.accentColor.toLowerCase() === color}
                            onChange={() => update("accentColor", color)}
                            aria-label={name}
                          />
                          <svg
                            className="size-7"
                            viewBox="0 0 28 28"
                            aria-hidden="true"
                          >
                            <circle cx="14" cy="14" r="11" fill={color} />
                            {draft.accentColor.toLowerCase() === color ? (
                              <circle
                                cx="14"
                                cy="14"
                                r="13"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              />
                            ) : null}
                          </svg>
                        </label>
                      ))}
                      <label className="ml-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground">
                        <input
                          id="builder-accent-color"
                          name="builder-accent-color"
                          type="color"
                          value={draft.accentColor}
                          onChange={(e) => update("accentColor", e.target.value)}
                          className="size-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
                        />
                        Custom
                      </label>
                    </div>
                  </fieldset>
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="-ml-2.5 min-h-11 text-muted-foreground"
                      data-builder-reset
                      onClick={reset}
                    >
                      Start over
                    </Button>
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-popover px-6 py-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Label
                htmlFor="activity-device"
                className="shrink-0 text-muted-foreground"
              >
                Send to
              </Label>
              {readyDevices.length ? (
                <NativeSelect
                  className="min-w-0 max-w-64"
                  id="activity-device"
                  name="activity-device"
                  aria-label="iPhone"
                  required
                  value={draft.deviceId}
                  onChange={(e) => update("deviceId", e.target.value)}
                >
                  <NativeSelectOption value="">Choose an iPhone</NativeSelectOption>
                  {devices.map((device) => (
                    <NativeSelectOption
                      key={device.id}
                      value={device.id}
                      disabled={!device.ready}
                    >
                      {device.name}
                      {device.ready ? "" : " — not ready"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <a
                  href={CONNECTIONS_HREF}
                  className="text-sm text-foreground underline underline-offset-4"
                >
                  Connect an iPhone
                </a>
              )}
            </div>
            <span
              id="builder-operation"
              role="status"
              aria-live="polite"
              className={cn(
                "text-xs",
                blocker && !pending && readyDevices.length
                  ? "text-[var(--status-warning)]"
                  : "text-muted-foreground",
                !pending && (!blocker || !readyDevices.length) && "sr-only"
              )}
            >
              {pending ? "Sending…" : (blocker ?? "Ready to send")}
            </span>
            <Button
              type="submit"
              id="start-live-activity"
              disabled={pending || Boolean(blocker)}
              className="min-h-11 px-5"
            >
              {pending ? "Sending…" : "Send test"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
