import { Palette, RotateCcw, SlidersHorizontal } from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type {
  PresentationPolicy,
  PresentationPolicySource,
} from "@/features/presentation-policy/types"

type PolicyResult = {
  policy: PresentationPolicy
  source: PresentationPolicySource
}

const labels = {
  automatic: "Automatic",
  standard: "Standard bar",
  terminal: "Terminal",
  steps: "Steps",
  system: "Follow system",
  light: "Light",
  dark: "Dark",
  code: "Code",
  build: "Build",
  success: "Success",
  warning: "Warning",
  fixed: "One fixed color",
  thread: "Stable per task",
  project: "Stable per project",
  off: "Off",
  on_request: "Only when requested",
  required: "Always private",
} as const

function label(value: keyof typeof labels) {
  return labels[value]
}

function Preview({ policy }: { policy: PresentationPolicy }) {
  const steps = policy.preset === "steps"
  return (
    <div
      className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0a0c] p-4 text-white"
      style={{
        background: `linear-gradient(135deg, ${policy.accentColor}33, #0b0a0c 62%)`,
      }}
      aria-label="Live Activity policy preview"
    >
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-white/70 uppercase">
        <span
          className="grid size-7 place-items-center rounded-lg text-black"
          style={{ backgroundColor: policy.accentColor }}
        >
          {policy.symbol === "code" ? "</>" : ">_"}
        </span>
        Relo
        <span className="ml-auto rounded-full bg-white/10 px-2 py-1 tracking-normal normal-case">
          Working
        </span>
      </div>
      <div className="mt-5 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Example task</p>
          <p className="mt-1 text-sm text-white/60">Implementing changes</p>
        </div>
        {steps ? (
          <div className="flex gap-1" aria-label="Two of four steps complete">
            {[0, 1, 2, 3].map((step) => (
              <span
                key={step}
                className="h-2 w-5 rounded-full"
                style={{
                  backgroundColor:
                    step < 2 ? policy.accentColor : "rgba(255,255,255,.18)",
                }}
              />
            ))}
          </div>
        ) : (
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full w-[42%] rounded-full"
              style={{ backgroundColor: policy.accentColor }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function SelectField({
  id,
  label: fieldLabel,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: Array<keyof typeof labels>
  onChange(value: string): void
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{fieldLabel}</Label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {label(option)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

export function PresentationPolicyControl({
  scopeLabel,
  initialPolicy,
  initialSource,
  canInherit = false,
  onSave,
  onReset,
}: {
  scopeLabel: string
  initialPolicy: PresentationPolicy
  initialSource: PresentationPolicySource
  canInherit?: boolean
  onSave(policy: PresentationPolicy): Promise<PolicyResult>
  onReset?(): Promise<PolicyResult>
}) {
  const [open, setOpen] = React.useState(false)
  const [policy, setPolicy] = React.useState(initialPolicy)
  const [draft, setDraft] = React.useState(initialPolicy)
  const [source, setSource] = React.useState(initialSource)
  const [pending, setPending] = React.useState<"save" | "reset" | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  function update<Key extends keyof PresentationPolicy>(
    key: Key,
    value: PresentationPolicy[Key]
  ) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function save() {
    setPending("save")
    setMessage(null)
    try {
      const result = await onSave(draft)
      setPolicy(result.policy)
      setSource(result.source)
      setOpen(false)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Policy save failed.")
    } finally {
      setPending(null)
    }
  }

  async function reset() {
    if (!onReset) return
    setPending("reset")
    setMessage(null)
    try {
      const result = await onReset()
      setPolicy(result.policy)
      setDraft(result.policy)
      setSource(result.source)
      setOpen(false)
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Policy reset failed."
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">Live Activity policy</p>
            <Badge variant="outline">
              {source === "system" ? "System default" : `${source} policy`}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {label(policy.preset)} · {label(policy.colorStrategy)} ·{" "}
            {label(policy.theme)}
          </p>
        </div>
        <Sheet
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (next) {
              setDraft(policy)
              setMessage(null)
            }
          }}
        >
          <SheetTrigger asChild>
            <Button type="button" variant="outline" className="min-h-11">
              <SlidersHorizontal aria-hidden="true" />
              Configure
            </Button>
          </SheetTrigger>
          <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
            <SheetHeader className="pr-12">
              <SheetTitle>{scopeLabel} Live Activity policy</SheetTitle>
              <SheetDescription>
                The server owns Live Activity appearance and deterministic
                defaults.
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-5 px-4 pb-4">
              <Preview policy={draft} />
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  id={`${scopeLabel}-preset`}
                  label="Preset"
                  value={draft.preset}
                  options={["automatic", "standard", "terminal", "steps"]}
                  onChange={(value) =>
                    update("preset", value as PresentationPolicy["preset"])
                  }
                />
                <SelectField
                  id={`${scopeLabel}-theme`}
                  label="Theme"
                  value={draft.theme}
                  options={["system", "light", "dark"]}
                  onChange={(value) =>
                    update("theme", value as PresentationPolicy["theme"])
                  }
                />
                <SelectField
                  id={`${scopeLabel}-symbol`}
                  label="Symbol"
                  value={draft.symbol}
                  options={[
                    "automatic",
                    "terminal",
                    "code",
                    "build",
                    "success",
                    "warning",
                  ]}
                  onChange={(value) =>
                    update("symbol", value as PresentationPolicy["symbol"])
                  }
                />
                <SelectField
                  id={`${scopeLabel}-color-strategy`}
                  label="Color assignment"
                  value={draft.colorStrategy}
                  options={["thread", "project", "fixed"]}
                  onChange={(value) =>
                    update(
                      "colorStrategy",
                      value as PresentationPolicy["colorStrategy"]
                    )
                  }
                />
              </div>
              {draft.colorStrategy === "fixed" ? (
                <div className="grid gap-2">
                  <Label htmlFor={`${scopeLabel}-accent`}>Fixed accent</Label>
                  <div className="flex gap-3">
                    <Input
                      id={`${scopeLabel}-accent`}
                      type="color"
                      className="min-h-11 w-16 p-1"
                      value={draft.accentColor}
                      onChange={(event) =>
                        update("accentColor", event.currentTarget.value)
                      }
                    />
                    <Input
                      aria-label="Accent color hexadecimal value"
                      className="min-h-11 font-mono"
                      value={draft.accentColor}
                      pattern="#[0-9A-Fa-f]{6}"
                      onChange={(event) =>
                        update("accentColor", event.currentTarget.value)
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="flex gap-3 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
                  <Palette
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  The server selects a stable color from an accessible palette;
                  raw task identifiers are never sent to the phone.
                </div>
              )}
              {message ? (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              ) : null}
            </div>
            <SheetFooter className="border-t border-border">
              <Button
                type="button"
                disabled={pending !== null}
                onClick={() => void save()}
              >
                {pending === "save" ? "Saving…" : "Save policy"}
              </Button>
              {canInherit && onReset ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void reset()}
                >
                  <RotateCcw aria-hidden="true" />
                  {pending === "reset" ? "Resetting…" : "Use inherited policy"}
                </Button>
              ) : null}
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  )
}
