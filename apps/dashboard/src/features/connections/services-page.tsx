import { Copy, KeyRound, Plus, Save, Webhook } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ConnectionDisclosure,
  ConnectionIconTile,
  ConnectionList,
  ConnectionState,
  ConnectionsPageFrame,
  ConnectionsPager,
  ConnectionsSectionHeader,
  ConfirmationAction,
  DestructiveAction,
  OperationStatus,
} from "@/features/connections/components"
import type {
  ConnectionService,
  ConnectionsServices,
} from "@/features/connections/types"
import { formatConnectionDate } from "@/features/connections/utils"
import { PresentationPolicyControl } from "@/features/presentation-policy/presentation-policy-control"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"
import type {
  ConnectionsService,
  ServiceDefaults,
} from "@/services/connections-service"

function formValues(form: HTMLFormElement): ServiceDefaults {
  const values = new FormData(form)
  const optional = (name: string) => {
    const value = String(values.get(name) ?? "").trim()
    return value || null
  }
  return {
    title: String(values.get("title") ?? "").trim(),
    imageUrl: optional("imageUrl"),
    destinationUrl: optional("destinationUrl"),
  }
}

function ServiceFields({
  service,
  disabled,
}: {
  service?: ConnectionService
  disabled: boolean
}) {
  const suffix = service ? `-${service.id}` : "-new"
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`service-title${suffix}`}>Name</Label>
        <Input
          id={`service-title${suffix}`}
          name="title"
          defaultValue={service?.title}
          maxLength={80}
          placeholder="Service name"
          className="min-h-11"
          disabled={disabled}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`service-image${suffix}`}>Avatar image URL</Label>
        <Input
          id={`service-image${suffix}`}
          name="imageUrl"
          type="url"
          inputMode="url"
          defaultValue={service?.imageUrl ?? ""}
          placeholder="https://…"
          className="min-h-11"
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`service-destination${suffix}`}>Default tap URL</Label>
        <Input
          id={`service-destination${suffix}`}
          name="destinationUrl"
          type="url"
          inputMode="url"
          defaultValue={service?.destinationUrl ?? ""}
          placeholder="https://…"
          className="min-h-11"
          disabled={disabled}
        />
      </div>
    </>
  )
}

function OneTimeSecret({
  value,
  onDismiss,
}: {
  value: string
  onDismiss(): void
}) {
  const fallbackRef = React.useRef<HTMLInputElement>(null)
  const [status, setStatus] = React.useState("")
  const [manualCopy, setManualCopy] = React.useState(false)

  async function copy() {
    setManualCopy(false)
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard API unavailable")
      await navigator.clipboard.writeText(value)
      setStatus("Webhook URL copied.")
      return
    } catch {
      setManualCopy(true)
      setStatus(
        "Automatic clipboard access is unavailable. Select the URL below and copy it now."
      )
      window.requestAnimationFrame(() => fallbackRef.current?.select())
    }
  }

  return (
    <Card role="region" aria-labelledby="service-secret-heading">
      <CardHeader>
        <CardTitle
          id="service-secret-heading"
          className="flex items-center gap-2"
        >
          <KeyRound className="size-4" aria-hidden="true" />
          One-time webhook URL
        </CardTitle>
        <CardDescription>
          This value exists only in this browser session. Copy it before
          dismissing; Relo cannot show it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" className="min-h-11" onClick={copy}>
            <Copy aria-hidden="true" />
            Copy secret URL
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onDismiss}
          >
            Dismiss and clear
          </Button>
        </div>
        {manualCopy ? (
          <div className="space-y-2">
            <Label htmlFor="one-time-service-url">Copy manually</Label>
            <Input
              ref={fallbackRef}
              id="one-time-service-url"
              value={value}
              readOnly
              className="min-h-11 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : null}
        <p
          className="text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {status}
        </p>
      </CardContent>
    </Card>
  )
}

function ServiceRow({
  service,
  api,
  onChange,
  onDelete,
  onSecret,
}: {
  service: ConnectionService
  api: ConnectionsService
  onChange(service: ConnectionService): void
  onDelete(id: string): void
  onSecret(value: string): void
}) {
  const [pending, setPending] = React.useState<
    "save" | "rotate" | "delete" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)

  async function run(
    action: Exclude<typeof pending, null>,
    operation: () => Promise<void>
  ) {
    setPending(action)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.")
    } finally {
      setPending(null)
    }
  }

  return (
    <article
      aria-busy={pending !== null}
      className="border-b border-border last:border-b-0"
    >
      <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3 px-4 py-4 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-center sm:px-5">
        <ConnectionIconTile icon={Webhook} tone="info" />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[15px] font-semibold">
              {service.title}
            </h3>
            <ConnectionState label="Active" tone="success" />
          </div>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <code className="font-mono text-foreground/80">
              {service.prefix}
            </code>
            <span aria-hidden="true">·</span>
            <span>Created {formatConnectionDate(service.createdAt)}</span>
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {service.destinationUrl
              ? `Opens ${service.destinationUrl}`
              : "No default tap destination"}
          </p>
        </div>
        <span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto">
          {service.liveActivityPolicySource === "service"
            ? "Custom presentation"
            : "Inherited presentation"}
        </span>
      </div>
      <ConnectionDisclosure label="Configure service">
        <div className="space-y-5">
          <form
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] lg:items-end"
            onSubmit={(event) => {
              event.preventDefault()
              const input = formValues(event.currentTarget)
              void run("save", async () => {
                const result = await api.editService(service.id, input)
                onChange({
                  ...service,
                  ...result.service,
                  imageUrl: result.service.imageUrl ?? null,
                  destinationUrl: result.service.destinationUrl ?? null,
                })
              })
            }}
          >
            <ServiceFields service={service} disabled={pending !== null} />
            <Button
              type="submit"
              variant="outline"
              className="min-h-11"
              disabled={pending !== null}
            >
              <Save aria-hidden="true" />
              {pending === "save" ? "Saving…" : "Save defaults"}
            </Button>
          </form>
          <PresentationPolicyControl
            scopeLabel={service.title}
            initialPolicy={service.effectiveLiveActivityPolicy}
            initialSource={service.liveActivityPolicySource}
            canInherit
            onSave={(policy) =>
              api.saveServiceLiveActivityPolicy(service.id, policy)
            }
            onReset={() => api.resetServiceLiveActivityPolicy(service.id)}
          />
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <OperationStatus
              pending={pending !== null}
              error={error}
              pendingLabel={
                pending === "rotate"
                  ? "Rotating secret URL…"
                  : pending === "delete"
                    ? "Deleting service…"
                    : "Saving service defaults…"
              }
            />
            <div className="ml-auto flex flex-col gap-2 sm:flex-row">
              <ConfirmationAction
                label="Rotate URL"
                title={`Rotate the secret URL for ${service.title}?`}
                description="The previous webhook URL will stop working immediately. Copy the replacement before dismissing it."
                pending={pending !== null}
                variant="outline"
                onConfirm={() =>
                  void run("rotate", async () => {
                    const result = await api.rotateService(service.id)
                    onChange({ ...service, prefix: result.service.prefix })
                    onSecret(result.webhookUrl)
                  })
                }
              />
              <DestructiveAction
                label="Delete"
                title={`Delete ${service.title}?`}
                description="The webhook service and its current secret URL will stop working. This cannot be undone."
                pending={pending !== null}
                onConfirm={() =>
                  void run("delete", async () => {
                    await api.deleteService(service.id)
                    onDelete(service.id)
                  })
                }
              />
            </div>
          </div>
        </div>
      </ConnectionDisclosure>
    </article>
  )
}

export function ServicesPage({
  initial,
  api,
}: {
  initial: ConnectionsServices
  api: ConnectionsService
}) {
  const [services, setServices] = React.useState(initial.services)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  return (
    <ConnectionsPageFrame bootstrap={initial}>
      <section className="mt-7 space-y-5" aria-labelledby="services-heading">
        <ConnectionsSectionHeader
          id="services-heading"
          title="Webhook services"
          description="Named senders, tap destinations, and Live Activity presentation. Secret URLs are shown only when created or rotated."
        />

        {secret ? (
          <OneTimeSecret value={secret} onDismiss={() => setSecret(null)} />
        ) : null}

        <details className="group/create overflow-hidden rounded-xl bg-card/80 ring-1 ring-foreground/10">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 outline-none hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-3">
              <ConnectionIconTile icon={Plus} tone="info" />
              <span>
                <strong className="block text-sm font-medium">
                  Create service
                </strong>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Issue a new one-time webhook URL
                </span>
              </span>
            </span>
            <span className="text-xs font-medium text-primary group-open/create:hidden">
              Open
            </span>
            <span className="hidden text-xs font-medium text-muted-foreground group-open/create:block">
              Close
            </span>
          </summary>
          <div className="border-t border-border bg-background/25 px-4 py-5 sm:px-5">
            <form
              aria-busy={pending}
              className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] lg:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                const form = event.currentTarget
                const input = formValues(form)
                setPending(true)
                setError(null)
                void api
                  .createService(input)
                  .then((result) => {
                    setServices((current) => [
                      {
                        id: result.service.id,
                        title: result.service.title,
                        prefix: result.service.prefix,
                        imageUrl: result.service.imageUrl ?? input.imageUrl,
                        destinationUrl:
                          result.service.destinationUrl ?? input.destinationUrl,
                        liveActivityPolicy:
                          result.service.liveActivityPolicy ?? null,
                        effectiveLiveActivityPolicy:
                          result.service.effectiveLiveActivityPolicy ??
                          services[0]?.effectiveLiveActivityPolicy ??
                          systemPresentationPolicy,
                        liveActivityPolicySource:
                          result.service.liveActivityPolicySource ??
                          services[0]?.liveActivityPolicySource ??
                          "system",
                        createdAt: new Date().toISOString(),
                      },
                      ...current,
                    ])
                    setSecret(result.webhookUrl)
                    form.reset()
                  })
                  .catch((cause) =>
                    setError(
                      cause instanceof Error ? cause.message : "Request failed."
                    )
                  )
                  .finally(() => setPending(false))
              }}
            >
              <ServiceFields disabled={pending} />
              <Button type="submit" className="min-h-11" disabled={pending}>
                <Webhook aria-hidden="true" />
                {pending ? "Creating…" : "Create service"}
              </Button>
            </form>
            <div className="mt-3">
              <OperationStatus
                pending={pending}
                error={error}
                pendingLabel="Creating service and issuing its secret URL…"
              />
            </div>
          </div>
        </details>

        {services.length ? (
          <ConnectionList ariaLabel="Webhook services">
            {services.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                api={api}
                onChange={(next) =>
                  setServices((current) =>
                    current.map((item) => (item.id === next.id ? next : item))
                  )
                }
                onDelete={(id) =>
                  setServices((current) =>
                    current.filter((item) => item.id !== id)
                  )
                }
                onSecret={setSecret}
              />
            ))}
          </ConnectionList>
        ) : (
          <Card>
            <CardContent className="flex min-h-32 flex-col items-center justify-center text-center">
              <Webhook
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 font-medium">No webhook services yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a named service to receive a one-time secret URL.
              </p>
            </CardContent>
          </Card>
        )}
        <ConnectionsPager pagination={initial.pagination} />
      </section>
    </ConnectionsPageFrame>
  )
}
