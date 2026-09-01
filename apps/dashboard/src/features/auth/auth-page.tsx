import { BellRing, LockKeyhole } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authenticateOwner } from "@/features/auth/auth-service"
import type { DashboardAuth } from "@/features/auth/types"

export function AuthPage({
  bootstrap,
  onAuthenticated = (path) => window.location.assign(path),
}: {
  bootstrap: DashboardAuth
  onAuthenticated?: (path: string) => void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState("")

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    setPending(true)
    setError("")
    try {
      await authenticateOwner(bootstrap.mode, {
        name:
          bootstrap.mode === "sign-up"
            ? String(values.get("name") ?? "")
            : undefined,
        email: String(values.get("email") ?? ""),
        password: String(values.get("password") ?? ""),
      })
      onAuthenticated(bootstrap.route.nextPath)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed."
      )
      setPending(false)
    }
  }

  const signingIn = bootstrap.mode === "sign-in"
  return (
    <main
      id="main-content"
      className="canvas grid min-h-[100dvh] place-items-center px-4 py-10 sm:px-6"
    >
      <div className="w-full max-w-[460px]">
        <a
          href="/"
          className="mb-6 inline-flex min-h-11 items-center gap-3 rounded-[10px] text-sm font-semibold tracking-[-0.02em] text-foreground no-underline"
        >
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <BellRing className="size-5" aria-hidden="true" />
          </span>
          Relo
        </a>
        <Card className="overflow-hidden rounded-[16px] border-border bg-card/95 shadow-[0_24px_80px_rgb(4_2_6_/_0.35)]">
          <CardHeader className="space-y-3 p-6 sm:p-8">
            <span className="grid size-11 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
              <LockKeyhole className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-2xl tracking-[-0.035em]">
              {bootstrap.title}
            </CardTitle>
            <p className="max-w-[42ch] text-sm leading-6 text-muted-foreground">
              {bootstrap.description}
            </p>
          </CardHeader>
          <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
            <form
              id="auth-form"
              data-mode={bootstrap.mode}
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
                    ? "Signing in..."
                    : "Creating account..."
                  : signingIn
                    ? "Sign in"
                    : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
