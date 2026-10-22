import { MotionConfig } from "motion/react"
import { lazy, Suspense, type ReactNode } from "react"

import type { DashboardBootstrap } from "@/app/bootstrap"
import {
  loadAccountPage,
  loadActivityHistoryPage,
  loadConnectionsFeature,
  loadInboxFeature,
  loadTestLabPage,
} from "@/app/dashboard-page-loaders"
import { RouteLoadingFallback } from "@/app/route-loading-fallback"
import { AuthPage } from "@/features/auth/auth-page"
import { LandingBoundary } from "@/features/landing/landing-boundary"
import { DashboardShell } from "@/layouts/dashboard-shell"
import {
  createHttpTestLabService,
  type TestLabService,
} from "@/services/test-lab-service"
import { startHeartbeat } from "@/lib/heartbeat"

// Every breathing loop on one phase-locked beat, from the first frame.
startHeartbeat()

const LandingPage = lazy(() =>
  import("@/features/landing/landing-page").then((module) => ({ default: module.LandingPage }))
)
const AccountPage = lazy(loadAccountPage)
const ConnectionsFeature = lazy(loadConnectionsFeature)
const DocsSite = lazy(() => import("@/features/docs/docs-site").then((module) => ({ default: module.DocsSite })))
const InboxFeature = lazy(loadInboxFeature)
const ActivityHistoryPage = lazy(loadActivityHistoryPage)
const TestLabPage = lazy(loadTestLabPage)

type DashboardAppProps = {
  bootstrap: DashboardBootstrap
  service?: TestLabService
}

/** The app under one motion config: every `motion` animation honours the system's reduced motion. */
export function DashboardApp(props: DashboardAppProps) {
  return (
    <MotionConfig reducedMotion="user">
      <DashboardRoutes {...props} />
    </MotionConfig>
  )
}

function DashboardRoutes({ bootstrap, service }: DashboardAppProps) {
  if (bootstrap.kind === "auth" && bootstrap.view === "landing")
    return (
      <LandingBoundary>
        <Suspense fallback={<main id="main-content" className="canvas min-h-[100dvh]" aria-busy="true" />}>
          <LandingPage filmBase={bootstrap.film?.base} />
        </Suspense>
      </LandingBoundary>
    )
  if (bootstrap.kind === "auth") return <AuthPage bootstrap={bootstrap} />
  // The public docs keep the server's article on screen until the layout is ready (no flash of a spinner).
  if (bootstrap.kind === "docs")
    return (
      <Suspense fallback={null}>
        <DocsSite bootstrap={bootstrap} />
      </Suspense>
    )

  let content: ReactNode
  switch (bootstrap.kind) {
    case "test-lab":
      content = (
        <TestLabPage
          initial={bootstrap}
          service={service ?? createHttpTestLabService(bootstrap)}
        />
      )
      break
    case "activity-history":
      content = <ActivityHistoryPage bootstrap={bootstrap} />
      break
    case "connections":
      content = <ConnectionsFeature bootstrap={bootstrap} />
      break
    case "account":
      content = <AccountPage initial={bootstrap} />
      break
    case "inbox-overview":
    case "notification-history":
    case "delivery-history":
    case "notification-detail":
      content = <InboxFeature bootstrap={bootstrap} />
      break
    default:
      content = bootstrap satisfies never
  }

  return (
    <DashboardShell shell={bootstrap.shell}>
      <Suspense fallback={<RouteLoadingFallback />}>{content}</Suspense>
    </DashboardShell>
  )
}
