import type { ComputerIcon as ComputerIconName } from "@relo/notification-contracts"
import * as React from "react"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { COMPUTER_ICON_LIST, COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { OperationStatus } from "@/components/molecules/operation-status"
import { SegmentedField } from "@/components/molecules/segmented-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Saved, SavedStatus } from "@/features/presentation-policy/use-saved"
import { ACCENT_SWATCHES } from "@/features/presentation-policy/swatches"
import type { PresentationPolicy } from "@/features/presentation-policy/types"
import { cn } from "@/lib/utils"

/**
 * The appearance controls shared by a computer's panel, the account page and a webhook: icon (computers only),
 * color, most open cards (computers only). Every control saves as you choose (no Save button), shows its own
 * "Saved" or the error under it, and changes the preview at once: `useSaved` applies the choice first and puts
 * the old value back if the server refuses it.
 */

function StatusLine({ status }: { status: SavedStatus }) {
  return (
    <OperationStatus
      className="text-xs"
      pending={status.state === "saving"}
      pendingLabel="Saving…"
      error={status.state === "error" ? status.message : null}
      success={status.state === "saved" ? status.message : null}
    />
  )
}

/** A control's caption, its one-line help, then the control. */
function Control({ title, help, children, status }: { title: string; help?: React.ReactNode; children: React.ReactNode; status: SavedStatus }) {
  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {help ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{help}</p> : null}
      </div>
      {children}
      <StatusLine status={status} />
    </div>
  )
}

type IconChoice = ComputerIconName | "automatic"

/** The icon grid: six tiles and "Automatic", one radio group (arrow keys move, Tab leaves). */
export function IconPicker({ saved, automatic }: { saved: Saved<ComputerIconName | null>; automatic: ComputerIconName }) {
  const uid = React.useId()
  const choices: IconChoice[] = [...COMPUTER_ICON_LIST, "automatic"]
  const current: IconChoice = saved.value ?? "automatic"
  const pick = (choice: IconChoice) => saved.commit(choice === "automatic" ? null : choice)
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = (choices.indexOf(current) + step + choices.length) % choices.length
    pick(choices[index]!)
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[index]?.focus()
  }
  return (
    <Control title="Icon" help="Shown on this computer's cards, in the app and on your Lock Screen." status={saved.status}>
      <div role="radiogroup" aria-label="Icon" aria-describedby={`${uid}-hint`} className="grid grid-cols-3 gap-2" onKeyDown={move}>
        {choices.map((choice) => {
          const checked = choice === current
          const icon = choice === "automatic" ? automatic : choice
          const label = choice === "automatic" ? `Automatic (${COMPUTER_ICON_META[automatic].label})` : COMPUTER_ICON_META[choice].label
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => pick(choice)}
              className={cn(
                "press flex min-h-14 flex-col items-center justify-center gap-1.5 rounded-[14px] border px-2 py-2.5 text-xs outline-none sm:min-h-16",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
                checked
                  ? "border-[var(--hairline-strong)] bg-[var(--control-fill-active)] text-foreground"
                  : "border-[var(--hairline)] bg-white/[0.03] text-muted-foreground hover:border-[var(--hairline-strong)] hover:text-foreground",
                choice === "automatic" && "col-span-3 flex-row gap-2 min-h-11 sm:min-h-11"
              )}
            >
              <ComputerIcon icon={icon} className={choice === "automatic" ? "size-4" : "size-5"} />
              <span className="text-center leading-4">{label}</span>
            </button>
          )
        })}
      </div>
      <span id={`${uid}-hint`} className="sr-only">Arrow keys change the icon.</span>
    </Control>
  )
}

const HEX = /^#[0-9a-fA-F]{6}$/
const sameColor = (a: string, b: string | undefined) => a.toLowerCase() === String(b ?? "").toLowerCase()

/** Per project, or one color (eight swatches and a custom one). The color tints the icon on the Lock Screen. */
export function ColorControl({ saved }: { saved: Saved<PresentationPolicy> }) {
  const uid = React.useId()
  const policy = saved.value
  // What is being typed in the hex field; null while it just shows the chosen color.
  const [editing, setEditing] = React.useState<string | null>(null)
  const hex = editing ?? policy.accentColor
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  const choose = (accentColor: string) => saved.commit({ ...policy, colorStrategy: "fixed", accentColor })
  const typed = (next: string) => {
    setEditing(next)
    if (!HEX.test(next)) return
    // A color being dragged shows at once and saves when it settles.
    saved.preview({ ...policy, colorStrategy: "fixed", accentColor: next })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => choose(next), 450)
  }
  const swatchMove = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const at = ACCENT_SWATCHES.findIndex((swatch) => sameColor(swatch.color, policy.accentColor))
    const index = (Math.max(0, at) + step + ACCENT_SWATCHES.length) % ACCENT_SWATCHES.length
    choose(ACCENT_SWATCHES[index]!.color)
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[index]?.focus()
  }
  const fixed = policy.colorStrategy === "fixed"
  const chosenSwatch = ACCENT_SWATCHES.findIndex((swatch) => sameColor(swatch.color, policy.accentColor))
  return (
    <Control
      title="Color"
      help={fixed ? "Colors the icon on your Lock Screen." : "Each project gets its own color. Colors the icon on your Lock Screen."}
      status={saved.status}
    >
      <SegmentedField
        label="Color"
        hideLabel
        value={policy.colorStrategy}
        options={[
          { value: "project", label: "Per project" },
          { value: "fixed", label: "One color" },
        ]}
        onChange={(colorStrategy) => saved.commit({ ...policy, colorStrategy })}
      />
      {fixed ? (
        <div className="grid gap-3">
          <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2" onKeyDown={swatchMove}>
            {ACCENT_SWATCHES.map((swatch, index) => {
              const checked = index === chosenSwatch
              return (
                <button
                  key={swatch.color}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={swatch.name}
                  tabIndex={checked || (chosenSwatch < 0 && index === 0) ? 0 : -1}
                  onClick={() => choose(swatch.color)}
                  className={cn(
                    "press grid size-8 place-items-center rounded-full border-2 outline-none pointer-coarse:size-11",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
                    checked ? "border-white" : "border-transparent"
                  )}
                >
                  <span className="size-5 rounded-full pointer-coarse:size-7" style={{ backgroundColor: swatch.color }} />
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor={`${uid}-picker`} className="sr-only">Custom color</Label>
            <Input
              id={`${uid}-picker`}
              type="color"
              className="w-14 p-1"
              value={HEX.test(policy.accentColor) ? policy.accentColor : "#5ED8B7"}
              onChange={(event) => typed(event.currentTarget.value)}
            />
            <Input
              aria-label="Color as hex"
              className="w-32 font-mono"
              value={hex}
              maxLength={7}
              onBlur={() => setEditing(null)}
              spellCheck={false}
              aria-invalid={!HEX.test(hex) || undefined}
              onChange={(event) => typed(event.currentTarget.value)}
            />
          </div>
        </div>
      ) : null}
    </Control>
  )
}

const LIMITS = [
  { value: "none", label: "No limit" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
] as const

/** The most cards this computer keeps open; past it, questions arrive as notifications with answer buttons. */
export function CardLimitControl({ saved }: { saved: Saved<number | null> }) {
  const current = saved.value === null ? "none" : String(saved.value)
  const options: Array<{ value: string; label: string }> = LIMITS.some((option) => option.value === current)
    ? [...LIMITS]
    : [...LIMITS, { value: current, label: current }]
  return (
    <Control
      title="Most open cards"
      help="Past the limit, this computer's questions arrive as notifications with answer buttons."
      status={saved.status}
    >
      <SegmentedField
        label="Most open cards"
        hideLabel
        value={current}
        options={options}
        onChange={(value) => saved.commit(value === "none" ? null : Number(value))}
      />
    </Control>
  )
}

/**
 * The whole set. A computer passes `icon` and `limit`; the account page and a webhook pass the color only.
 * "Use account defaults" shows only while something is overridden.
 */
export function AppearanceControls({
  icon,
  color,
  limit,
  overridden = false,
  onUseDefaults,
  defaultsLabel = "Use account defaults",
}: {
  icon?: { saved: Saved<ComputerIconName | null>; automatic: ComputerIconName }
  color: Saved<PresentationPolicy>
  limit?: Saved<number | null>
  overridden?: boolean
  onUseDefaults?: () => Promise<void>
  defaultsLabel?: string
}) {
  const [resetting, setResetting] = React.useState<SavedStatus>({ state: "idle" })
  return (
    <div className="grid gap-6">
      {icon ? <IconPicker saved={icon.saved} automatic={icon.automatic} /> : null}
      <ColorControl saved={color} />
      {limit ? <CardLimitControl saved={limit} /> : null}
      {overridden && onUseDefaults ? (
        <div className="grid gap-1.5 border-t border-[var(--divider)] pt-4">
          <Button
            type="button"
            variant="link"
            className="h-auto w-fit p-0"
            disabled={resetting.state === "saving"}
            onClick={() => {
              setResetting({ state: "saving" })
              onUseDefaults().then(
                () => setResetting({ state: "idle" }),
                (cause) => setResetting({ state: "error", message: cause instanceof Error ? cause.message : "Relo could not reset this." })
              )
            }}
          >
            {defaultsLabel}
          </Button>
          <StatusLine status={resetting} />
        </div>
      ) : null}
    </div>
  )
}
