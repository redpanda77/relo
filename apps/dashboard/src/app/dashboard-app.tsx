import { lazy, Suspense, type ReactNode } from "react"

import type { DashboardBootstrap } from "@/app/bootstrap"
import {
  loadAccountPage,
  loadActivityHistoryPage,
  loadConnectionsFeature,
  loadDocumentationPage,
  loadInboxFeature,
  loadProjectsPage,
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

const LandingPage = lazy(() =>
  import("@/features/landing/landing-page").then((module) => ({ default: module.LandingPage }))
)
const AccountPage = lazy(loadAccountPage)
const ConnectionsFeature = lazy(loadConnectionsFeature)
const DocumentationPage = lazy(loadDocumentationPage)
const InboxFeature = lazy(loadInboxFeature)
const ProjectsPage = lazy(loadProjectsPage)
const ActivityHistoryPage = lazy(loadActivityHistoryPage)
const TestLabPage = lazy(loadTestLabPage)

export function DashboardApp({
  bootstrap,
  service,
}: {
  bootstrap: DashboardBootstrap
  service?: TestLabService
}) {
  if (bootstrap.kind === "auth" && bootstrap.view === "landing")
    return (
      <LandingBoundary>
        <Suspense fallback={<main id="main-content" className="canvas min-h-[100dvh]" aria-busy="true" />}>
          <LandingPage />
        </Suspense>
      </LandingBoundary>
    )
  if (bootstrap.kind === "auth") return <AuthPage bootstrap={bootstrap} />

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
    case "docs":
      content = <DocumentationPage initial={bootstrap} />
      break
    case "inbox-overview":
    case "notification-history":
    case "delivery-history":
    case "notification-detail":
      content = <InboxFeature bootstrap={bootstrap} />
      break
    case "projects":
      content = <ProjectsPage bootstrap={bootstrap} />
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
