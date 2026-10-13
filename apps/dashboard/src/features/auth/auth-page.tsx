import { BellRing } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authenticateOwner } from "@/features/auth/auth-service"
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
      onAuthenticated(bootstrap.route.nextPath)
    } catch (cause) {
      setError(friendlyAuthError(cause))
      setPending(false)
    }
  }

  const signingIn = mode === "sign-in"
  function switchMode() {
    setMode(signingIn ? "sign-up" : "sign-in")
    setError("")
  }
  return (
    <main
      id="main-content"
      className="canvas grid min-h-[100dvh] place-items-center px-4 py-10 sm:px-6"
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <BellRing className="size-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">Relo</span>
        </div>
        <Card className="glass-strong">
          <CardHeader className="space-y-1.5 p-6 sm:p-8">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              {awaitingApproval ? "Waiting for approval" : title}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {awaitingApproval
                ? "Your account is created. You can sign in once the server admin approves it."
                : description}
            </p>
          </CardHeader>
          <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
            {awaitingApproval ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                onClick={() => {
                  setAwaitingApproval(false)
                  setMode("sign-in")
                }}
              >
                Back to sign in
              </Button>
            ) : (
            <form
              id="auth-form"
              data-mode={mode}
              data-next={bootstrap.route.nextPath}
              className="space-y-5"
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
                    className="min-h-11"
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
                  required
                  disabled={pending}
                  className="min-h-11"
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
                  className="min-h-11"
                />
              </div>
              <p
                id="error"
                role="alert"
                className="min-h-5 text-sm text-destructive"
              >
                {error}
              </p>
              <Button type="submit" disabled={pending} className="min-h-11 w-full">
                {pending
                  ? signingIn
                    ? "Signing in…"
                    : "Creating account…"
                  : signingIn
                    ? "Sign in"
                    : "Create account"}
              </Button>
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
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
