import { Page } from "@/components/page"
import { useRef, useState } from "react"
import { Copy, Terminal } from "lucide-react"

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
import { ServerAdminCard } from "@/features/account/server-admin"
import { LinkBrowserSection } from "@/features/linked-browser/link-browser-card"
import { PresentationPolicyControl } from "@/features/presentation-policy/presentation-policy-control"
import {
  createHttpAccountService,
  type AccountService,
} from "@/services/account-service"

type OperationState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "success"; message: string }

const idle: OperationState = { status: "idle" }

function Field({
  label,
  name,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "id" | "name"> & {
  label: string
  name: string
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} className="min-h-11" {...props} />
    </div>
  )
}

function OperationMessage({ state }: { state: OperationState }) {
  if (state.status === "idle" || state.status === "pending") return null
  return (
    <p
      className={
        state.status === "error"
          ? "text-sm text-destructive"
          : "text-sm text-[var(--status-success)]"
      }
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  )
}

export function AccountPage({
  initial,
  service = createHttpAccountService(),
  onDeleted = () => window.location.assign("/"),
}: {
  initial: AccountDashboardBootstrap
  service?: AccountService
  onDeleted?: () => void
}) {
  const passwordForm = useRef<HTMLFormElement>(null)
  const cliCommandInput = useRef<HTMLInputElement>(null)
  const [passwordState, setPasswordState] = useState<OperationState>(idle)
  const [deletionState, setDeletionState] = useState<OperationState>(idle)
  const [deletionDialogOpen, setDeletionDialogOpen] = useState(false)
  const [userState, setUserState] = useState<OperationState>(idle)
  const [cliCopyStatus, setCliCopyStatus] = useState("")
  const [users, setUsers] = useState(initial.users)
  const cliLoginCommand = `relo auth login --api-url ${JSON.stringify(initial.account.serverOrigin)} --json`
  const deletionInput = useRef<{
    password: string
    confirmation: string
  } | null>(null)

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (passwordState.status === "pending") return
    const form = event.currentTarget
    const values = new FormData(form)
    setPasswordState({ status: "pending" })
    try {
      await service.changePassword({
        currentPassword: String(values.get("currentPassword") ?? ""),
        newPassword: String(values.get("newPassword") ?? ""),
        revokeOtherSessions: values.get("revokeOtherSessions") === "on",
      })
      form.reset()
      setPasswordState({
        status: "success",
        message: "Password changed successfully.",
      })
    } catch (cause) {
      setPasswordState({
        status: "error",
        message:
          cause instanceof Error ? cause.message : "Password change failed",
      })
    }
  }

  async function userAction(id: string, action: "toggle" | "revoke" | "reset", password?: string) {
    setUserState({ status: "pending" })
    try {
      const user = users.find(item => item.id === id)!
      if (action === "toggle") await service.setUserEnabled(id, user.disabled)
      if (action === "revoke") await service.revokeUserSessions(id)
      if (action === "reset") await service.resetUserPassword(id, password ?? "")
      setUsers(current => current.map(item => item.id === id ? {
        ...item,
        disabled: action === "toggle" ? !item.disabled : item.disabled,
        sessions: action === "revoke" || action === "reset" || (action === "toggle" && !item.disabled) ? 0 : item.sessions,
        devices: action === "revoke" || (action === "toggle" && !item.disabled) ? 0 : item.devices,
      } : item))
      setUserState({ status: "success", message: action === "reset" ? "Password reset and existing sessions revoked." : "User access updated." })
    } catch (cause) { setUserState({ status: "error", message: cause instanceof Error ? cause.message : "User update failed" }) }
  }

  function reviewDeletion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (deletionState.status === "pending") return
    const values = new FormData(event.currentTarget)
    deletionInput.current = {
      password: String(values.get("password") ?? ""),
      confirmation: String(values.get("confirmation") ?? ""),
    }
    setDeletionState(idle)
    setDeletionDialogOpen(true)
  }

  async function deleteAccount() {
    if (!deletionInput.current || deletionState.status === "pending") return
    setDeletionState({ status: "pending" })
    try {
      await service.deleteAccount(deletionInput.current)
      setDeletionState({
        status: "success",
        message: "Account deleted. Redirecting…",
      })
      onDeleted()
    } catch (cause) {
      setDeletionState({
        status: "error",
        message:
          cause instanceof Error ? cause.message : "Account deletion failed",
      })
    } finally {
      setDeletionDialogOpen(false)
    }
  }

  async function copyCliLoginCommand() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard API unavailable")
      await navigator.clipboard.writeText(cliLoginCommand)
      setCliCopyStatus("Login command copied.")
    } catch {
      cliCommandInput.current?.focus()
      cliCommandInput.current?.select()
      setCliCopyStatus(
        "Automatic clipboard access is unavailable. The command is selected for manual copy."
      )
    }
  }

  return (
    <Page title={initial.shell.title}>
      <div>

        <div className="mt-8 grid gap-5">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Name", initial.account.name],
                  ["Email", initial.account.email],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-muted/45 p-4">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd
                      className={`mt-1 break-words ${
                        label === "Account ID" ? "font-mono text-xs" : ""
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <LinkBrowserSection accountId={initial.shell.account.id} />

          <Card id="connect-cli" className="rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="size-5 text-primary" aria-hidden="true" />
                Connect the CLI
              </CardTitle>
              <CardDescription>
                Run this once on each computer that should send notifications
                through this Relo server.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="cli-login-command">Login command</Label>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    ref={cliCommandInput}
                    id="cli-login-command"
                    value={cliLoginCommand}
                    readOnly
                    spellCheck={false}
                    className="min-h-11 font-mono text-xs"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    className="min-h-11"
                    onClick={() => void copyCliLoginCommand()}
                  >
                    <Copy aria-hidden="true" />
                    Copy command
                  </Button>
                </div>
                <p
                  className="min-h-5 text-sm text-muted-foreground"
                  aria-live="polite"
                >
                  {cliCopyStatus}
                </p>
              </div>

            </CardContent>
          </Card>

          {initial.server ? <ServerAdminCard initial={initial.server} service={service} /> : null}

          {users.some(user => user.role === "member") ? (
          <Card className="rounded-2xl">
            <CardHeader><CardTitle>Shared access</CardTitle><CardDescription>
              These people were added to your account before accounts became separate, so they see your data.
              Disable them, revoke their sessions and phones, or set a replacement password. New people get their own account.
            </CardDescription></CardHeader>
            <CardContent className="grid gap-6">
              <div className="grid gap-3">{users.map(user => <div key={user.id} className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[1fr_auto] lg:items-center">
                <div><div className="flex flex-wrap items-center gap-2"><strong>{user.name}</strong><span className="rounded-full bg-muted px-2 py-0.5 text-xs">{user.role}</span>{user.disabled && <span className="text-xs text-destructive">disabled</span>}</div>
                  <p className="text-sm text-muted-foreground">{user.email} · {user.sessions} session{user.sessions === 1 ? "" : "s"} · {user.devices} phone{user.devices === 1 ? "" : "s"}</p></div>
                <div className="flex flex-wrap gap-2">
                  <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get("newPassword"); void userAction(user.id,"reset",String(value ?? "")); event.currentTarget.reset() }}>
                    <Input name="newPassword" type="password" minLength={8} maxLength={128} required placeholder="New password" className="min-h-11 w-40" />
                    <Button type="submit" variant="outline" className="min-h-11">Reset</Button>
                  </form>
                  <Button variant="outline" className="min-h-11" onClick={() => void userAction(user.id,"revoke")}>Revoke access</Button>
                  {user.role !== "owner" && <Button variant={user.disabled ? "outline" : "destructive"} className="min-h-11" onClick={() => void userAction(user.id,"toggle")}>{user.disabled ? "Enable" : "Disable"}</Button>}
                </div>
              </div>)}</div>
              <OperationMessage state={userState} />
            </CardContent>
          </Card>
          ) : null}

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Live Activity defaults</CardTitle>
              <CardDescription>
                Set production appearance once. CLI clients and webhook services
                inherit this policy unless they have a scoped override.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PresentationPolicyControl
                scopeLabel="Account"
                initialPolicy={initial.account.liveActivityPolicy}
                initialSource={initial.account.liveActivityPolicySource}
                canInherit
                onSave={(policy) => service.saveLiveActivityPolicy(policy)}
                onReset={() => service.resetLiveActivityPolicy()}
              />
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Change password</CardTitle>
              <CardDescription>
                Confirm your current password. You can revoke every other
                signed-in session at the same time.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <form
                ref={passwordForm}
                id="password-form"
                className="grid max-w-xl gap-4"
                aria-busy={passwordState.status === "pending"}
                onSubmit={changePassword}
              >
                <Field
                  label="Current password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
                <Field
                  label="New password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
                <Label className="min-h-11 w-fit cursor-pointer gap-3 pr-3">
                  <input
                    name="revokeOtherSessions"
                    type="checkbox"
                    className="size-5 accent-primary"
                    defaultChecked
                  />
                  <span>Sign out other sessions</span>
                </Label>
                <Button
                  type="submit"
                  className="min-h-11 w-full sm:w-fit"
                  disabled={passwordState.status === "pending"}
                >
                  {passwordState.status === "pending"
                    ? "Changing password…"
                    : "Change password"}
                </Button>
                <OperationMessage state={passwordState} />
              </form>
              <p className="max-w-3xl rounded-xl bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
                Email reset is intentionally unavailable. A protected Relo server
                recovery command can replace the owner password and revoke every
                active session; see the operations guide.
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-destructive/40">
            <CardHeader>
              <CardTitle>Delete account</CardTitle>
              <CardDescription>
                Permanently erase the active account database, registered
                devices, services, clients, notification history, and
                activities. Existing encrypted backups remain until their
                configured rotation removes them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                id="delete-account-form"
                className="grid max-w-xl gap-4"
                aria-busy={deletionState.status === "pending"}
                onSubmit={reviewDeletion}
              >
                <Field
                  label="Current password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
                <Field
                  label="Type DELETE"
                  name="confirmation"
                  autoComplete="off"
                  pattern="DELETE"
                  required
                />
                <Button
                  type="submit"
                  variant="destructive"
                  className="min-h-11 w-full sm:w-fit"
                  disabled={deletionState.status === "pending"}
                >
                  Delete account
                </Button>
                <OperationMessage state={deletionState} />
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog
        open={deletionDialogOpen}
        onOpenChange={(open) => {
          if (deletionState.status !== "pending") setDeletionDialogOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete the Relo owner account and all active server
              data? This action cannot be undone. Existing encrypted backups
              remain until their configured rotation removes them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="min-h-11"
              disabled={deletionState.status === "pending"}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              variant="destructive"
              disabled={deletionState.status === "pending"}
              onClick={(event) => {
                event.preventDefault()
                void deleteAccount()
              }}
            >
              {deletionState.status === "pending"
                ? "Deleting account…"
                : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
