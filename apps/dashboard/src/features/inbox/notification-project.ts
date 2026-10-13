import type { NotificationSummary } from "@/features/inbox/types"
import { hierarchy } from "@/lib/format"

export type NotificationProjectOption = {
  key: string
  name: string
}

export function requesterLabel(
  requesterKind: NotificationSummary["requesterKind"]
): string {
  switch (requesterKind) {
    case "cli":
      return "Direct CLI"
    case "webhook":
      return "Direct webhook"
    case "dashboard":
      return "Dashboard"
  }
}

export function notificationProject(
  notification: NotificationSummary
): NotificationProjectOption & { direct: boolean } {
  if (notification.resources) {
    return {
      key: notification.resources.project.id,
      name: notification.resources.project.name,
      direct: notification.resources.project.isDirect,
    }
  }
  const context = notification.activity?.context ?? notification.context
  if (context.project) {
    return {
      key: `project:${context.project}`,
      name: context.project,
      direct: false,
    }
  }
  return {
    key: `direct:${notification.requesterKind}`,
    name: requesterLabel(notification.requesterKind),
    direct: true,
  }
}

export function notificationProjectOptions(
  notifications: NotificationSummary[]
): NotificationProjectOption[] {
  const options = new Map<string, NotificationProjectOption>()
  for (const notification of notifications) {
    const project = notificationProject(notification)
    options.set(project.key, { key: project.key, name: project.name })
  }
  return [...options.values()]
}

export function notificationContext(notification: NotificationSummary): string {
  const project = notificationProject(notification)
  const context = notification.activity?.context ?? notification.context
  return hierarchy(
    notification.source,
    project.direct ? null : project.name,
    context.threadName
  )
}
