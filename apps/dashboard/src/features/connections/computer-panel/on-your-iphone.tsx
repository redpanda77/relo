import * as React from "react"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { SegmentedField } from "@/components/molecules/segmented-field"
import { exampleCard, type LiveActivityPreviewModel, type LiveActivityTone } from "@/components/organisms/live-activity-model"
import { LiveActivityPreview } from "@/components/organisms/live-activity-preview"
import type { ConnectionComputer } from "@/features/connections/types"
import { AppearanceControls } from "@/features/presentation-policy/appearance-controls"
import { useSaved } from "@/features/presentation-policy/use-saved"
import { PREVIEW_PROJECT_COLOR } from "@/features/presentation-policy/swatches"
import type { PresentationPolicy, PresentationPolicySource } from "@/features/presentation-policy/types"
import type { ConnectionsService } from "@/services/connections-service"

const SHOW_AS: Array<{ value: LiveActivityTone; label: string }> = [
  { value: "live", label: "Working" },
  { value: "attention", label: "Needs you" },
  { value: "success", label: "Done" },
]

/**
 * What this computer's cards look like on the iPhone, with the controls that change it. A choice shows in the
 * preview at once and saves as you make it; the preview's example card has a plan, so it shows steps, as the phone does.
 */
export function OnYourIphone({
  computer,
  api,
  onChange,
}: {
  computer: ConnectionComputer
  api: ConnectionsService
  onChange(update: (current: ConnectionComputer) => ConnectionComputer): void
}) {
  const [tone, setTone] = React.useState<LiveActivityTone>("live")
  const [source, setSource] = React.useState<PresentationPolicySource>(computer.liveActivityPolicySource)
  // What "Automatic" resolves to: the computer's own icon while the owner has chosen none, else the machine's guess.
  const automatic = computer.iconSource === "owner" ? (computer.report?.machineKind ?? "laptop") : computer.icon

  const icon = useSaved(computer.iconSource === "owner" ? computer.icon : null, async (next) => {
    const record = await api.updateComputer(computer.id, { icon: next })
    onChange((current) => ({ ...current, ...record }))
  })
  const color = useSaved<PresentationPolicy>(computer.effectiveLiveActivityPolicy, async (next) => {
    const saved = await api.saveClientLiveActivityPolicy(computer.loginId, next)
    setSource(saved.source)
    onChange((current) => ({
      ...current,
      liveActivityPolicy: saved.policy,
      effectiveLiveActivityPolicy: saved.policy,
      liveActivityPolicySource: saved.source as ConnectionComputer["liveActivityPolicySource"],
    }))
  })
  const limit = useSaved<number | null>(computer.maxActiveCards, async (next) => {
    await api.setClientCardLimit(computer.loginId, next)
    onChange((current) => ({ ...current, maxActiveCards: next }))
  })

  const shownIcon = icon.value ?? automatic
  const model: LiveActivityPreviewModel = {
    ...exampleCard(tone),
    icon: shownIcon,
    accent: color.value.colorStrategy === "fixed" ? color.value.accentColor : PREVIEW_PROJECT_COLOR,
    tone,
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 rounded-[14px] border border-[var(--hairline)] bg-white/[0.03] p-4">
        <LiveActivityPreview model={model} />
        <p className="text-center text-xs text-muted-foreground">
          An example card from {computer.name} with the {COMPUTER_ICON_META[shownIcon].label.toLowerCase()} icon. Your Lock Screen always shows cards dark.
        </p>
        <SegmentedField label="Show as" value={tone} options={SHOW_AS} onChange={(value) => setTone(value as LiveActivityTone)} className="mx-auto w-full max-w-[380px] grid-cols-[auto_1fr] items-center gap-3" />
      </div>
      <AppearanceControls
        icon={{ saved: icon, automatic }}
        color={color}
        limit={limit}
        overridden={source === "client"}
        onUseDefaults={async () => {
          const reset = await api.resetClientLiveActivityPolicy(computer.loginId)
          color.replace(reset.policy)
          setSource(reset.source)
          onChange((current) => ({
            ...current,
            liveActivityPolicy: null,
            effectiveLiveActivityPolicy: reset.policy,
            liveActivityPolicySource: reset.source as ConnectionComputer["liveActivityPolicySource"],
          }))
        }}
      />
    </div>
  )
}
