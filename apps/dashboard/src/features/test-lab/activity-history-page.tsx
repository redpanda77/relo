import { ArrowLeft } from "lucide-react"

import { Empty, List, Row, Section, Status } from "@/components/list"
import { Fact, FactList } from "@/components/molecules/fact-list"
import { Page } from "@/components/page"
import { Button } from "@/components/ui/button"
import type { ActivityHistory as ActivityHistoryModel } from "@/features/test-lab/activity-history"
import { relativeTime } from "@/lib/format"

function when(value: string | null): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function words(value: string): string {
  return value.replaceAll("_", " ")
}

function historyHref(id: string) {
  return `/dashboard/testing/runs/${encodeURIComponent(id)}/history`
}

export function ActivityHistoryPage({
  bootstrap,
}: {
  bootstrap: ActivityHistoryModel
}) {
  const { activity } = bootstrap

  return (
    <Page
      title={activity.title}
      actions={
        <Button variant="outline" asChild>
          <a href={bootstrap.route.backHref}>
            <ArrowLeft aria-hidden="true" />
            Back to run
          </a>
        </Button>
      }
    >
      <section className="glass rounded-card p-5 sm:p-6" aria-label="Summary">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Status value={activity.state} />
          <span className="text-muted-foreground">{activity.status}</span>
        </div>
        {activity.detail ? (
          <p className="mt-3 max-w-[70ch] text-sm leading-6 text-muted-foreground">
            {activity.detail}
          </p>
        ) : null}
        <FactList columns={4} className="mt-5">
          <Fact label="Requested by">{activity.requesterLabel}</Fact>
          <Fact label="Started">{when(activity.createdAt)}</Fact>
          <Fact label="Last update">{when(activity.updatedAt)}</Fact>
          <Fact label={activity.endedAt ? "Ended" : "Progress"}>
            {activity.endedAt
              ? when(activity.endedAt)
              : activity.progress == null
                ? "—"
                : `${Math.round(activity.progress * 100)}%`}
          </Fact>
        </FactList>
        <details className="mt-5 border-t border-border pt-4">
          <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium text-muted-foreground hover:text-foreground">
            Technical details
          </summary>
          <FactList columns={3} className="mt-3">
            <Fact label="Test ID"><code className="text-xs break-all">{activity.id}</code></Fact>
            <Fact label="Origin key"><code className="text-xs">{activity.key}</code></Fact>
            <Fact label="Live Activity">{`Generation ${activity.generation}`}</Fact>
            <Fact label="Update number">{`Sequence ${activity.sequence}`}</Fact>
            {activity.lifecycle ? (
              <>
                <Fact label="Agent">{`${activity.lifecycle.provider} lifecycle`}</Fact>
                <Fact label="Agent run"><code className="text-xs break-all">{activity.lifecycle.runId}</code></Fact>
              </>
            ) : null}
            <Fact label="Privacy"><span className="capitalize">{activity.privacy}</span></Fact>
            <Fact label="Style"><span className="capitalize">{activity.style}</span></Fact>
          </FactList>
        </details>
      </section>

      <Section title="Updates">
        {bootstrap.operations.length ? (
          <List label="Updates">
            {bootstrap.operations.map((operation, index) => (
              <Row
                key={`${operation.resultingSequence}-${operation.createdAt}-${index}`}
                title={<span className="capitalize">{words(operation.operation)}</span>}
                meta={`Update #${operation.resultingSequence} · ${operation.apnsJobs} ${operation.apnsJobs === 1 ? "push" : "pushes"} to Apple`}
                trailing={<time>{when(operation.createdAt)}</time>}
              >
                {operation.companionActivityId ? (
                  <a
                    className="-mt-2 block px-4 pb-3 text-xs break-all text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    href={historyHref(operation.companionActivityId)}
                  >
                    Companion {operation.companionActivityId}
                  </a>
                ) : null}
              </Row>
            ))}
          </List>
        ) : (
          <Empty title="No updates yet" description="Updates and the final end appear here as they happen." />
        )}
      </Section>

      <Section title="Sent to">
        {bootstrap.targetDevices.length ? (
          <List label="iPhones">
            {bootstrap.targetDevices.map((device) => (
              <Row
                key={device.id}
                title={device.name}
                trailing={
                  device.lastSeenAt
                    ? `Seen ${relativeTime(device.lastSeenAt)}`
                    : "Not seen yet"
                }
              />
            ))}
          </List>
        ) : (
          <Empty title="No iPhone on record" description="This test was not sent to an iPhone Relo knows." />
        )}
      </Section>

      {bootstrap.events.length ? (
        <Section title="Notifications">
          <List label="Notifications">
            {bootstrap.events.map((event) => (
              <Row
                key={event.id}
                href={`/dashboard/inbox/notifications/${encodeURIComponent(event.id)}`}
                title={event.title}
                meta={words(event.kind)}
                trailing={
                  <>
                    <Status value={event.state} />
                    <time className="hidden sm:inline">{when(event.createdAt)}</time>
                  </>
                }
              />
            ))}
          </List>
        </Section>
      ) : null}

      {bootstrap.relationships.length ? (
        <Section title="Related tests">
          <List label="Related tests">
            {bootstrap.relationships.map((relationship) => (
              <Row
                key={relationship.id}
                href={historyHref(relationship.relatedActivity.id)}
                label={`${relationship.relatedActivity.title}, ${words(relationship.kind)} ${relationship.direction}`}
                title={relationship.relatedActivity.title}
                meta={
                  <span className="capitalize">
                    {words(relationship.kind)} {relationship.direction} ·{" "}
                    {words(relationship.reason)}
                  </span>
                }
                trailing={<Status value={relationship.relatedActivity.state} />}
              />
            ))}
          </List>
        </Section>
      ) : null}

      {bootstrap.correlationDecisions.length ? (
        <Section title="How Relo matched this test">
          <List label="Matching decisions">
            {bootstrap.correlationDecisions.map((decision) => (
              <Row
                key={decision.id}
                title={<span className="capitalize">{words(decision.outcome)}</span>}
                meta={
                  <span className="capitalize">
                    Matched by {words(decision.matchedBy)} · {words(decision.reason)}
                  </span>
                }
                trailing={<time>{when(decision.createdAt)}</time>}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </Page>
  )
}
