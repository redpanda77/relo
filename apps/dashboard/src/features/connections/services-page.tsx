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
import { Empty, Section } from "@/components/page"
import {
  ConnectionDisclosure,
  ConnectionList,
  ConfirmationAction,
  DestructiveAction,
  OperationStatus,
} from "@/features/connections/components"
import type { ConnectionService } from "@/features/connections/types"
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
    <li aria-busy={pending !== null}>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
        <Webhook className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{service.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {service.destinationUrl ? `Opens ${service.destinationUrl}` : `Created ${formatConnectionDate(service.createdAt)}`}
          </p>
        </div>
      </div>
      <ConnectionDisclosure label="Manage">
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
    </li>
  )
}

export function WebhooksSection({
  initial,
  total,
  api,
}: {
  total: number
  initial: ConnectionService[]
  api: ConnectionsService
}) {
  const [services, setServices] = React.useState(initial)
  const [creating, setCreating] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  return (
    <Section
      title="Webhooks"
      action={
        <Button size="sm" variant="secondary" onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" /> New webhook
        </Button>
      }
    >
      <div className="space-y-4">
        {secret ? (
          <OneTimeSecret value={secret} onDismiss={() => setSecret(null)} />
        ) : null}
        {creating ? (
          <div className="glass rounded-2xl p-4 sm:p-5">
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
                    setCreating(false)
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
                {pending ? "Creating…" : "Create webhook"}
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
        ) : null}

        {services.length ? (
          <ConnectionList ariaLabel="Webhooks">
            {services.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                api={api}
                onChange={(next) => setServices((current) => current.map((item) => (item.id === next.id ? next : item)))}
                onDelete={(id) => setServices((current) => current.filter((item) => item.id !== id))}
                onSecret={setSecret}
              />
            ))}
          </ConnectionList>
        ) : creating ? null : (
          <Empty title="No webhooks yet" description="Create one to let a service send notifications with a secret URL." />
        )}
      </div>
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
