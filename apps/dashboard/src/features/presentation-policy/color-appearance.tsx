import type { ComputerIcon } from "@relo/notification-contracts"
import * as React from "react"

import { exampleCard } from "@/components/organisms/live-activity-model"
import { LiveActivityPreview } from "@/components/organisms/live-activity-preview"
import { AppearanceControls } from "@/features/presentation-policy/appearance-controls"
import { useSaved } from "@/features/presentation-policy/use-saved"
import { PREVIEW_PROJECT_COLOR } from "@/features/presentation-policy/swatches"
import type { PresentationPolicy, PresentationPolicySource } from "@/features/presentation-policy/types"

type PolicyResult = { policy: PresentationPolicy; source: PresentationPolicySource }

/**
 * The color setting of an account or a webhook (the computer's panel has the full set): the same shared controls
 * and the same Lock Screen preview, color only. "Use … defaults" shows only while this scope overrides its parent.
 */
export function ColorAppearance({
  initialPolicy,
  initialSource,
  canInherit = false,
  inheritLabel = "Use account defaults",
  icon = "laptop",
  onSave,
  onReset,
}: {
  initialPolicy: PresentationPolicy
  initialSource: PresentationPolicySource
  canInherit?: boolean
  inheritLabel?: string
  /** The glyph the example card shows (a webhook is a cloud). */
  icon?: ComputerIcon
  onSave(policy: PresentationPolicy): Promise<PolicyResult>
  onReset?(): Promise<PolicyResult>
}) {
  const [source, setSource] = React.useState(initialSource)
  const color = useSaved<PresentationPolicy>(initialPolicy, async (next) => {
    const saved = await onSave(next)
    setSource(saved.source)
  })
  return (
    <div className="grid gap-5">
      <div className="rounded-[14px] border border-[var(--hairline)] bg-white/[0.03] p-4">
        <LiveActivityPreview
          model={{
            ...exampleCard("live"),
            icon,
            tone: "live",
            accent: color.value.colorStrategy === "fixed" ? color.value.accentColor : PREVIEW_PROJECT_COLOR,
          }}
        />
      </div>
      <AppearanceControls
        color={color}
        overridden={canInherit && onReset !== undefined && source !== "system" && source !== "account"}
        defaultsLabel={inheritLabel}
        onUseDefaults={
          onReset
            ? async () => {
                const reset = await onReset()
                color.replace(reset.policy)
                setSource(reset.source)
              }
            : undefined
        }
      />
    </div>
  )
}
