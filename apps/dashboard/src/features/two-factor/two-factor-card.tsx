import { useEffect, useState } from "react"
import { KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { QrCode } from "@/features/linked-browser/qr-code"
import {
  createHttpTwoFactorService,
  type TwoFactorService,
  type TwoFactorSetup,
} from "@/features/two-factor/two-factor-service"

const httpService = createHttpTwoFactorService()

type Step =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "password"; action: "enable" | "disable" | "codes" }
  | { kind: "scan"; setup: TwoFactorSetup }
  | { kind: "on"; backupCodes?: string[] }

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Backup codes</p>
      <p className="text-sm text-muted-foreground">
        Save these somewhere safe. Each one signs you in once if you lose your phone. They are shown only now.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-3 font-mono text-sm" aria-label="Backup codes">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
    </div>
  )
}

/** Account → Security: two-step sign-in with an authenticator app (docs/HARDENING.md, gap 1). */
export function TwoFactorCard({ service = httpService }: { service?: TwoFactorService }) {
  const [step, setStep] = useState<Step>({ kind: "loading" })
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    service.status().then(
      (enabled) => { if (!active) return; if (enabled === null) setHidden(true); else setStep({ kind: enabled ? "on" : "off" }) },
      () => { if (active) setHidden(true) },
    )
    return () => { active = false }
  }, [service])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError("")
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong.") } finally { setBusy(false) }
  }

  function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step.kind !== "password") return
    const password = String(new FormData(event.currentTarget).get("password") ?? "")
    const action = step.action
    void run(async () => {
      if (action === "enable") setStep({ kind: "scan", setup: await service.begin(password) })
      if (action === "disable") { await service.disable(password); setStep({ kind: "off" }) }
      if (action === "codes") setStep({ kind: "on", backupCodes: await service.newBackupCodes(password) })
    })
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step.kind !== "scan") return
    const code = String(new FormData(event.currentTarget).get("code") ?? "")
    const codes = step.setup.backupCodes
    void run(async () => { await service.confirm(code); setStep({ kind: "on", backupCodes: codes }) })
  }

  if (hidden) return null
  const secret = step.kind === "scan" ? new URL(step.setup.totpURI).searchParams.get("secret") ?? "" : ""
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden="true" />Two-step sign-in</CardTitle>
        <CardDescription>
          {step.kind === "on"
            ? "On: signing in here needs your password and a code from your authenticator app."
            : "Ask for a code from an authenticator app after your password, so a leaked password is not enough. Recommended when this server is reachable from the internet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {step.kind === "off" ? (
          <Button className="w-fit" onClick={() => setStep({ kind: "password", action: "enable" })}>Turn on</Button>
        ) : null}
        {step.kind === "on" ? (
          <>
            {step.backupCodes ? <BackupCodes codes={step.backupCodes} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setStep({ kind: "password", action: "codes" })}>New backup codes</Button>
              <Button variant="outline" onClick={() => setStep({ kind: "password", action: "disable" })}>Turn off</Button>
            </div>
          </>
        ) : null}
        {step.kind === "password" ? (
          <form className="grid gap-3" onSubmit={submitPassword}>
            <div className="grid gap-2">
              <Label htmlFor="two-factor-password">Your password</Label>
              <Input id="two-factor-password" name="password" type="password" autoComplete="current-password" required autoFocus className="min-h-11" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy} variant={step.action === "disable" ? "destructive" : "default"}>
                {step.action === "enable" ? "Continue" : step.action === "disable" ? "Turn off two-step sign-in" : "Show new codes"}
              </Button>
              <Button type="button" variant="ghost" disabled={busy}
                onClick={() => setStep({ kind: step.action === "enable" ? "off" : "on" })}>Cancel</Button>
            </div>
          </form>
        ) : null}
        {step.kind === "scan" ? (
          <form className="grid gap-4" onSubmit={submitCode}>
            <p className="text-sm text-muted-foreground">
              Scan this with an authenticator app (for example the Passwords app on iPhone), then enter the code it shows.
            </p>
            <QrCode value={step.setup.totpURI} label="Authenticator setup code" className="bg-white p-2" />
            <p className="text-xs text-muted-foreground">
              Or enter this key by hand: <span className="font-mono break-all text-foreground">{secret}</span>
            </p>
            <div className="grid gap-2">
              <Label htmlFor="two-factor-code">Code from the app</Label>
              <Input id="two-factor-code" name="code" inputMode="numeric" autoComplete="one-time-code" required className="min-h-11" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>Turn on</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep({ kind: "off" })}>Cancel</Button>
            </div>
          </form>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
