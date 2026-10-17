import { Plus, Save, Webhook } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AnimatedHeight } from "@/components/atoms/animated-height"
import { IconTile } from "@/components/atoms/icon-tile"
import { ActionButton } from "@/components/molecules/action-button"
import { OneTimeSecretPanel, type OneTimeSecret } from "@/components/molecules/one-time-secret-panel"
import { Empty, List, Section } from "@/components/list"
import {
  ConfirmationAction,
  DestructiveAction,
} from "@/components/molecules/confirmation-action"
import { OperationStatus } from "@/components/molecules/operation-status"
import { DisclosureRow } from "@/features/connections/components"
import type { ConnectionService } from "@/features/connections/types"
import { ReadableChip, ServiceAccessControl } from "@/features/connections/service-access"
import { SERVICE_SCOPES } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"
import { ColorAppearance } from "@/features/presentation-policy/color-appearance"
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
         
          disabled={disabled}
        />
      </div>
    </>
  )
}

/** What a service sends with: the endpoint (not secret) and the secret, which goes in a header and is shown once. */
type IssuedCredential = { endpoint: string; secret: string }

function serviceSecret(value: IssuedCredential): OneTimeSecret {
  return {
    title: "One-time service secret",
    hint: (
      <>
        Your service sends to the endpoint with this secret in a header:{" "}
        <code className="font-mono text-xs">Authorization: Bearer hook_…</code>.
      </>
    ),
    fields: [
      { label: "Endpoint", value: value.endpoint },
      { label: "Secret", value: value.secret, secret: true },
    ],
  }
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
  onSecret(value: IssuedCredential): void
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

  const lastUsed = service.lastUsedAt ? `Last used ${relativeTime(service.lastUsedAt)}` : "Never used"
  return (
    <DisclosureRow
      busy={pending !== null}
      leading={<IconTile icon={Webhook} />}
      title={service.title}
      meta={service.destinationUrl ? `${lastUsed} · Opens ${service.destinationUrl}` : lastUsed}
      badge={service.readableAllowed ? <ReadableChip /> : null}
    >
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
            <ActionButton
              type="submit"
              variant="outline"
              disabled={pending !== null}
              pending={pending === "save"}
              failed={Boolean(error)}
              pendingLabel="Saving…"
              successLabel="Saved"
            >
              <Save aria-hidden="true" />
              Save defaults
            </ActionButton>
          </form>
          <ServiceAccessControl
            service={service}
            onSave={async (change) => {
              const result = await api.editService(service.id, {
                title: service.title,
                imageUrl: service.imageUrl,
                destinationUrl: service.destinationUrl,
                ...change,
              })
              onChange({
                ...service,
                readableAllowed: result.service.readableAllowed,
                scopes: result.service.scopes,
              })
            }}
          />
          <ColorAppearance
            icon="cloud"
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
                  ? "Rotating the secret…"
                  : pending === "delete"
                    ? "Deleting service…"
                    : "Saving service defaults…"
              }
            />
            <div className="ml-auto flex flex-col gap-2 sm:flex-row">
              <ConfirmationAction
                label="Rotate secret"
                title={`Rotate the secret for ${service.title}?`}
                description="The previous secret stops working immediately. Copy the new one before dismissing it."
                pending={pending === "rotate"}
                disabled={pending !== null}
                failed={Boolean(error)}
                pendingLabel="Rotating…"
                successLabel="Rotated"
                variant="outline"
                onConfirm={() =>
                  void run("rotate", async () => {
                    const result = await api.rotateService(service.id)
                    onChange({ ...service, prefix: result.service.prefix })
                    onSecret({ endpoint: result.endpoint, secret: result.secret })
                  })
                }
              />
              <DestructiveAction
                label="Delete"
                title={`Delete ${service.title}?`}
                description="The webhook service and its current secret stop working. This cannot be undone."
                pending={pending === "delete"}
                disabled={pending !== null}
                failed={Boolean(error)}
                pendingLabel="Deleting…"
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
    </DisclosureRow>
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
  const [secret, setSecret] = React.useState<IssuedCredential | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  return (
    <Section
      id="webhooks"
      title="Webhooks"
      count={services.length || undefined}
      action={
        <Button size="sm" variant="secondary" onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" /> New webhook
        </Button>
      }
    >
      <div className="space-y-4">
        <OneTimeSecretPanel value={secret ? serviceSecret(secret) : null} onDismiss={() => setSecret(null)} />
        <AnimatedHeight show={creating}>
          <div className="glass rounded-card p-4 sm:p-5">
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
                        readableAllowed: result.service.readableAllowed ?? false,
                        scopes: result.service.scopes ?? [...SERVICE_SCOPES],
                        lastUsedAt: null,
                        createdAt: new Date().toISOString(),
                      },
                      ...current,
                    ])
                    setSecret({ endpoint: result.endpoint, secret: result.secret })
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
              <ActionButton type="submit" pending={pending} failed={Boolean(error)} pendingLabel="Creating…" successLabel={null}>
                <Webhook aria-hidden="true" />
                Create webhook
              </ActionButton>
            </form>
            <div className="mt-3">
              <OperationStatus
                pending={pending}
                error={error}
                pendingLabel="Creating the service and issuing its secret…"
              />
            </div>
          </div>
        </AnimatedHeight>

        <List
          label="Webhooks"
          items={services}
          getKey={(service) => service.id}
          empty={creating ? null : <Empty icon={<Webhook />} title="No webhooks yet" description="Create one to let a service send notifications, questions and cards with its own secret." />}
        >
          {(service) => (
            <ServiceRow
              service={service}
              api={api}
              onChange={(next) => setServices((current) => current.map((item) => (item.id === next.id ? next : item)))}
              onDelete={(id) => setServices((current) => current.filter((item) => item.id !== id))}
              onSecret={setSecret}
            />
          )}
        </List>
      </div>
      {total > initial.length ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing {initial.length} of {total}.</p>
      ) : null}
    </Section>
  )
}
