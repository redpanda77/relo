import { Activity, LockKeyhole, MessageSquareReply } from "lucide-react"
import * as React from "react"

import { BrandLockup } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authenticateOwner, verifySecondStep } from "@/features/auth/auth-service"
import type { DashboardAuth } from "@/features/auth/types"

function friendlyAuthError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.toLowerCase() : ""
  if (raw.includes("invalid") && (raw.includes("password") || raw.includes("credential") || raw.includes("email")))
    return "That email and password don't match."
  if (raw.includes("owner not bootstrapped")) return "This server isn't ready for its first account yet."
  if (raw.includes("approval pending")) return "Your account is waiting for the server admin's approval."
  if (raw.includes("account disabled")) return "The server admin has turned off access for this account."
  if (raw.includes("registration closed")) return "This server isn't taking new accounts. Ask its admin to create one for you."
  if (raw.includes("already exists") || raw.includes("user exists")) return "An account with that email already exists."
  if (raw.includes("rate") || raw.includes("too many")) return "Too many attempts. Wait a minute and try again."
  return "Couldn't sign in. Check your connection and try again."
}

// The living deck is decoration here; the form never waits for its code.
const NowHud = React.lazy(() =>
  import("@/components/organisms/now-hud").then((module) => ({ default: module.NowHud }))
)

const promises = [
  { icon: Activity, text: "Live progress on your iPhone's Lock Screen and Dynamic Island." },
  { icon: MessageSquareReply, text: "Approve, decline or answer your agents from the phone." },
  { icon: LockKeyhole, text: "End-to-end encrypted, on a server you run." },
] as const

function serverHost(): string {
  return typeof window === "undefined" ? "" : window.location.host
}

export function AuthPage({
  bootstrap,
  onAuthenticated = (path) => window.location.assign(path),
}: {
  bootstrap: DashboardAuth
  onAuthenticated?: (path: string) => void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState("")
  const [mode, setMode] = React.useState(bootstrap.mode)
  const [awaitingApproval, setAwaitingApproval] = React.useState(false)
  const [secondStep, setSecondStep] = React.useState<null | "totp" | "backup">(null)
  // The first account claims the server; afterwards registration follows the admin's setting.
  const claimed = bootstrap.mode === "sign-in"
  const canRegister = claimed && bootstrap.registration !== "closed"
  const title = !claimed || mode === "sign-in" ? bootstrap.title : "Create your account"
  const description = !claimed || mode === "sign-in"
    ? bootstrap.description
    : bootstrap.registration === "approval"
      ? "The server admin approves new accounts before they can sign in. Your data stays private to you."
      : "Your account and everything in it are private to you."

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    setPending(true)
    setError("")
    try {
      const outcome = await authenticateOwner(mode, {
        name:
          mode === "sign-up"
            ? String(values.get("name") ?? "")
            : undefined,
        email: String(values.get("email") ?? ""),
        password: String(values.get("password") ?? ""),
      })
      if (outcome === "pending") {
        setAwaitingApproval(true)
        setPending(false)
        return
      }
      if (outcome === "two-factor") {
        setSecondStep("totp")
        setPending(false)
        return
      }
      onAuthenticated(bootstrap.route.nextPath)
    } catch (cause) {
      setError(friendlyAuthError(cause))
      setPending(false)
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!secondStep) return
    const values = new FormData(event.currentTarget)
    setPending(true)
    setError("")
    try {
      await verifySecondStep({
        code: String(values.get("code") ?? ""),
        method: secondStep,
        trustDevice: values.get("trustDevice") === "on",
      })
      onAuthenticated(bootstrap.route.nextPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That code did not work.")
      setPending(false)
    }
  }

  const signingIn = mode === "sign-in"
  function switchMode() {
    setMode(signingIn ? "sign-up" : "sign-in")
    setError("")
  }
  const stageLabel = awaitingApproval ? "Waiting" : pending ? (signingIn ? "Signing in" : "Creating") : signingIn ? "Sign in" : "Welcome"
  const inputClass = "min-h-12 rounded-xl border-white/10 bg-white/[0.04] px-4 text-[15px]"
  return (
    <main
      id="main-content"
      className="canvas relative min-h-[100dvh] overflow-hidden"
    >
      <header className="absolute inset-x-0 top-0 z-10 flex h-16 items-center px-5 sm:px-8">
        <BrandLockup orbClassName="size-7" />
      </header>
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-6xl items-center gap-x-12 gap-y-6 px-4 pt-16 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,25rem)] lg:pt-10">
        <section aria-label="Relo" className="min-w-0">
          <div className="mx-auto max-w-[34rem]">
            <React.Suspense fallback={<div className="h-[330px]" aria-hidden="true" />}>
              <NowHud
                welcome={{ label: stageLabel }}
                today={0}
                done={0}
                running={0}
                needsYou={0}
                arcs={[]}
                sentence=""
              />
            </React.Suspense>
          </div>
          <h1 className="rise-in mt-2 text-center font-[family-name:var(--font-rounded)] text-[2.25rem] leading-[1.08] font-bold tracking-tight text-balance sm:text-[2.75rem] lg:text-left">
            Your agents.
            <br />
            <span className="text-[var(--muted-foreground)]">One calm Inbox.</span>
          </h1>
          <ul className="rise-in rise-in-2 mx-auto mt-6 hidden max-w-md space-y-3 sm:block lg:mx-0">
            {promises.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-[15px] text-[#d6d6e2]">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-[var(--neon-cyan)]">
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="auth-title"
          className="glass rise-in rise-in-1 w-full justify-self-center rounded-[28px] p-6 sm:max-w-[25rem] sm:p-8"
        >
          <h2 id="auth-title" className="text-2xl font-bold tracking-tight">
            {awaitingApproval ? "Waiting for approval" : secondStep ? "Two-step sign-in" : title}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {awaitingApproval
              ? "Your account is created. You can sign in once the server admin approves it."
              : secondStep === "totp"
                ? "Enter the 6-digit code from your authenticator app."
                : secondStep === "backup"
                  ? "Enter one of the backup codes you saved when you turned on two-step sign-in."
                  : description}
          </p>
          <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-black/25 px-4 py-3">
            <div className="min-w-0">
              <p className="micro">Your server</p>
              <p className="mt-1 truncate font-mono text-[13px] text-foreground">{serverHost()}</p>
            </div>
            <span className="micro inline-flex shrink-0 items-center gap-1.5 text-[var(--neon-mint)]">
              <span className="ink-dot tone-mint" aria-hidden="true" />
              Online
            </span>
          </div>
          <div className="mt-6">
            {awaitingApproval ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-12 w-full rounded-full"
                onClick={() => {
                  setAwaitingApproval(false)
                  setMode("sign-in")
                }}
              >
                Back to sign in
              </Button>
            ) : secondStep ? (
            <form id="two-factor-form" className="space-y-4" onSubmit={(event) => void submitCode(event)}>
              <div className="space-y-2">
                <Label htmlFor="code">{secondStep === "totp" ? "Code" : "Backup code"}</Label>
                <Input
                  key={secondStep}
                  id="code"
                  name="code"
                  autoComplete="one-time-code"
                  inputMode={secondStep === "totp" ? "numeric" : "text"}
                  autoFocus
                  required
                  disabled={pending}
                  className={inputClass}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="trustDevice" className="size-4" disabled={pending} />
                Don't ask again on this browser for 30 days
              </label>
              <p role="alert" className="min-h-5 text-sm text-destructive">{error}</p>
              <button type="submit" disabled={pending} className="capsule-cta w-full disabled:opacity-60">
                {pending ? "Checking…" : "Continue"}
              </button>
              <Button
                type="button"
                variant="link"
                className="min-h-11 w-full"
                disabled={pending}
                onClick={() => { setSecondStep(secondStep === "totp" ? "backup" : "totp"); setError("") }}
              >
                {secondStep === "totp" ? "Use a backup code instead" : "Use the authenticator app instead"}
              </Button>
            </form>
            ) : (
            <form
              id="auth-form"
              data-mode={mode}
              data-next={bootstrap.route.nextPath}
              className="space-y-4"
              onSubmit={(event) => void submit(event)}
            >
              {!signingIn ? (
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    maxLength={120}
                    required
                    disabled={pending}
                    className={inputClass}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                  disabled={pending}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={signingIn ? "current-password" : "new-password"}
                  minLength={8}
                  maxLength={128}
                  required
                  disabled={pending}
                  className={inputClass}
                />
              </div>
              <p
                id="error"
                role="alert"
                className="min-h-5 text-sm text-destructive"
              >
                {error}
              </p>
              <button type="submit" disabled={pending} className="capsule-cta w-full disabled:opacity-60">
                {pending
                  ? signingIn
                    ? "Signing in…"
                    : "Creating account…"
                  : signingIn
                    ? "Sign in"
                    : "Create account"}
              </button>
              {canRegister ? (
                <Button
                  type="button"
                  variant="link"
                  className="min-h-11 w-full"
                  disabled={pending}
                  onClick={switchMode}
                >
                  {signingIn ? "New here? Create an account" : "Already have an account? Sign in"}
                </Button>
              ) : null}
            </form>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
