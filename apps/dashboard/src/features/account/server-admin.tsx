import { useState } from "react"
import { ShieldCheck } from "lucide-react"

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
import { Badge } from "@/components/ui/badge"
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
import type { AccountDashboardBootstrap } from "@/features/account/types"
import { relativeTime } from "@/lib/format"
import type {
  AccountService,
  RegistrationMode,
  ServerAccountAction,
} from "@/services/account-service"

type Server = NonNullable<AccountDashboardBootstrap["server"]>
type ServerAccount = Server["accounts"][number]

const modes: Array<{ value: RegistrationMode; label: string; detail: string }> = [
  { value: "closed", label: "Closed", detail: "Only you can add accounts." },
  { value: "approval", label: "Approval", detail: "Anyone can register; you approve before they sign in." },
  { value: "open", label: "Open", detail: "Anyone who can reach this server can register." },
]

const friendlyErrors: Record<string, string> = {
  email_taken: "An account with that email already exists.",
  cannot_change_admin_access: "You can't change your own access as the server admin.",
  account_not_found: "That account no longer exists. Refresh to update the list.",
}

function errorMessage(cause: unknown, fallback: string): string {
  const code = cause instanceof Error ? cause.message : ""
  return friendlyErrors[code] ?? (code || fallback)
}

/** ADR 0004: the server admin controls who registers and who keeps access, never account content. */
export function ServerAdminCard({
  initial,
  service,
}: {
  initial: Server
  service: AccountService
}) {
  const [mode, setMode] = useState(initial.registrationMode)
  const [accounts, setAccounts] = useState(initial.accounts)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [deleting, setDeleting] = useState<ServerAccount | null>(null)
  const pending = accounts.filter((account) => account.status === "pending").length

  async function run(work: () => Promise<string | void>, success: string, fallback: string) {
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await work()
      setMessage({ error: false, text: outcome || success })
    } catch (cause) {
      setMessage({ error: true, text: errorMessage(cause, fallback) })
    } finally {
      setBusy(false)
    }
  }

  function changeMode(next: RegistrationMode) {
    if (next === mode) return
    void run(async () => {
      await service.setRegistrationMode(next)
      setMode(next)
    }, `Registration is now ${next}.`, "Couldn't change registration.")
  }

  function access(account: ServerAccount, action: ServerAccountAction) {
    const done: Record<ServerAccountAction, string> = {
      approve: `${account.name} can now sign in.`,
      disable: `${account.name}'s access is off. Their data is kept.`,
      enable: `${account.name}'s access is back on.`,
      "sign-out": `${account.name} is signed out everywhere.`,
    }
    void run(async () => {
      await service.changeServerAccountAccess(account.id, action)
      // The server decides the resulting status (restoring a never-approved account keeps it waiting).
      const server = await service.loadServer()
      setAccounts(server.accounts)
      const now = server.accounts.find((item) => item.id === account.id)
      if (action === "enable" && now?.status === "pending") return `${account.name}'s access is back on; they still need your approval.`
    }, done[action], "Couldn't update access.")
  }

  function addAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const name = String(values.get("serverAccountName") ?? "")
    const email = String(values.get("serverAccountEmail") ?? "")
    void run(async () => {
      const { id } = await service.createServerAccount({
        name,
        email,
        password: String(values.get("serverAccountPassword") ?? ""),
      })
      form.reset()
      setAccounts((current) => [...current, {
        id, name, email, status: "active", admin: false,
        createdAt: new Date().toISOString(), devices: 0, sessions: 0,
      }])
    }, `${name}'s account is ready. Share the temporary password with them privately.`, "Couldn't create the account.")
  }

  async function confirmDelete() {
    const account = deleting
    if (!account) return
    setDeleting(null)
    await run(async () => {
      await service.deleteServerAccount(account.id)
      setAccounts((current) => current.filter((item) => item.id !== account.id))
    }, `${account.name}'s account and all its data are deleted.`, "Couldn't delete the account.")
  }

  return (
    <Card id="server-accounts" className="rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          Server accounts
          {pending ? <Badge variant="default">{pending} waiting</Badge> : null}
        </CardTitle>
        <CardDescription>
          You own this server. Decide who can register and who keeps access.
          Each account is private: you see names and emails here, never their
          notifications, cards or phones.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <fieldset className="grid gap-3" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Registration</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {modes.map((option) => (
              <label
                key={option.value}
                className={`flex min-h-11 cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                  mode === option.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="registrationMode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => changeMode(option.value)}
                    className="size-4 accent-primary"
                  />
                  {option.label}
                </span>
                <span className="text-muted-foreground">{option.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <ul className="grid gap-3" aria-label="Accounts on this server">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="break-words">{account.name}</strong>
                  {account.admin ? <Badge variant="secondary">Admin · you</Badge> : null}
                  {account.status === "pending" ? <Badge variant="default">Waiting for approval</Badge> : null}
                  {account.status === "disabled" ? <Badge variant="destructive">Access off</Badge> : null}
                </div>
                <p className="mt-1 text-sm break-words text-muted-foreground">
                  {account.email} · joined {relativeTime(account.createdAt)} · {account.sessions} session
                  {account.sessions === 1 ? "" : "s"} · {account.devices} phone{account.devices === 1 ? "" : "s"}
                </p>
              </div>
              {account.admin ? null : (
                <div className="flex flex-wrap gap-2">
                  {account.status === "pending" ? (
                    <Button className="min-h-11" disabled={busy} onClick={() => access(account, "approve")}>
                      Approve
                    </Button>
                  ) : null}
                  {account.status === "active" ? (
                    <Button variant="outline" className="min-h-11" disabled={busy || account.sessions === 0} onClick={() => access(account, "sign-out")}>
                      Sign out
                    </Button>
                  ) : null}
                  {account.status === "disabled" ? (
                    <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => access(account, "enable")}>
                      Restore access
                    </Button>
                  ) : (
                    <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => access(account, "disable")}>
                      {account.status === "pending" ? "Decline" : "Revoke access"}
                    </Button>
                  )}
                  <Button variant="destructive" className="min-h-11" disabled={busy} onClick={() => setDeleting(account)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <form onSubmit={addAccount} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2">
          <p className="text-sm font-medium sm:col-span-2">Add an account</p>
          <div className="grid gap-2">
            <Label htmlFor="serverAccountName">Name</Label>
            <Input id="serverAccountName" name="serverAccountName" required maxLength={120} className="min-h-11" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="serverAccountEmail">Email</Label>
            <Input id="serverAccountEmail" name="serverAccountEmail" type="email" required autoComplete="off" className="min-h-11" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="serverAccountPassword">Temporary password</Label>
            <Input id="serverAccountPassword" name="serverAccountPassword" type="password" minLength={8} maxLength={128} required autoComplete="new-password" className="min-h-11" />
          </div>
          <div className="flex items-end">
            <Button type="submit" className="min-h-11" disabled={busy}>Create account</Button>
          </div>
        </form>

        <p
          className={`min-h-5 text-sm ${message?.error ? "text-destructive" : "text-[var(--status-success)]"}`}
          role={message?.error ? "alert" : "status"}
        >
          {message?.text}
        </p>
      </CardContent>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}'s account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently erases their account, phones, CLI connections,
              services, notifications and cards. It can't be undone. To keep
              their data, revoke access instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
