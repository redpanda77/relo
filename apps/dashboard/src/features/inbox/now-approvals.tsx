import { Check, LoaderCircle, X } from "lucide-react"
import { AnimatePresence, m, type TargetAndTransition } from "motion/react"
import * as React from "react"

import { PresenceList } from "@/components/molecules/presence-list"
import { WorkCard } from "@/components/organisms/work-card"
import { Button } from "@/components/ui/button"
import { useNowStage } from "@/features/inbox/now-context"
import type { InboxOverview } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import { DUR, EASE_IN } from "@/lib/motion"

type ApprovalRequest = NonNullable<InboxOverview["approvalRequests"]>[number]
type Decision = "approve" | "deny"
type Actions = {
  pendingCodes: ReadonlySet<string>
  errorFor: (code: string) => string | null
  decide: (code: string, decision: Decision) => Promise<boolean>
}

/** Approved: the card holds its mint "Approved" for a beat, then lifts away. Denied: a quick, neutral exit. */
const APPROVED_EXIT: TargetAndTransition = { opacity: 0, scale: 0.96, y: -6, transition: { duration: DUR.fast, ease: EASE_IN, delay: 0.45 } }
const DENIED_EXIT: TargetAndTransition = { opacity: 0, y: -4, transition: { duration: DUR.micro, ease: EASE_IN } }
const ICON_IN = { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 600, damping: 24 } } as const

const getKey = (request: ApprovalRequest) => request.userCode
const layoutId = (request: ApprovalRequest) => `now-approval-${request.userCode}`

/** A button's icon: a spinner while its decision is in flight, its mark again (popping) once done. */
function DecisionIcon({ pending, icon: Icon }: { pending: boolean; icon: typeof Check }) {
  return (
    <span className="relative inline-grid size-4 place-items-center" aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        {pending ? (
          <m.span key="pending" className="grid place-items-center" initial={{ opacity: 0, scale: 0.7 }} animate={ICON_IN} exit={{ opacity: 0, transition: { duration: DUR.micro } }}>
            <LoaderCircle className="animate-spin" />
          </m.span>
        ) : (
          <m.span key="mark" className="grid place-items-center" initial={{ opacity: 0, scale: 0.6 }} animate={ICON_IN} exit={{ opacity: 0, transition: { duration: DUR.micro } }}>
            <Icon />
          </m.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/**
 * Connection requests on Now, on the shared needs-you card (glyph, tint, countdown, actions).
 * Approving crossfades the card from orange to mint with "Approved" before it leaves; denying
 * sends it off quickly in neutral. The decision itself is the server's:
 * the card leaves when the next overview no longer lists it.
 */
export function ConnectionRequests({ approvals, actions }: { approvals: readonly ApprovalRequest[]; actions: Actions }) {
  const { ready } = useNowStage()
  const [chosen, setChosen] = React.useState<ReadonlyMap<string, Decision>>(() => new Map())
  const [decided, setDecided] = React.useState<ReadonlyMap<string, Decision>>(() => new Map())
  const decide = (code: string, decision: Decision) => {
    setChosen((current) => new Map(current).set(code, decision))
    void actions.decide(code, decision).then((succeeded) => {
      if (succeeded) setDecided((current) => new Map(current).set(code, decision))
    })
  }
  const exitFor = (request: ApprovalRequest) => {
    const decision = decided.get(request.userCode)
    return decision === "approve" ? APPROVED_EXIT : decision === "deny" ? DENIED_EXIT : undefined
  }
  return (
    <PresenceList
      label="Connection requests"
      items={approvals}
      getKey={getKey}
      layoutId={layoutId}
      animateFirst={ready}
      enterDelay={ready ? 0.06 : 0}
      exitFor={exitFor}
      className="now-card-grid"
      itemClassName="now-card-slot"
    >
      {(request) => {
        const code = request.userCode
        const pending = actions.pendingCodes.has(code)
        const error = actions.errorFor(code)
        const decision = decided.get(code)
        const choice = chosen.get(code)
        const tone = decision === "approve" ? "mint" : decision === "deny" ? "neutral" : "orange"
        const scopes = request.requestedScopes.join(", ") || "no permissions"
        const until = request.credentialExpiresAt ? `access until ${formatDashboardDate(request.credentialExpiresAt)}` : null
        return (
          <div data-decided={decision} className="h-full">
            <WorkCard
              tone={tone}
              title={`Connect ${request.clientName}`}
              summary={[`Code ${request.userCode}`, scopes, until].filter(Boolean).join(" · ")}
              summaryLines={4}
              asked={!decision}
              tint
              live={false}
              state={decision === "approve" ? { label: "Approved", icon: Check } : decision === "deny" ? { label: "Denied", icon: X } : { label: "Needs you", dot: true }}
              deadline={decision ? null : request.approvalExpiresAt}
              answers={
                <div className="card-answers">
                  <Button
                    tone="var(--neon-orange)"
                    className="card-answer"
                    data-action="approve-approval"
                    data-code={code}
                    disabled={pending}
                    onClick={() => decide(code, "approve")}
                  >
                    <DecisionIcon pending={pending && choice === "approve"} icon={Check} /> Approve
                  </Button>
                  <Button
                    variant="outline"
                    className="card-answer"
                    data-action="deny-approval"
                    data-code={code}
                    disabled={pending}
                    onClick={() => decide(code, "deny")}
                  >
                    <DecisionIcon pending={pending && choice === "deny"} icon={X} /> Deny
                  </Button>
                  {error ? (
                    <p role="alert" className="col-span-2 text-xs text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>
              }
            />
          </div>
        )
      }}
    </PresenceList>
  )
}
