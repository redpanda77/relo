import { useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { cardFor } from "@/features/inbox/activity-model"
import { DetailSkeleton } from "@/features/inbox/detail-skeleton"
import { NotificationDetailBody, type DetailOrigin } from "@/features/inbox/notification-detail"
import type { NotificationDetail, NotificationSummary } from "@/features/inbox/types"
import type { InboxService } from "@/services/inbox-service"

type Panel =
  | { state: "loading"; id: string; origin: DetailOrigin }
  | { state: "ready"; id: string; origin: DetailOrigin; detail: NotificationDetail }
  | { state: "failed"; id: string; origin: DetailOrigin; href: string }

/** Where a listed notification came from, for its detail (sealed names it has not learned are left out). */
export function detailOriginOf(notification: NotificationSummary): DetailOrigin {
  const card = cardFor(notification)
  return { source: card.source, project: card.project, topic: card.topic, computer: card.origin }
}

/** "Source › Project › Topic" (notificationContext): only a full path says which part is which. */
function originFromContext(context: string): DetailOrigin {
  const [source, project, topic] = context.split(" › ")
  return context.split(" › ").length === 3
    ? { source, project: project ? { name: project, slot: null } : null, topic }
    : { source: source || null }
}

function detailHref(id: string) {
  return `/dashboard/inbox/notifications/${encodeURIComponent(id)}`
}

/**
 * A notification's detail in a side sheet, loaded through the route loader (so a linked browser
 * opens it like any page), 600px wide (iOS reads it as a sheet, the web as a side panel). Returns the opener, the sheet to render once on the page, and the id of
 * the notification open in it (null when closed), so the list can mark the row it came from.
 * The sheet travels its full width in; the body shows its own shape while it loads, then the
 * content fades up in its place (`.detail-panel-body` in `nav.css`).
 */
export function useDetailPanel(service: InboxService) {
  // The last panel stays rendered while the sheet slides away, so closing never flashes a skeleton.
  const [panel, setPanel] = useState<Panel | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const open = async (id: string, from: DetailOrigin | string = {}) => {
    const origin = typeof from === "string" ? originFromContext(from) : from
    setIsOpen(true)
    setPanel({ state: "loading", id, origin })
    try {
      const route = await fetchDashboardRoute(detailHref(id))
      if (
        route.kind === "dashboard" &&
        route.bootstrap.kind === "notification-detail"
      ) {
        setPanel({ state: "ready", id, origin, detail: route.bootstrap })
      } else {
        setPanel({ state: "failed", id, origin, href: detailHref(id) })
      }
    } catch {
      setPanel({ state: "failed", id, origin, href: detailHref(id) })
    }
  }

  const sheet = (
    <Sheet
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SheetContent
        side="right"
        className="detail-panel w-full gap-0 overflow-y-auto border-l p-0 outline-none sm:max-w-[600px]"
        aria-busy={panel?.state === "loading" ? "true" : undefined}
      >
        <div key={panel?.state} className="detail-panel-body" data-state={panel?.state}>
          {panel?.state === "ready" ? (
            <NotificationDetailBody
              variant="panel"
              detail={panel.detail}
              origin={panel.origin}
              service={service}
              heading={(title) => (
                <SheetTitle className="pr-8 text-xl font-semibold tracking-tight">
                  {title}
                </SheetTitle>
              )}
            />
          ) : panel?.state === "failed" ? (
            <>
              <SheetTitle className="sr-only">Notification</SheetTitle>
              <SheetDescription className="px-6 pt-16 text-center">
                Couldn't load this notification.{" "}
                <a className="underline" href={panel.href}>
                  Open it in full
                </a>
                .
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="sr-only">Notification</SheetTitle>
              <SheetDescription className="sr-only">Loading…</SheetDescription>
              <DetailSkeleton />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
  return { open, sheet, openId: isOpen && panel ? panel.id : null }
}
