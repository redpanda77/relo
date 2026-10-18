import { KeyRound } from "lucide-react"
import * as React from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"
import { CopyButton } from "@/components/molecules/copy-button"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * One value the owner copies now. A `secret` field is never painted: it is a copy button, and only
 * when the clipboard refuses does it appear (blurring in) for a manual copy. Other fields (an
 * endpoint) show in a read-only field with their own copy button.
 */
export type OneTimeSecretField = { label: string; value: string; secret?: boolean }

export type OneTimeSecret = {
  title: string
  /** What to do with it; the panel adds that Relo cannot show it again. */
  hint: React.ReactNode
  fields: OneTimeSecretField[]
}

function SecretCard({ value, onDismiss }: { value: OneTimeSecret; onDismiss(): void }) {
  const id = React.useId()
  const fallbackRef = React.useRef<HTMLInputElement>(null)
  const [status, setStatus] = React.useState("")
  const [manual, setManual] = React.useState<string | null>(null)
  const secrets = value.fields.filter((field) => field.secret)
  const plain = value.fields.filter((field) => !field.secret)
  const manualField = secrets.find((field) => field.label === manual)

  function fallback(field: OneTimeSecretField) {
    setManual(field.label)
    setStatus(
      `Automatic clipboard access is unavailable. Select the ${field.label.toLowerCase()} below and copy it now.`
    )
    window.requestAnimationFrame(() => fallbackRef.current?.select())
  }

  return (
    <Card role="region" aria-labelledby={`${id}-heading`}>
      <CardHeader>
        <CardTitle id={`${id}-heading`} className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          {value.title}
        </CardTitle>
        <CardDescription>
          {value.hint} It exists only in this browser session; copy it before dismissing, Relo cannot show it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plain.map((field, index) => (
          <div key={field.label} className="space-y-1">
            <Label htmlFor={`${id}-field-${index}`}>{field.label}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={`${id}-field-${index}`}
                value={field.value}
                readOnly
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyButton value={field.value} label={`Copy ${field.label.toLowerCase()}`} variant="outline" />
            </div>
          </div>
        ))}
        {manualField ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-manual`}>Copy manually</Label>
            <Input
              ref={fallbackRef}
              id={`${id}-manual`}
              value={manualField.value}
              readOnly
              className="secret-reveal font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : null}
      </CardContent>
      <CardFooter
        meta={
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {status}
          </p>
        }
        actions={
          <>
            {secrets.map((field) => (
              <CopyButton
                key={field.label}
                value={field.value}
                label={`Copy ${field.label.toLowerCase()}`}
                variant="default"
                announce={false}
                onCopied={() => {
                  setManual(null)
                  setStatus(`${field.label} copied.`)
                }}
                onFailed={() => fallback(field)}
              />
            ))}
            <Button type="button" variant="outline" onClick={onDismiss}>
              Dismiss and clear
            </Button>
          </>
        }
      />
    </Card>
  )
}

/**
 * A secret shown once (a webhook's secret, a CI token): it opens in place when issued and collapses
 * on dismiss (AnimatedHeight), and a new secret replaces the old one's state entirely.
 */
export function OneTimeSecretPanel({ value, onDismiss }: { value: OneTimeSecret | null; onDismiss(): void }) {
  const key = value?.fields.map((field) => field.value).join("\u0000")
  return (
    <AnimatedHeight show={Boolean(value)}>
      {value ? <SecretCard key={key} value={value} onDismiss={onDismiss} /> : null}
    </AnimatedHeight>
  )
}
