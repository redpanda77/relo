import { useEffect, useId, useState } from "react"
import { Lock } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { IconTile } from "@/components/atoms/icon-tile"
import { CrossfadeText } from "@/components/atoms/animated-height"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  createHttpEncryptionPolicyService,
  type EncryptionMode,
  type EncryptionPolicy,
  type EncryptionPolicyService,
} from "@/features/encryption-policy/encryption-policy-service"

const httpService = createHttpEncryptionPolicyService()

const labels: Record<EncryptionMode, string> = {
  auto: "Automatic (recommended)",
  on: "Always",
  off: "Off",
}

function summary(policy: EncryptionPolicy): string {
  if (policy.mode === "off") return "Off: computers may send readable text the server can see."
  if (policy.mode === "on") return "On: computers must seal text so only your phone and linked browsers can read it."
  return policy.required
    ? "On, because your iPhone has published its encryption keys: computers must seal text."
    : "Turns on as soon as your iPhone publishes its encryption keys."
}

/**
 * Account → Security: whether CLI keys must seal text (docs/ENCRYPTION-PROTOCOL.md, E6.1). Only the
 * owner signed in here can turn it off; a CLI key can only make it stricter (HARDENING gap 5).
 */
export function EncryptionPolicyCard({ service = httpService }: { service?: EncryptionPolicyService }) {
  const selectId = useId()
  const [policy, setPolicy] = useState<EncryptionPolicy | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [confirmOff, setConfirmOff] = useState(false)

  useEffect(() => {
    let active = true
    service.load().then(
      (loaded) => { if (active) { if (loaded) setPolicy(loaded); else setUnavailable(true) } },
      // Not loaded (offline, or a server without it): the card stays out of the way.
      () => { if (active) setUnavailable(true) },
    )
    return () => { active = false }
  }, [service])

  async function save(mode: EncryptionMode) {
    setSaving(true)
    setError("")
    try {
      setPolicy(await service.save(mode))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the encryption setting.")
    } finally {
      setSaving(false)
    }
  }

  if (unavailable) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5"><IconTile icon={Lock} tone="violet" />End-to-end encryption</CardTitle>
        <CardAction>
          <label htmlFor={selectId} className="sr-only">Require encryption</label>
          <NativeSelect
            id={selectId}
            value={policy?.mode ?? "auto"}
            disabled={!policy || saving}
            onChange={(event) => {
              const mode = event.currentTarget.value as EncryptionMode
              if (mode === "off") setConfirmOff(true)
              else void save(mode)
            }}
          >
            {(Object.keys(labels) as EncryptionMode[]).map((mode) => (
              <NativeSelectOption key={mode} value={mode}>{labels[mode]}</NativeSelectOption>
            ))}
          </NativeSelect>
        </CardAction>
        <CardDescription>
          Require computers to seal notices, questions and cards so the Relo server cannot read them.
        </CardDescription>
      </CardHeader>
      {policy || error ? (
      <CardContent className="grid gap-3">
        {policy ? (
          <p className="text-sm text-muted-foreground" role="status">
            <CrossfadeText>{summary(policy)}</CrossfadeText>
          </p>
        ) : null}
        <OperationStatus error={error || null} />
      </CardContent>
      ) : null}
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off end-to-end encryption?</AlertDialogTitle>
            <AlertDialogDescription>
              Computers will be allowed to send readable text, which the server and anyone who controls it can read.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { setConfirmOff(false); void save("off") }}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
