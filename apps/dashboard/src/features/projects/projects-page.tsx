import {
  Archive,
  ArrowLeft,
  CircleCheck,
  Code2,
  Folder,
  FolderKanban,
  GitMerge,
  Hammer,
  LayoutDashboard,
  Palette,
  RotateCcw,
  Split,
  Tags,
  Terminal,
  TriangleAlert,
  Webhook,
} from "lucide-react"
import * as React from "react"

import { Empty, List, Page, Row, Section, Status } from "@/components/page"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select"
import { ConfirmationAction } from "@/features/connections/components"
import type {
  DashboardProject,
  ProjectsDashboardBootstrap,
} from "@/features/projects/types"
import { displayName, displayNameOrNull, isOpaqueHandle } from "@/lib/encrypted"
import { relativeTime } from "@/lib/format"
import { projectsService } from "@/services/projects-service"

const projectColors = [
  "#ff6b57",
  "#f5a742",
  "#e4ca4f",
  "#5ed8b7",
  "#4ecbd7",
  "#5f98ff",
  "#9278ff",
  "#cf75ed",
  "#ef72aa",
  "#fb7f83",
  "#8fa6b8",
  "#c3a38a",
] as const

const projectIconOptions = [
  ["folder", "Folder"],
  ["project", "Project board"],
  ["terminal", "Command line"],
  ["webhook", "Webhook"],
  ["dashboard", "Dashboard"],
  ["code", "Code"],
  ["build", "Build"],
  ["success", "Success"],
  ["warning", "Warning"],
] as const

function date(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function ProjectMark({ project }: { project: DashboardProject }) {
  const normalizedSlot = ((project.palette.slot % projectColors.length) + projectColors.length) % projectColors.length
  const color = projectColors[normalizedSlot]
  const icons = {
    folder: Folder,
    project: FolderKanban,
    terminal: Terminal,
    webhook: Webhook,
    dashboard: LayoutDashboard,
    code: Code2,
    build: Hammer,
    success: CircleCheck,
    warning: TriangleAlert,
  }
  const Icon = icons[project.icon as keyof typeof icons] ?? FolderKanban
  return (
    <span
      className="grid size-10 shrink-0 place-items-center rounded-xl border"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 44%, transparent)`,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
      }}
      aria-hidden="true"
    >
      <Icon className="size-5" />
    </span>
  )
}

function ProjectIndex({ bootstrap }: { bootstrap: ProjectsDashboardBootstrap }) {
  if (!bootstrap.projects.length)
    return <Empty title="No projects yet" description="Projects appear as soon as a notification or Live Activity names one." />
  return (
    <List label="Projects">
      {bootstrap.projects.map((project) => (
        <Row
          key={project.id}
          href={`/dashboard/projects/${encodeURIComponent(project.id)}`}
          leading={<ProjectMark project={project} />}
          title={<>{displayName(project.name)}{project.archivedAt ? <span className="ml-2 text-xs font-normal text-muted-foreground">Archived</span> : null}</>}
          meta={`${project.counts.conversations} ${project.counts.conversations === 1 ? "topic" : "topics"} · ${project.counts.notifications} notifications`}
          trailing={<time dateTime={project.lastSeenAt} title={date(project.lastSeenAt)}>{relativeTime(project.lastSeenAt)}</time>}
        />
      ))}
    </List>
  )
}

function MutationStatus({ id, pending, error }: { id: string; pending: boolean; error: string | null }) {
  if (!pending && !error) return null
  return (
    <p id={id} tabIndex={-1} className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role={error ? "alert" : "status"} aria-live="polite">
      {error ?? (pending ? "Saving project changes…" : "")}
    </p>
  )
}

function ManagementRail({ bootstrap }: { bootstrap: ProjectsDashboardBootstrap }) {
  const selected = bootstrap.selected!
  const project = selected.project
  const mutableProjects = bootstrap.projects.filter((item) => !item.isDirect && !item.archivedAt && item.id !== project.id)
  const [pendingAction,setPendingAction] = React.useState<string | null>(null)
  const [errorAction,setErrorAction] = React.useState<string | null>(null)
  const [error,setError] = React.useState<string | null>(null)
  const [mergeTargetId,setMergeTargetId] = React.useState("")
  const [splitDestination,setSplitDestination] = React.useState("")
  const [newProjectName,setNewProjectName] = React.useState("")
  const [selectedConversationIds,setSelectedConversationIds] = React.useState<string[]>([])
  const pending = pendingAction !== null

  React.useEffect(() => {
    if (errorAction) document.getElementById(`project-${errorAction}-status`)?.focus()
  },[error,errorAction])

  function status(action:string) {
    return <MutationStatus id={`project-${action}-status`} pending={pendingAction === action} error={errorAction === action ? error : null} />
  }

  async function run(action:string,operation: () => Promise<unknown>) {
    setPendingAction(action)
    setErrorAction(null)
    setError(null)
    try {
      await operation()
      window.location.reload()
    } catch (cause) {
      setErrorAction(action)
      setError(cause instanceof Error ? cause.message : "Project change failed.")
      setPendingAction(null)
    }
  }

  return (
    <aside className="order-1 space-y-4 xl:order-2" aria-label="Project management">
      {!project.isDirect && !project.archivedAt ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 font-semibold leading-none tracking-tight"><Palette className="size-4" /> Identity</h2>
            <CardDescription>Owner choices survive future producer refreshes.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void run("identity",() => projectsService.update(project.id,{
                expectedRevision:project.revision,
                displayName:String(form.get("displayName") ?? "").trim(),
                icon:String(form.get("icon") ?? "folder"),
                paletteSlot:Number(form.get("paletteSlot")),
              }))
            }}>
              <div className="space-y-2">
                <Label htmlFor="project-display-name">Display name</Label>
                <Input id="project-display-name" name="displayName" defaultValue={isOpaqueHandle(project.name) ? "" : project.name} maxLength={80} required disabled={pending} className="min-h-11" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="project-icon">Icon role</Label>
                  <NativeSelect id="project-icon" name="icon" defaultValue={project.icon} className="min-h-11 w-full" disabled={pending}>
                    {projectIconOptions.map(([value,label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Project color</legend>
                <div className="grid grid-cols-6 gap-2">
                  {projectColors.map((color,index) => <label key={color} className="grid size-11 cursor-pointer place-items-center rounded-lg border bg-card hover:bg-accent">
                    <input className="peer sr-only" type="radio" name="paletteSlot" value={index} defaultChecked={index === project.palette.slot} disabled={pending} aria-label={`Project color ${index + 1}`} />
                    <span className="size-6 rounded-full border-2 border-background ring-offset-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-checked:ring-2 peer-checked:ring-foreground peer-checked:ring-offset-2" style={{ backgroundColor:color }} aria-hidden="true" />
                  </label>)}
                </div>
              </fieldset>
              <Button className="min-h-11" disabled={pending}>Save identity</Button>
              {status("identity")}
            </form>
          </CardContent>
        </Card>
      ) : null}

      {!project.isDirect && !project.archivedAt ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 font-semibold leading-none tracking-tight"><Tags className="size-4" /> Aliases</h2>
            <CardDescription>Future producer labels resolve to this project.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected.aliases.length ? <ul className="space-y-2">{selected.aliases.map((alias) => (
              <li key={alias.id} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <span className="min-w-0 truncate">{displayName(alias.name)}</span>
                <Button type="button" size="sm" className="min-h-11" variant="ghost" disabled={pending} onClick={() => void run("aliases",() => projectsService.removeAlias(project.id,alias.id,project.revision))}>Remove</Button>
              </li>
            ))}</ul> : <p className="text-sm text-muted-foreground">No accepted aliases yet.</p>}
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault()
              const value = new FormData(event.currentTarget).get("alias")
              void run("aliases",() => projectsService.addAlias(project.id,{ expectedRevision:project.revision,displayName:String(value ?? "").trim() }))
            }}>
              <Input className="min-h-11" name="alias" aria-label="New project alias" placeholder="Add alias" maxLength={80} required disabled={pending} />
              <Button className="min-h-11" variant="outline" disabled={pending}>Add</Button>
            </form>
            {status("aliases")}
          </CardContent>
        </Card>
      ) : null}

      {selected.conversations.length ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 font-semibold leading-none tracking-tight"><Split className="size-4" /> Split conversations</h2>
            <CardDescription>Move exact durable conversations. No text inference is used.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Conversations to move</legend>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {selected.conversations.map((conversation) => (
                  <label key={conversation.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent/50">
                    <input type="checkbox" value={conversation.id} className="size-4" checked={selectedConversationIds.includes(conversation.id)} onChange={(event) => setSelectedConversationIds((current) => event.target.checked ? [...current,conversation.id] : current.filter((id) => id !== conversation.id))} />
                    <span className="min-w-0 truncate text-sm">{displayName(conversation.name)}</span>
                  </label>
                ))}
                </div>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor="split-destination">Destination</Label>
                <NativeSelect id="split-destination" className="min-h-11 w-full" value={splitDestination} onChange={(event) => setSplitDestination(event.target.value)} disabled={pending}>
                  <NativeSelectOption value="">Choose a destination…</NativeSelectOption>
                  <NativeSelectOption value="new">Create a new project</NativeSelectOption>
                  {mutableProjects.map((item) => <NativeSelectOption key={item.id} value={item.id}>{displayName(item.name)}</NativeSelectOption>)}
                </NativeSelect>
                {splitDestination === "new" ? <Input className="min-h-11" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} aria-label="New destination project name" placeholder="New project name" maxLength={80} required /> : null}
              </div>
              {selectedConversationIds.length && splitDestination && (splitDestination !== "new" || newProjectName.trim()) ? <ConfirmationAction
                label={`Move ${selectedConversationIds.length} ${selectedConversationIds.length === 1 ? "conversation" : "conversations"}`}
                title={`Move from ${displayName(project.name)}?`}
                description={`Move ${selectedConversationIds.length} ${selectedConversationIds.length === 1 ? "conversation" : "conversations"} from ${displayName(project.name)} to ${splitDestination === "new" ? newProjectName.trim() : displayNameOrNull(mutableProjects.find((item) => item.id === splitDestination)?.name)}. Membership changes atomically.`}
                pending={pending}
                variant="outline"
                onConfirm={() => {
                  const target = mutableProjects.find((item) => item.id === splitDestination)
                  const destination = splitDestination === "new"
                    ? { kind:"new" as const,displayName:newProjectName.trim() }
                    : { kind:"existing" as const,projectId:target!.id,expectedRevision:target!.revision }
                  void run("split",() => projectsService.split(project.id,{ expectedRevision:project.revision,conversationIds:selectedConversationIds,destination }))
                }}
              /> : <Button type="button" className="min-h-11" variant="outline" disabled>Select conversations and destination</Button>}
              {status("split")}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!project.isDirect && !project.archivedAt && mutableProjects.length ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 font-semibold leading-none tracking-tight"><GitMerge className="size-4" /> Merge project</h2>
            <CardDescription>The current project becomes a permanent redirect.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <NativeSelect aria-label="Merge destination project" className="min-h-11 w-full" value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)} disabled={pending}>
                <NativeSelectOption value="">Choose a destination…</NativeSelectOption>
                {mutableProjects.map((item) => <NativeSelectOption key={item.id} value={item.id}>{displayName(item.name)}</NativeSelectOption>)}
              </NativeSelect>
              {mergeTargetId ? <ConfirmationAction label={`Merge into ${displayNameOrNull(mutableProjects.find((item) => item.id === mergeTargetId)?.name)}`} title={`Merge ${displayName(project.name)}?`} description={`Move all ${project.counts.conversations} conversations from ${displayName(project.name)} into ${displayNameOrNull(mutableProjects.find((item) => item.id === mergeTargetId)?.name)}. ${displayName(project.name)} becomes a permanent redirect.`} pending={pending} onConfirm={() => {
                const target = mutableProjects.find((item) => item.id === mergeTargetId)!
                void run("merge",() => projectsService.merge(project.id,{ expectedRevision:project.revision,targetProjectId:target.id,targetExpectedRevision:target.revision }))
              }} /> : <Button type="button" className="min-h-11" variant="destructive" disabled>Choose a merge destination</Button>}
              {status("merge")}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!project.isDirect ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 font-semibold leading-none tracking-tight">{project.archivedAt ? <RotateCcw className="size-4" /> : <Archive className="size-4" />} Lifecycle</h2>
            <CardDescription>{project.archivedAt ? "Restore this project to active use." : "Archive only after active work has ended."}</CardDescription>
          </CardHeader>
          <CardContent>
            <ConfirmationAction
              label={project.archivedAt ? "Restore project" : "Archive project"}
              title={project.archivedAt ? "Restore this project?" : "Archive this project?"}
              description={project.archivedAt ? "The project returns to the active index." : "History remains available and producer activity can safely restore it."}
              pending={pending}
              variant={project.archivedAt ? "outline" : "destructive"}
              onConfirm={() => void run("lifecycle",() => project.archivedAt ? projectsService.restore(project.id,project.revision) : projectsService.archive(project.id,project.revision))}
            />
            <div className="mt-3">{status("lifecycle")}</div>
          </CardContent>
        </Card>
      ) : null}
    </aside>
  )
}

function ProjectDetail({ bootstrap }: { bootstrap: ProjectsDashboardBootstrap }) {
  const selected = bootstrap.selected!
  return (
    <>
      <Section title="Topics">
        {selected.conversations.length ? (
          <List label="Topics">
            {selected.conversations.map((conversation) => (
              <Row key={conversation.id} title={displayName(conversation.name)}
                trailing={<time dateTime={conversation.lastSeenAt} title={date(conversation.lastSeenAt)}>{relativeTime(conversation.lastSeenAt)}</time>} />
            ))}
          </List>
        ) : <Empty title="No topics yet" />}
      </Section>
      <Section title="Recent activity">
        {selected.recent.length ? (
          <List label="Recent activity">
            {selected.recent.map((item) => (
              <Row key={`${item.kind}-${item.id}`} title={item.title}
                trailing={<><Status value={item.state} /><time dateTime={item.occurredAt} title={date(item.occurredAt)}>{relativeTime(item.occurredAt)}</time></>} />
            ))}
          </List>
        ) : <Empty title="No recent activity" />}
      </Section>
      <details className="group">
        <summary className="cursor-pointer text-sm text-muted-foreground select-none hover:text-foreground">Manage project</summary>
        <div className="mt-4 max-w-xl"><ManagementRail bootstrap={bootstrap} /></div>
      </details>
    </>
  )
}

export function ProjectsPage({ bootstrap }: { bootstrap: ProjectsDashboardBootstrap }) {
  const selected = bootstrap.selected
  return (
    <Page
      title={selected ? displayName(selected.project.name) : "Projects"}
      actions={selected ? <a href="/dashboard/projects" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden="true" /> All projects</a> : null}
    >
      {selected ? <ProjectDetail bootstrap={bootstrap} /> : <ProjectIndex bootstrap={bootstrap} />}
    </Page>
  )
}
