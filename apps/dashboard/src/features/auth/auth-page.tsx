import { Activity, LockKeyhole, MessageSquareReply } from "lucide-react"
import * as React from "react"

import { OrbStage } from "@/components/organisms/orb-stage"

import { BrandLockup } from "@/components/brand"
import { SaveError } from "@/components/molecules/system-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { appleSignInError, appleSignInUrl, authenticateOwner, mobileSignInHint, verifySecondStep } from "@/features/auth/auth-service"
import { GITHUB_URL, GitHubMark } from "@/features/auth/github"
import { CONNECT_AFTER_SIGNUP_PATH } from "@/features/onboarding/connect-service"
import type { DashboardAuth } from "@/features/auth/types"
import { useShake } from "@/lib/use-shake"

function friendlyAuthError(cause: unknown, mode: "sign-in" | "sign-up"): string {
  const raw = cause instanceof Error ? cause.message.toLowerCase() : ""
  // The server's own refusal of a sign-up is already written for people.
  if (raw.includes("couldn't create this account")) return "Couldn't create this account. If you already have one, sign in."
  if (raw.includes("invalid") && (raw.includes("password") || raw.includes("credential") || raw.includes("email")))
    return "That email and password don't match."
  if (raw.includes("owner not bootstrapped")) return "This server isn't ready for its first account yet."
  if (raw.includes("approval pending")) return "Your account is waiting for the server admin's approval."
  if (raw.includes("account disabled")) return "The server admin has turned off access for this account."
  if (raw.includes("registration closed")) return "This server isn't taking new accounts. Ask its admin to create one for you."
  if (raw.includes("already exists") || raw.includes("user exists")) return "An account with that email already exists."
  if (raw.includes("rate") || raw.includes("too many")) return "Too many attempts. Wait a minute and try again."
  return mode === "sign-up"
    ? "Couldn't create the account. Check your connection and try again."
    : "Couldn't sign in. Check your connection and try again."
}

const promises = [
  { icon: Activity, text: "Live progress on your iPhone's Lock Screen or your Mac's notch." },
  { icon: MessageSquareReply, text: "Approve, decline or answer your agents from your phone or Mac." },
  { icon: LockKeyhole, text: "End-to-end encrypted to your devices, on a server you run." },
] as const

/** Desktop shows the deck alone and large; phones get a smaller deck so the whole form fits one screen. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = React.useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true)
  React.useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])
  return matches
}


export function AuthPage({
  bootstrap,
  onAuthenticated = (path) => window.location.assign(path),
  onReturnToApp = (url) => window.location.assign(url),
}: {
  bootstrap: DashboardAuth
  onAuthenticated?: (path: string) => void
  /** Sends the browser back to the Relo app (relo://auth/callback?pending=…) while the account waits for approval. */
  onReturnToApp?: (url: string) => void
}) {
  const wideDeck = useMedia("(min-width: 1024px)")
  const phone = useMedia("(max-width: 639px)")
  const short = useMedia("(max-height: 700px)")
  const [pending, setPending] = React.useState(false)
  // Sign in with Apple returns here with ?apple=<reason> when it could not sign the person in.
  const [error, setError] = React.useState(() => typeof window === "undefined" ? "" : appleSignInError(window.location.search))
  // "Create account" on the landing page arrives as ?mode=sign-up (only where registration is open).
  const [mode, setMode] = React.useState(() =>
    bootstrap.mode === "sign-in" && bootstrap.registration !== "closed" && new URLSearchParams(window.location.search).get("mode") === "sign-up" ? "sign-up" : bootstrap.mode)
  const [awaitingApproval, setAwaitingApproval] = React.useState(false)
  // Waiting inside an app's sign-in: the app was handed a ticket and signs itself in once the admin approves.
  const [appWaiting, setAppWaiting] = React.useState(false)
  const [secondStep, setSecondStep] = React.useState<null | "totp" | "backup">(null)
  // A refusal shakes the form and selects the field to retype, once the inputs are enabled again.
  const [refusals, setRefusals] = React.useState(0)
  const [form, shake] = useShake<HTMLFormElement>()
  React.useEffect(() => {
    if (!refusals) return
    const field = form.current?.querySelector<HTMLInputElement>('input[name="code"], input[name="password"]')
    shake(field)
  }, [refusals, form, shake])
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
      }, mobileSignInHint(bootstrap.route.nextPath))
      if (typeof outcome === "object") {
        setAwaitingApproval(true)
        setPending(false)
        if (outcome.redirect) {
          setAppWaiting(true)
          onReturnToApp(outcome.redirect)
        }
        return
      }
      if (outcome === "two-factor") {
        setSecondStep("totp")
        setPending(false)
        return
      }
      // A new account lands in Connect a computer; the page it asked for waits behind the wizard.
      onAuthenticated(mode === "sign-up" && bootstrap.route.nextPath === "/dashboard" ? CONNECT_AFTER_SIGNUP_PATH : bootstrap.route.nextPath)
    } catch (cause) {
      setError(friendlyAuthError(cause, mode))
      setPending(false)
      setRefusals((count) => count + 1)
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
      setRefusals((count) => count + 1)
    }
  }

  const signingIn = mode === "sign-in"
  function switchMode() {
    setMode(signingIn ? "sign-up" : "sign-in")
    setError("")
  }
  const deckHeight = wideDeck ? 600 : phone ? (short ? 150 : 200) : 330
  const stageLabel = awaitingApproval ? "Waiting" : pending ? (signingIn ? "Signing in" : "Creating") : signingIn ? "Sign in" : "Welcome"
  const inputClass = "px-4 text-[15px]"
  return (
    <main
      id="main-content"
      className="canvas relative min-h-[100dvh] overflow-hidden"
    >
      <header className="absolute inset-x-0 top-0 z-10">
        <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between px-5 sm:px-8 lg:h-20 lg:px-12">
          <a href="/" aria-label="Relo home">
            <BrandLockup orbClassName="size-7" />
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="external noopener"
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-[13px] text-[#d6d6e2] transition-colors hover:border-white/25 hover:text-foreground"
          >
            <GitHubMark className="size-4" />
            <span className="hidden sm:inline">View on GitHub</span>
            <span className="sm:hidden">GitHub</span>
          </a>
        </div>
      </header>
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-[1240px] items-center gap-x-20 gap-y-4 px-4 pt-14 pb-4 sm:gap-y-6 sm:px-8 sm:pt-16 sm:pb-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,27rem)] lg:px-12 lg:pt-24 lg:pb-16">
        <section aria-label="Relo" className="min-w-0">
          <div className="mx-auto max-w-[34rem] lg:max-w-none">
            {/* The same core as the landing and Now, wearing the wordmark instead of a count. `auth-core` names
                it `relo-core` for the page transition (loading.css), so signing in carries it to Now. */}
            <OrbStage className="auth-core w-full" style={{ height: deckHeight }}>
              <div aria-hidden="true" className="flex flex-col items-center gap-2 text-center">
                <span className="wordmark wordmark-glow" style={{ fontSize: `${(3.75 * deckHeight) / 330}rem` }}>relo</span>
                <span className="micro" style={{ color: "var(--neon-cyan)" }}>{stageLabel}</span>
              </div>
            </OrbStage>
          </div>
          <h1 className="rise-in text-center font-[family-name:var(--font-rounded)] text-[1.75rem] leading-[1.08] sm:mt-2 sm:text-[2.25rem] font-bold tracking-tight text-balance sm:text-[2.75rem] lg:sr-only">
            Every agent.
            <br />
            <span className="text-[var(--muted-foreground)]">One place.</span>
          </h1>
          <ul className="rise-in rise-in-2 mx-auto mt-7 hidden w-fit max-w-md space-y-3 sm:block lg:hidden">
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
          className="glass rise-in rise-in-1 w-full justify-self-center rounded-[28px] p-5 sm:max-w-[27rem] sm:p-8 lg:p-10"
        >
          <h2 id="auth-title" className="text-2xl font-bold tracking-tight">
            {awaitingApproval ? "Waiting for approval" : secondStep ? "Two-step sign-in" : title}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {awaitingApproval
              ? appWaiting
                ? "Your account is waiting for approval. You can close this window: Relo keeps working on this computer and signs you in when you're approved."
                : "Your account is created. You can sign in once the server admin approves it."
              : secondStep === "totp"
                ? "Enter the 6-digit code from your authenticator app."
                : secondStep === "backup"
                  ? "Enter one of the backup codes you saved when you turned on two-step sign-in."
                  : description}
          </p>
          <div className="mt-5 sm:mt-6">
            {awaitingApproval && appWaiting ? null : awaitingApproval ? (
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
            <form ref={form} id="two-factor-form" className="space-y-4" onSubmit={(event) => void submitCode(event)}>
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
              <SaveError message={error} eyebrow="NOT VERIFIED" />
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
              ref={form}
              id="auth-form"
              data-mode={mode}
              data-next={bootstrap.route.nextPath}
              className="space-y-3.5 sm:space-y-4"
              onSubmit={(event) => void submit(event)}
            >
              {bootstrap.appleSignIn && (signingIn || canRegister || !claimed) ? (
                <>
                  <AppleSignInButton href={appleSignInUrl(bootstrap.route.nextPath)} disabled={pending} />
                  <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                    <span className="h-px flex-1 bg-white/10" />or with email<span className="h-px flex-1 bg-white/10" />
                  </div>
                </>
              ) : null}
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
              <SaveError id="error" message={error} eyebrow={signingIn ? "NOT SIGNED IN" : "NOT CREATED"} />
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

/** Apple's button: white on the dark page, the Apple mark and "Continue with Apple" (it signs in and signs up). */
function AppleSignInButton({ href, disabled }: { href: string; disabled: boolean }) {
  return (
    <a
      href={href}
      aria-disabled={disabled || undefined}
      onClick={(event) => { if (disabled) event.preventDefault() }}
      className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-white px-4 text-[15px] font-medium text-black transition-opacity hover:opacity-90 aria-disabled:opacity-60"
    >
      <svg viewBox="0 0 814 1000" aria-hidden="true" className="size-4 fill-current">
        <path d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-164-40c-77 0-104 41-167 41s-106-58-156-128C44 790 0 671 0 557 0 375 118 278 235 278c62 0 114 41 153 41 37 0 95-43 166-43 27 0 124 2 188 65zM554 166c29-35 50-83 50-131 0-7-1-14-2-19-48 2-104 32-138 71-27 30-52 78-52 127 0 7 1 15 2 17 3 1 8 1 13 1 43 0 97-29 127-66z" />
      </svg>
      Continue with Apple
    </a>
  )
}
