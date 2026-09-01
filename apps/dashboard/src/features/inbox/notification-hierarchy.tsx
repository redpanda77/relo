import { ChevronRight, Folder, Laptop, MessagesSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { NotificationRow } from "@/features/inbox/components"
import {
  notificationProject,
  requesterLabel,
} from "@/features/inbox/notification-project"
import type { NotificationSummary } from "@/features/inbox/types"

type ThreadGroup = {
  key: string
  name: string
  contextual: boolean
  notifications: NotificationSummary[]
}

type ProjectGroup = {
  key: string
  name: string
  direct: boolean
  threads: ThreadGroup[]
}

type OriginGroup = {
  key: string
  name: string
  description: string
  projects: ProjectGroup[]
}

type MutableProjectGroup = ProjectGroup & {
  threadIndex: Map<string, ThreadGroup>
}

type MutableOriginGroup = Omit<OriginGroup, "projects"> & {
  projects: MutableProjectGroup[]
  projectIndex: Map<string, MutableProjectGroup>
}

function itemCount(value: number): string {
  return `${value} ${value === 1 ? "record" : "records"}`
}

function notificationCount(project: ProjectGroup): number {
  return project.threads.reduce(
    (total, thread) => total + thread.notifications.length,
    0
  )
}

function groupNotifications(
  notifications: NotificationSummary[]
): OriginGroup[] {
  const origins = new Map<string, MutableOriginGroup>()

  for (const notification of notifications) {
    const context = notification.activity?.context ?? notification.context
    const provider =
      context.providerName ?? requesterLabel(notification.requesterKind)
    const computer = context.computer
    const originKey = [notification.source, provider, computer ?? ""].join(
      "\u0000"
    )
    let origin = origins.get(originKey)
    if (!origin) {
      origin = {
        key: originKey,
        name: notification.source,
        description: computer
          ? `Origin: ${provider} on ${computer}`
          : `Origin: ${provider}`,
        projects: [],
        projectIndex: new Map(),
      }
      origins.set(originKey, origin)
    }

    const projectIdentity = notificationProject(notification)
    const projectName = projectIdentity.name
    const projectKey = projectIdentity.key
    let project = origin.projectIndex.get(projectKey)
    if (!project) {
      project = {
        key: projectKey,
        name: projectName,
        direct: projectIdentity.direct,
        threads: [],
        threadIndex: new Map(),
      }
      origin.projectIndex.set(projectKey, project)
      origin.projects.push(project)
    }

    const threadIdentity =
      context.providerThreadId ??
      notification.activity?.originThreadId ??
      notification.originThreadId ??
      (context.threadName ? `name:${context.threadName}` : null)
    const threadKey = threadIdentity ?? "direct"
    let thread = project.threadIndex.get(threadKey)
    if (!thread) {
      thread = {
        key: threadKey,
        name:
          context.threadName ??
          (threadIdentity ? "Unnamed thread" : "Direct calls"),
        contextual: Boolean(threadIdentity),
        notifications: [],
      }
      project.threadIndex.set(threadKey, thread)
      project.threads.push(thread)
    }
    thread.notifications.push(notification)
  }

  return [...origins.values()].map((origin) => ({
    key: origin.key,
    name: origin.name,
    description: origin.description,
    projects: origin.projects.map((project) => ({
      key: project.key,
      name: project.name,
      direct: project.direct,
      threads: project.threads,
    })),
  }))
}

export function NotificationHierarchy({
  notifications,
}: {
  notifications: NotificationSummary[]
}) {
  const origins = groupNotifications(notifications)

  return (
    <div className="space-y-7" data-slot="notification-hierarchy">
      {origins.map((origin) => {
        const originRecords = origin.projects.reduce(
          (total, project) => total + notificationCount(project),
          0
        )
        return (
          <section
            key={origin.key}
            className="border-t border-border/80 pt-4 first:border-t-0 first:pt-0"
            data-slot="notification-origin-group"
            aria-label={`Origin ${origin.name}`}
          >
            <header className="flex min-w-0 items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-card text-muted-foreground">
                <Laptop
                  className="size-4.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <h3 className="truncate text-base font-semibold">
                    {origin.name}
                  </h3>
                  <Badge variant="outline" className="shrink-0 tabular-nums">
                    {itemCount(originRecords)}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {origin.description}
                </p>
              </div>
            </header>

            <div className="mt-5 space-y-6 sm:ml-[52px]">
              {origin.projects.map((project) => (
                <details
                  open
                  key={project.key}
                  className="group/project"
                  data-slot="notification-project-group"
                  aria-label={`Project ${project.name}`}
                >
                  <summary className="flex min-h-11 min-w-0 cursor-pointer list-none items-center gap-2.5 rounded-lg transition-colors outline-none hover:bg-card/45 focus-visible:ring-3 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
                    <Folder
                      className="size-4 shrink-0 text-primary"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {project.direct
                        ? project.name
                        : `Project: ${project.name}`}
                    </h4>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {itemCount(notificationCount(project))}
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-open/project:rotate-90"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </summary>

                  <div className="mt-3 space-y-5 border-l border-border/70 pl-3 sm:pl-4">
                    {project.threads.map((thread) =>
                      thread.contextual ? (
                        <details
                          open
                          key={thread.key}
                          className="group/thread"
                          data-slot="notification-thread-group"
                          aria-label={`Thread ${thread.name}`}
                        >
                          <summary className="mb-2.5 flex min-h-10 min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg transition-colors outline-none hover:bg-card/45 focus-visible:ring-3 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
                            <MessagesSquare
                              className="size-3.5 shrink-0 text-muted-foreground"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                            <h5 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                              Thread:{" "}
                              <span className="text-foreground/90">
                                {thread.name}
                              </span>
                            </h5>
                            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                              {itemCount(thread.notifications.length)}
                            </span>
                            <ChevronRight
                              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/thread:rotate-90"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                          </summary>
                          <div className="space-y-2.5">
                            {thread.notifications.map((notification) => (
                              <NotificationRow
                                key={notification.id}
                                notification={notification}
                              />
                            ))}
                          </div>
                        </details>
                      ) : (
                        <div key={thread.key} className="space-y-2.5">
                          {thread.notifications.map((notification) => (
                            <NotificationRow
                              key={notification.id}
                              notification={notification}
                            />
                          ))}
                        </div>
                      )
                    )}
                  </div>
                </details>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
