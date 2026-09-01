import { RotateCcw, Rocket } from "lucide-react"
import * as React from "react"

import { FieldNote } from "@/components/atoms/field-note"
import { NotificationPreview } from "@/components/organisms/notification-preview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type { LaunchRunReceipt } from "@/features/test-lab/launch-receipt"
import type {
  BuilderDraft,
  TestDevice,
  TestLabBootstrap,
} from "@/features/test-lab/types"
import { navigateDashboard } from "@/state/use-dashboard-route"

type Props = {
  open: boolean
  devices: TestDevice[]
  presets: TestLabBootstrap["composer"]["presets"]
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

function Field({
  label,
  htmlFor,
  children,
  note,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  note?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {note ? <FieldNote>{note}</FieldNote> : null}
    </div>
  )
}

export function NewRunSheet({
  open,
  devices,
  presets,
  draft,
  pending,
  update,
  reset,
  launch,
  openRun,
}: Props) {
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const receipt = await launch(draft)
    openRun(receipt.activityId)
  }
  const showsProgress = draft.visual === "progress_bar"
  const showsSteps = draft.visual === "steps"
  const showsActions =
    draft.behavior === "approval" || draft.behavior === "yes_no"
  const applyPreset = (presetId: string) => {
    const preset = presets.find((candidate) => candidate.id === presetId)
    if (!preset) return
    const { presentation } = preset
    const { behavior } = presentation
    const visual =
      presentation.components.find((component) => component.type === "steps") ??
      presentation.components.find((component) => component.type === "progress_bar")
    update("preset", presetId)
    update(
      "behavior",
      behavior.type
    )
    update(
      "visual",
      visual?.type ?? "none"
    )
    update("title", presentation.content.title)
    update("status", presentation.content.status)
    update("header", presentation.content.header ?? "")
    update("subtitle", presentation.content.subtitle ?? "")
    update("theme", presentation.appearance.theme)
    update(
      "accentColor",
      presentation.identity.project?.color ??
        presentation.identity.thread?.color ??
        draft.accentColor
    )
    update("symbol", presentation.state.icon)
    if (visual?.type === "progress_bar") {
      update("progress", Math.round(visual.value * 100))
      update("progressLabel", visual.label ?? "")
    } else if (visual?.type === "steps") {
      const currentIndex = visual.items.findIndex(
        (item) => item.state === "current"
      )
      const completed = visual.items.filter(
        (item) => item.state === "complete"
      ).length
      update("stepLabels", visual.items.map((item) => item.label).join(", "))
      update(
        "stepCurrent",
        currentIndex >= 0 ? currentIndex + 1 : Math.max(1, completed)
      )
      update(
        "progress",
        visual.items.length
          ? Math.round((completed / visual.items.length) * 100)
          : 0
      )
    }
    if (behavior.type === "approval" || behavior.type === "yes_no") {
      update("primaryLabel", behavior.primary.label)
      update("secondaryLabel", behavior.secondary.label)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && navigateDashboard("/dashboard/testing")}
    >
      <SheetTrigger asChild>
        <Button
          className="min-h-11 bg-[#ff6b5e] px-5 text-[#1b0d0d] hover:bg-[#ff806e]"
          onClick={() =>
            navigateDashboard(
              "/dashboard/testing?compose=1#activity-builder-panel"
            )
          }
        >
          <Rocket />
          New Run
        </Button>
      </SheetTrigger>
      <SheetContent
        className="w-full overflow-y-auto border-[#403343] bg-popover p-0 sm:max-w-[680px]! sm:rounded-l-[20px]"
        aria-describedby="new-run-description"
      >
        <SheetHeader className="border-b border-border px-6 py-5 pr-16">
          <SheetTitle className="text-xl">New notification run</SheetTitle>
          <SheetDescription id="new-run-description">
            Compose one focused lock-screen preview, then launch it to the
            selected device.
          </SheetDescription>
        </SheetHeader>
        <form id="activity-builder-form" onSubmit={submit}>
          <section id="activity-builder-panel" className="space-y-7 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">Builder</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Draft changes are saved in this browser.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                data-builder-reset
                onClick={reset}
              >
                <RotateCcw />
                Reset
              </Button>
            </div>
            <div>
              <p className="mb-4 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                Lock screen preview
              </p>
              <NotificationPreview draft={draft} />
              <div
                className="mx-auto mt-3 flex max-w-[330px] flex-wrap gap-2 text-[11px] text-muted-foreground"
                aria-label="Semantic presentation roles"
              >
                <span className="rounded-full border border-border px-2.5 py-1">
                  Project · card identity
                </span>
                <span className="rounded-full border border-border px-2.5 py-1">
                  Thread · component identity
                </span>
                <span className="rounded-full border border-border px-2.5 py-1">
                  State · status emphasis
                </span>
              </div>
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Target iPhone"
                htmlFor="activity-device"
                note="Only devices marked ready can receive a new run."
              >
                <NativeSelect
                  className="w-full"
                  id="activity-device"
                  name="activity-device"
                  required
                  value={draft.deviceId}
                  onChange={(e) => update("deviceId", e.target.value)}
                >
                  <NativeSelectOption value="">
                    Select a ready device
                  </NativeSelectOption>
                  {devices.map((device) => (
                    <NativeSelectOption
                      key={device.id}
                      value={device.id}
                      disabled={!device.ready}
                    >
                      {device.name}
                      {device.ready ? "" : " (not ready)"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Preset shortcut" htmlFor="builder-preset">
                <NativeSelect
                  className="w-full"
                  id="builder-preset"
                  name="builder-preset"
                  value={draft.preset}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {presets.map((preset) => (
                    <NativeSelectOption key={preset.id} value={preset.id}>
                      {preset.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Behavior" htmlFor="builder-behavior">
                <NativeSelect
                  className="w-full"
                  id="builder-behavior"
                  name="builder-behavior"
                  value={draft.behavior}
                  onChange={(e) => update("behavior", e.target.value)}
                >
                  <NativeSelectOption value="informational">
                    Information only
                  </NativeSelectOption>
                  <NativeSelectOption value="progress">
                    Progress
                  </NativeSelectOption>
                  <NativeSelectOption value="approval">
                    Approval CTA
                  </NativeSelectOption>
                  <NativeSelectOption value="yes_no">
                    Yes or no CTA
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field label="Layout recipe" htmlFor="builder-visual">
                <NativeSelect
                  className="w-full"
                  id="builder-visual"
                  name="builder-visual"
                  value={draft.visual}
                  onChange={(e) => update("visual", e.target.value)}
                >
                  <NativeSelectOption value="none">
                    No visual
                  </NativeSelectOption>
                  <NativeSelectOption value="progress_bar">
                    Progress bar
                  </NativeSelectOption>
                  <NativeSelectOption value="steps">
                    Named steps / phases
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            {showsProgress ? (
              <div
                className="grid gap-4 sm:grid-cols-2"
                data-builder-progress-fields
              >
                <Field label="Starting progress" htmlFor="builder-progress">
                  <Input
                    id="builder-progress"
                    name="builder-progress"
                    type="range"
                    min="0"
                    max="100"
                    value={draft.progress}
                    onChange={(e) => update("progress", Number(e.target.value))}
                    className="min-h-11"
                  />
                  <output
                    id="builder-progress-output"
                    htmlFor="builder-progress"
                    className="text-xs text-muted-foreground"
                  >
                    {draft.progress}%
                  </output>
                </Field>
                <Field label="Progress label" htmlFor="builder-progress-label">
                  <Input
                    id="builder-progress-label"
                    name="builder-progress-label"
                    maxLength={32}
                    value={draft.progressLabel}
                    onChange={(e) => update("progressLabel", e.target.value)}
                    className="min-h-11"
                  />
                </Field>
              </div>
            ) : null}
            {showsSteps ? (
              <div
                className="grid gap-4 sm:grid-cols-2"
                data-builder-steps-control
              >
                <Field
                  label="Step labels"
                  htmlFor="builder-step-labels"
                  note="Up to 8 comma-separated labels."
                >
                  <Input
                    id="builder-step-labels"
                    name="builder-step-labels"
                    value={draft.stepLabels}
                    onChange={(e) => update("stepLabels", e.target.value)}
                    className="min-h-11"
                  />
                </Field>
                <Field label="Current position" htmlFor="builder-step-current">
                  <Input
                    id="builder-step-current"
                    name="builder-step-current"
                    type="number"
                    min="1"
                    max="8"
                    value={draft.stepCurrent}
                    onChange={(e) =>
                      update("stepCurrent", Number(e.target.value))
                    }
                    className="min-h-11"
                  />
                </Field>
              </div>
            ) : null}
            {showsActions ? (
              <div
                className="grid gap-4 sm:grid-cols-2"
                data-builder-action-labels
              >
                <Field label="Primary action" htmlFor="builder-primary-label">
                  <Input
                    id="builder-primary-label"
                    name="builder-primary-label"
                    maxLength={24}
                    value={draft.primaryLabel}
                    onChange={(e) => update("primaryLabel", e.target.value)}
                    className="min-h-11"
                  />
                </Field>
                <Field
                  label="Secondary action"
                  htmlFor="builder-secondary-label"
                >
                  <Input
                    id="builder-secondary-label"
                    name="builder-secondary-label"
                    maxLength={24}
                    value={draft.secondaryLabel}
                    onChange={(e) => update("secondaryLabel", e.target.value)}
                    className="min-h-11"
                  />
                </Field>
              </div>
            ) : null}
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
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
              <Field label="Status" htmlFor="builder-status">
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
            </div>
            <details className="rounded-[10px] border border-border bg-[#171118] p-4">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                Advanced content and appearance
              </summary>
              <div className="grid gap-4 pt-4 sm:grid-cols-2">
                <Field label="Header" htmlFor="builder-header">
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
                <Field label="Symbol" htmlFor="builder-symbol">
                  <NativeSelect
                    className="w-full"
                    id="builder-symbol"
                    name="builder-symbol"
                    value={draft.symbol}
                    onChange={(e) => update("symbol", e.target.value)}
                  >
                    {[
                      "terminal",
                      "code",
                      "build",
                      "success",
                      "warning",
                      "info",
                      "question",
                      "reply",
                      "image",
                      "lock",
                    ].map((symbol) => (
                      <NativeSelectOption key={symbol} value={symbol}>
                        {symbol}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Theme" htmlFor="builder-theme">
                  <NativeSelect
                    className="w-full"
                    id="builder-theme"
                    name="builder-theme"
                    value={draft.theme}
                    onChange={(e) => update("theme", e.target.value)}
                  >
                    <NativeSelectOption value="system">
                      System
                    </NativeSelectOption>
                    <NativeSelectOption value="light">Light</NativeSelectOption>
                    <NativeSelectOption value="dark">Dark</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field label="Accent color" htmlFor="builder-accent-color">
                  <Input
                    id="builder-accent-color"
                    name="builder-accent-color"
                    type="color"
                    value={draft.accentColor}
                    onChange={(e) => update("accentColor", e.target.value)}
                    className="min-h-11 p-1"
                  />
                </Field>
              </div>
            </details>
            <details className="text-xs text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-3 text-sm text-foreground">
                Runtime capability notes
              </summary>
              <p className="leading-5">
                The server assigns project, thread, and state identity. It
                selects each native surface and downgrades the recipe for older
                clients without changing the canonical run.
              </p>
            </details>
            <p
              data-builder-gate-note
              className="text-xs leading-5 text-muted-foreground"
            >
              {draft.behavior === "progress"
                ? "Progress behavior enables per-ID updates after launch."
                : "This behavior launches as a durable, independently controlled run."}
            </p>
          </section>
          <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-popover px-6 py-4">
            <span
              id="builder-operation"
              className="mr-auto text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {pending ? "Launching run..." : "Draft saved"}
            </span>
            <Button
              type="submit"
              id="start-live-activity"
              disabled={pending || !draft.deviceId}
              className="min-h-11 bg-[#ff6b5e] text-[#1b0d0d] hover:bg-[#ff806e]"
            >
              {pending ? "Launching..." : "Launch run"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
