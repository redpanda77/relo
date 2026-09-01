import {
  ArrowLeft,
  BellRing,
  Clock3,
  GitBranch,
  History,
  Radio,
  ScanSearch,
  Smartphone,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { ActivityHistory as ActivityHistoryModel } from "@/features/test-lab/activity-history"
import { semanticStatusTone } from "@/lib/status-tone"

function when(value: string | null): string {
  if (!value) return "Not set"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function words(value: string): string {
  return value.replaceAll("_", " ")
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm break-words text-foreground">
        {value}
      </dd>
    </div>
  )
}

export function ActivityHistoryPage({
  bootstrap,
}: {
  bootstrap: ActivityHistoryModel
}) {
  const { activity } = bootstrap
  const tone = semanticStatusTone(activity.state)

  return (
    <main
      id="main-content"
      className="canvas min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-10 lg:py-10"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <Button variant="outline" className="min-h-11" asChild>
          <a href={bootstrap.route.backHref}>
            <ArrowLeft aria-hidden="true" />
            Back to run
          </a>
        </Button>

        <header className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="status-chip rounded-full"
              data-tone={tone}
            >
              {activity.state}
            </Badge>
            <Badge variant="outline" className="rounded-full font-mono">
              Generation {activity.generation}
            </Badge>
            <Badge variant="outline" className="rounded-full font-mono">
              Sequence {activity.sequence}
            </Badge>
            {activity.lifecycle ? (
              <Badge variant="outline" className="rounded-full capitalize">
                {activity.lifecycle.provider} lifecycle
              </Badge>
            ) : null}
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            {activity.title}
          </h1>
          <p className="mt-3 max-w-[70ch] text-sm leading-6 text-muted-foreground">
            {bootstrap.shell.description}
          </p>
        </header>

        <Card className="status-card rounded-[14px]" data-tone={tone}>
          <CardHeader className="gap-3">
            <div className="flex items-center gap-3">
              <span className="status-icon-tile grid size-11 shrink-0 place-items-center rounded-xl">
                <History className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <CardTitle className="truncate">{activity.status}</CardTitle>
                <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  {activity.id}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {activity.detail ? (
              <p className="max-w-[75ch] text-sm leading-6 text-muted-foreground">
                {activity.detail}
              </p>
            ) : null}
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Requester" value={activity.requesterLabel} />
              <Detail label="Origin key" value={<code>{activity.key}</code>} />
              {activity.lifecycle ? (
                <>
                  <Detail label="Agent provider" value={activity.lifecycle.provider} />
                  <Detail
                    label="Opaque run identity"
                    value={<code>{activity.lifecycle.runId}</code>}
                  />
                </>
              ) : null}
              <Detail label="Style" value={activity.style} />
              <Detail label="Privacy" value={activity.privacy} />
              <Detail
                label="Progress"
                value={
                  activity.progress == null
                    ? "Not set"
                    : `${Math.round(activity.progress * 100)}%`
                }
              />
              <Detail label="Created" value={when(activity.createdAt)} />
              <Detail label="Updated" value={when(activity.updatedAt)} />
              <Detail label="Ended" value={when(activity.endedAt)} />
            </dl>
          </CardContent>
        </Card>

        <section aria-labelledby="activity-targets-heading">
          <div className="flex items-center gap-3">
            <Smartphone
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 id="activity-targets-heading" className="text-lg font-semibold">
              Target iPhones
            </h2>
          </div>
          <div className="mt-3 space-y-3">
            {bootstrap.targetDevices.length ? (
              bootstrap.targetDevices.map((device) => (
                <Card key={device.id} className="rounded-[14px]">
                  <CardContent className="flex min-h-16 flex-col justify-center gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <strong className="text-sm">{device.name}</strong>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {device.id}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Seen {when(device.lastSeenAt)}
                    </span>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-border p-5 text-sm text-muted-foreground">
                No active target record is available.
              </p>
            )}
          </div>
        </section>

        <Separator />

        <section aria-labelledby="activity-relationships-heading">
          <div className="flex items-center gap-3">
            <GitBranch className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="activity-relationships-heading" className="text-lg font-semibold">
              Activity relationships
            </h2>
          </div>
          <p className="mt-2 max-w-[75ch] text-sm text-muted-foreground">
            Exact, immutable links only. Relo does not infer relationships from similar titles or content.
          </p>
          <div className="mt-3 space-y-3">
            {bootstrap.relationships.length ? (
              bootstrap.relationships.map((relationship) => (
                <a
                  key={relationship.id}
                  href={`/dashboard/testing/runs/${encodeURIComponent(relationship.relatedActivity.id)}/history`}
                  className="status-card grid min-h-20 gap-3 rounded-[14px] border p-4 no-underline sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  data-tone={semanticStatusTone(relationship.relatedActivity.state)}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm capitalize">
                        {words(relationship.kind)} {relationship.direction}
                      </strong>
                      <Badge variant="secondary" className="rounded-full font-mono">
                        Generation {relationship.relatedActivity.generation}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {relationship.relatedActivity.title}
                    </p>
                    <p className="mt-2 text-xs capitalize text-muted-foreground">
                      {words(relationship.reason)} · {relationship.actor} · {words(relationship.provenance)}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {when(relationship.createdAt)}
                  </span>
                </a>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-border p-5 text-sm text-muted-foreground">
                No exact predecessor, successor, supersession, or companion relationship is recorded.
              </p>
            )}
          </div>
        </section>

        <Separator />

        <section aria-labelledby="activity-correlation-heading">
          <div className="flex items-center gap-3">
            <ScanSearch className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="activity-correlation-heading" className="text-lg font-semibold">
              Correlation decisions
            </h2>
          </div>
          <div className="mt-3 space-y-3">
            {bootstrap.correlationDecisions.length ? (
              bootstrap.correlationDecisions.map((decision) => (
                <Card key={decision.id} className="rounded-[14px]">
                  <CardContent className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm capitalize">{words(decision.outcome)}</strong>
                        <Badge variant="outline" className="rounded-full capitalize">
                          matched by {words(decision.matchedBy)}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs capitalize text-muted-foreground">
                        {words(decision.reason)} · {decision.actor} · {words(decision.provenance)}
                      </p>
                    </div>
                    <time className="text-xs text-muted-foreground">
                      {when(decision.createdAt)}
                    </time>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-border p-5 text-sm text-muted-foreground">
                No exact correlation decision is recorded for this activity.
              </p>
            )}
          </div>
        </section>

        <Separator />

        <section aria-labelledby="activity-operations-heading">
          <div className="flex items-center gap-3">
            <Radio
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <h2
              id="activity-operations-heading"
              className="text-lg font-semibold"
            >
              Lifecycle operations
            </h2>
          </div>
          <div className="mt-3 space-y-3">
            {bootstrap.operations.length ? (
              bootstrap.operations.map((operation, index) => (
                <Card
                  key={`${operation.resultingSequence}-${operation.createdAt}-${index}`}
                  className="rounded-[14px]"
                >
                  <CardContent className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="capitalize">
                          {operation.operation}
                        </strong>
                        <Badge
                          variant="secondary"
                          className="rounded-full font-mono"
                        >
                          Sequence {operation.resultingSequence}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {operation.durableCommands} durable commands,{" "}
                        {operation.apnsJobs} APNs jobs
                      </p>
                      {operation.companionActivityId ? (
                        <a
                          className="mt-2 inline-block text-xs break-all text-primary underline-offset-4 hover:underline"
                          href={`/dashboard/testing/runs/${encodeURIComponent(operation.companionActivityId)}/history`}
                        >
                          Companion {operation.companionActivityId}
                        </a>
                      ) : null}
                    </div>
                    <time className="text-xs text-muted-foreground">
                      {when(operation.createdAt)}
                    </time>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-border p-5 text-sm text-muted-foreground">
                No update or end operations are recorded yet.
              </p>
            )}
          </div>
        </section>

        <Separator />

        <section aria-labelledby="activity-events-heading">
          <div className="flex items-center gap-3">
            <BellRing
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 id="activity-events-heading" className="text-lg font-semibold">
              Durable command events
            </h2>
          </div>
          <div className="mt-3 space-y-3">
            {bootstrap.events.length ? (
              bootstrap.events.map((event) => {
                const eventTone = semanticStatusTone(event.state)
                return (
                  <a
                    key={event.id}
                    href={`/dashboard/inbox/notifications/${encodeURIComponent(event.id)}`}
                    className="status-card grid min-h-20 gap-3 rounded-[14px] border p-4 no-underline sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    data-tone={eventTone}
                  >
                    <div className="min-w-0">
                      <strong className="block truncate text-sm">
                        {event.title}
                      </strong>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{event.kind}</span>
                        <span>{event.state}</span>
                      </div>
                    </div>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock3 className="size-4" aria-hidden="true" />
                      {when(event.createdAt)}
                    </span>
                  </a>
                )
              })
            ) : (
              <p className="rounded-[14px] border border-dashed border-border p-5 text-sm text-muted-foreground">
                No durable command events are linked to this activity.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
