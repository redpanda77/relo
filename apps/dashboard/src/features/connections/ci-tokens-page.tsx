import { KeySquare, Plus, Trash2 } from "lucide-react"
import * as React from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"
import { IconTile } from "@/components/atoms/icon-tile"
import { Badge } from "@/components/card"
import { Empty, List, Row, Section } from "@/components/list"
import { ActionButton } from "@/components/molecules/action-button"
import { DestructiveAction } from "@/components/molecules/confirmation-action"
import { OneTimeSecretPanel, type OneTimeSecret } from "@/components/molecules/one-time-secret-panel"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  LOGIN_SCOPE_COPY,
  ciTokenError,
  compactScopes,
  expiry,
  type CiToken,
} from "@/features/connections/ci-tokens"
import {
  CI_TOKEN_DEFAULT_DAYS,
  CI_TOKEN_EXPIRY_CHOICES,
  LOGIN_SCOPES,
  type LoginScope,
} from "@/features/connections/types"
import { relativeTime } from "@/lib/format"
import type { ConnectionsService, IssuedCiToken } from "@/services/connections-service"

function CiTokenRow({
  token,
  api,
  onRevoke,
}: {
  token: CiToken
  api: ConnectionsService
  onRevoke(id: string): void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ends = expiry(token.expiresAt)
  return (
    <Row
      busy={pending}
      wrap
      leading={<IconTile icon={KeySquare} />}
      title={token.name}
      meta={
        <>
          {compactScopes(token.scopes)} · {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}
        </>
      }
      status={
        <Badge tone={ends.tone} variant="hairline" icon={null}>
          {ends.text}
        </Badge>
      }
      actions={
        <DestructiveAction
          label="Revoke"
          title={`Revoke ${token.name}?`}
          description="Pipelines using this token stop reaching Relo at once. Make a new CI token to connect them again."
          pending={pending}
          failed={Boolean(error)}
          pendingLabel="Revoking…"
          size="sm"
          icon={<Trash2 aria-hidden="true" />}
          compact
          onConfirm={() => {
            setPending(true)
            setError(null)
            void api
              .revokeCiToken(token.id)
              .then(() => onRevoke(token.id))
              .catch(() => setError("Relo could not revoke this token. Check your connection and try again."))
              .finally(() => setPending(false))
          }}
        />
      }
    >
      <OperationStatus pending={pending} error={error} pendingLabel="Revoking…" className="px-4 pb-3 text-xs" />
    </Row>
  )
}

function NewCiTokenForm({
  api,
  onCreated,
}: {
  api: ConnectionsService
  onCreated(issued: IssuedCiToken): void
}) {
  const [scopes, setScopes] = React.useState<LoginScope[]>([...LOGIN_SCOPES])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const nameRef = React.useRef<HTMLInputElement>(null)
  const id = React.useId()

  function toggle(scope: LoginScope, checked: boolean) {
    setScopes((current) =>
      checked ? LOGIN_SCOPES.filter((item) => item === scope || current.includes(item)) : current.filter((item) => item !== scope)
    )
  }

  return (
    <form
      aria-busy={pending || undefined}
      aria-label="New CI token"
      className="glass space-y-4 rounded-card p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const values = new FormData(form)
        const name = String(values.get("name") ?? "").trim()
        const expiresInDays = Number(values.get("expiresInDays") ?? CI_TOKEN_DEFAULT_DAYS)
        if (!name) {
          setError("Give the token a name, such as the pipeline that holds it.")
          nameRef.current?.focus()
          return
        }
        setPending(true)
        setError(null)
        void api
          .createCiToken({
            name,
            // Every permission is the server's default; send a list only when the owner narrowed it.
            ...(scopes.length === LOGIN_SCOPES.length ? {} : { scopes }),
            expiresInDays,
          })
          .then((issued) => {
            onCreated(issued)
            form.reset()
            setScopes([...LOGIN_SCOPES])
          })
          .catch((cause) => {
            setError(ciTokenError(cause))
            if (cause instanceof Error && cause.message === "name_taken") nameRef.current?.focus()
          })
          .finally(() => setPending(false))
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            ref={nameRef}
            id={`${id}-name`}
            name="name"
            maxLength={80}
            placeholder="Deploy pipeline"
            autoComplete="off"
            disabled={pending}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-expiry`}>Expires after</Label>
          <NativeSelect id={`${id}-expiry`} name="expiresInDays" defaultValue={String(CI_TOKEN_DEFAULT_DAYS)} disabled={pending}>
            {CI_TOKEN_EXPIRY_CHOICES.map((days) => (
              <NativeSelectOption key={days} value={String(days)}>
                {days} days
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      <fieldset className="min-w-0" disabled={pending} aria-describedby={`${id}-scopes-hint`}>
        <legend className="text-sm font-medium text-foreground">What it may do</legend>
        <p id={`${id}-scopes-hint`} className="mt-0.5 text-xs text-muted-foreground">
          A CI token holds at most your login's scopes. Give it only what the pipeline needs.
        </p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {LOGIN_SCOPES.map((scope) => {
            const checked = scopes.includes(scope)
            const last = checked && scopes.length === 1
            const copy = LOGIN_SCOPE_COPY[scope]
            return (
              <label
                key={scope}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent"
              >
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                  checked={checked}
                  disabled={last}
                  aria-describedby={last ? `${id}-last` : `${id}-${scope}-detail`}
                  onChange={(event) => toggle(scope, event.currentTarget.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{copy.label}</span>
                  <span id={`${id}-${scope}-detail`} className="block text-xs text-muted-foreground">
                    {copy.detail}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        {scopes.length === 1 ? (
          <p id={`${id}-last`} className="mt-2 px-2 text-xs text-muted-foreground">
            A CI token holds at least one permission.
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <OperationStatus pending={pending} error={error} pendingLabel="Making the CI token…" />
        <ActionButton
          type="submit"
          className="sm:ml-auto"
          pending={pending}
          failed={Boolean(error)}
          pendingLabel="Creating…"
          successLabel={null}
        >
          <KeySquare aria-hidden="true" />
          Create CI token
        </ActionButton>
      </div>
    </form>
  )
}

/** CI tokens: logins the owner makes for a pipeline, without a browser sign-in. */
export function CiTokensSection({
  initial,
  api,
}: {
  initial: CiToken[]
  api: ConnectionsService
}) {
  const [tokens, setTokens] = React.useState(initial)
  const [creating, setCreating] = React.useState(false)
  const [secret, setSecret] = React.useState<OneTimeSecret | null>(null)

  return (
    <Section
      id="ci-tokens"
      title="CI tokens"
      count={tokens.length || undefined}
      description={
        <>
          A CI token holds at most your login's scopes, always expires and cannot make another; set it as{" "}
          <code className="font-mono text-xs">RELO_TOKEN</code> in the pipeline.
        </>
      }
      action={
        <Button size="sm" variant="secondary" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" /> New CI token
        </Button>
      }
    >
      <div className="space-y-4">
        <OneTimeSecretPanel value={secret} onDismiss={() => setSecret(null)} />
        <AnimatedHeight show={creating}>
          <NewCiTokenForm
            api={api}
            onCreated={(issued) => {
              const { credential } = issued
              setTokens((current) => [
                {
                  id: credential.id,
                  name: credential.name,
                  prefix: credential.prefix,
                  scopes: credential.scopes,
                  createdAt: credential.createdAt,
                  expiresAt: credential.expiresAt,
                  lastUsedAt: credential.lastUsedAt,
                },
                ...current.filter((token) => token.id !== credential.id),
              ])
              setSecret({
                title: `One-time CI token for ${credential.name}`,
                hint: (
                  <>
                    Set it as <code className="font-mono text-xs">RELO_TOKEN</code> in your pipeline's secret store,
                    with <code className="font-mono text-xs">RELO_API_URL</code> pointing at this server.
                  </>
                ),
                fields: [{ label: "Token", value: issued.token, secret: true }],
              })
              setCreating(false)
            }}
          />
        </AnimatedHeight>
        <List
          label="CI tokens"
          items={tokens}
          getKey={(token) => token.id}
          empty={
            creating ? null : (
              <Empty
                icon={<KeySquare />}
                title="No CI tokens yet"
                description="Make one for a pipeline or container that cannot sign in with a browser."
              />
            )
          }
        >
          {(token) => (
            <CiTokenRow
              token={token}
              api={api}
              onRevoke={(id) => setTokens((current) => current.filter((item) => item.id !== id))}
            />
          )}
        </List>
      </div>
    </Section>
  )
}
