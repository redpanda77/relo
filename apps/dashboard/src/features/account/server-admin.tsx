import { useState } from "react"
import { ShieldCheck, UserPlus } from "lucide-react"

import { IconTile } from "@/components/atoms/icon-tile"
import { Badge } from "@/components/card"
import { List, Row } from "@/components/list"
import { ActionButton } from "@/components/molecules/action-button"
import { OperationStatus } from "@/components/molecules/operation-status"

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
import {
  Card,
  CardContent,
  CardFooter,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { AccountDashboardBootstrap } from "@/features/account/types"
import { relativeTime } from "@/lib/format"
import type {
  AccountService,
  PrivateCallbackPolicy,
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

const PRIVATE_CALLBACKS: Array<{ value: PrivateCallbackPolicy; label: string }> = [
  { value: "admin", label: "Your account only" },
  { value: "everyone", label: "Every account" },
  { value: "none", label: "Nobody" },
]

const QUESTION_WAITS = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 28_800, label: "8 hours" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "7 days" },
  { seconds: 2_592_000, label: "30 days" },
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
  const [questionWait, setQuestionWait] = useState(initial.maxQuestionSeconds)
  const [privateCallbacks, setPrivateCallbacks] = useState(initial.privateCallbacks)
  const [accounts, setAccounts] = useState(initial.accounts)
  const [busy, setBusy] = useState(false)
  /** Which button's action is running ("create", or an account id and action), for its spinner. */
  const [working, setWorking] = useState<string | null>(null)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [deleting, setDeleting] = useState<ServerAccount | null>(null)
  const pending = accounts.filter((account) => account.status === "pending").length

  async function run(work: () => Promise<string | void>, success: string, fallback: string, key: string | null = null) {
    setBusy(true)
    setWorking(key)
    setMessage(null)
    try {
      const outcome = await work()
      setMessage({ error: false, text: outcome || success })
    } catch (cause) {
      setMessage({ error: true, text: errorMessage(cause, fallback) })
    } finally {
      setBusy(false)
      setWorking(null)
    }
  }
  const failed = message?.error === true

  function changePrivateCallbacks(policy: PrivateCallbackPolicy) {
    if (policy === privateCallbacks) return
    const label = PRIVATE_CALLBACKS.find((option) => option.value === policy)?.label ?? policy
    void run(async () => {
      await service.setPrivateCallbacks(policy)
      setPrivateCallbacks(policy)
    }, `Private-network callbacks: ${label.toLowerCase()}.`, "Couldn't change callback access.")
  }

  function changeQuestionWait(seconds: number) {
    if (seconds === questionWait) return
    const label = QUESTION_WAITS.find((option) => option.seconds === seconds)?.label ?? `${seconds}s`
    void run(async () => {
      await service.setMaxQuestionSeconds(seconds)
      setQuestionWait(seconds)
    }, `Questions can now wait up to ${label}.`, "Couldn't change how long questions wait.")
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
    }, done[action], "Couldn't update access.", `${account.id}:${action}`)
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
    }, `${name}'s account is ready. Share the temporary password with them privately.`, "Couldn't create the account.", "create")
  }

  async function confirmDelete() {
    const account = deleting
    if (!account) return
    setDeleting(null)
    await run(async () => {
      await service.deleteServerAccount(account.id)
      setAccounts((current) => current.filter((item) => item.id !== account.id))
    }, `${account.name}'s account and all its data are deleted.`, "Couldn't delete the account.", `${account.id}:delete`)
  }

  return (
    <div id="server-accounts" className="grid scroll-mt-6 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            <IconTile icon={ShieldCheck} tone="violet" />
            Server accounts
            {pending ? <Badge tone="yellow">{pending} waiting</Badge> : null}
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
                  className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                    mode === option.value ? "border-[var(--hairline-strong)] bg-[var(--control-fill)]" : "hover:bg-white/[0.03]"
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

          <div className="grid gap-2 border-t border-white/[0.06] pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
            <div>
              <Label htmlFor="question-wait">Longest a question can wait</Label>
              <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
                Agents and apps may ask for longer than the usual 5 minutes, up to this. After 8 hours the
                card ends and the question keeps waiting in Relo.
              </p>
            </div>
            <NativeSelect
              id="question-wait"
              value={String(questionWait)}
              disabled={busy}
              onChange={(event) => changeQuestionWait(Number(event.target.value))}
            >
              {QUESTION_WAITS.map((option) => (
                <NativeSelectOption key={option.seconds} value={String(option.seconds)}>{option.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-2 border-t border-white/[0.06] pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
            <div>
              <Label htmlFor="private-callbacks">Answer callbacks to your private network</Label>
              <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
                Apps can have answers posted to an address on this network (for example a CI server on
                your LAN or VPN). The server's own localhost is never reachable.
              </p>
            </div>
            <NativeSelect
              id="private-callbacks"
              value={privateCallbacks}
              disabled={busy}
              onChange={(event) => changePrivateCallbacks(event.target.value as PrivateCallbackPolicy)}
            >
              {PRIVATE_CALLBACKS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      <List label="Accounts on this server" items={accounts} getKey={(account) => account.id}>
        {(account) => {
          const action = (name: ServerAccountAction | "delete") => ({
            pending: working === `${account.id}:${name}`,
            failed,
            successLabel: null,
          })
          return (
          <Row
            wrap
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                {account.name}
                {account.admin ? <Badge tone="neutral" variant="hairline">Admin · you</Badge> : null}
                {account.status === "pending" ? <Badge tone="yellow">Waiting for approval</Badge> : null}
                {account.status === "disabled" ? <Badge tone="red">Access off</Badge> : null}
              </span>
            }
          >
            <CardFooter
              className="px-4 pb-3.5"
              meta={
                <p className="text-xs text-muted-foreground">
                  {`${account.email} · joined ${relativeTime(account.createdAt)} · ${account.sessions} session${account.sessions === 1 ? "" : "s"} · ${account.devices} phone${account.devices === 1 ? "" : "s"}`}
                </p>
              }
              actions={
                account.admin ? null : (
                  <>
                    {account.status === "pending" ? (
                      <ActionButton disabled={busy} {...action("approve")} pendingLabel="Approving…" onClick={() => access(account, "approve")}>
                        Approve
                      </ActionButton>
                    ) : null}
                    {account.status === "active" ? (
                      <ActionButton variant="outline" disabled={busy || account.sessions === 0} {...action("sign-out")} pendingLabel="Signing out…" onClick={() => access(account, "sign-out")}>
                        Sign out
                      </ActionButton>
                    ) : null}
                    {account.status === "disabled" ? (
                      <ActionButton variant="outline" disabled={busy} {...action("enable")} pendingLabel="Restoring…" onClick={() => access(account, "enable")}>
                        Restore access
                      </ActionButton>
                    ) : (
                      <ActionButton variant="outline" disabled={busy} {...action("disable")} pendingLabel="Revoking…" onClick={() => access(account, "disable")}>
                        {account.status === "pending" ? "Decline" : "Revoke access"}
                      </ActionButton>
                    )}
                    <ActionButton variant="destructive" disabled={busy} {...action("delete")} pendingLabel="Deleting…" onClick={() => setDeleting(account)}>
                      Delete
                    </ActionButton>
                  </>
                )
              }
            />
          </Row>
          )
        }}
      </List>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5">
            <IconTile icon={UserPlus} />
            Add an account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={addAccount} className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="serverAccountName">Name</Label>
              <Input id="serverAccountName" name="serverAccountName" required maxLength={120} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serverAccountEmail">Email</Label>
              <Input id="serverAccountEmail" name="serverAccountEmail" type="email" required autoComplete="off" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serverAccountPassword">Temporary password</Label>
              <Input id="serverAccountPassword" name="serverAccountPassword" type="password" minLength={8} maxLength={128} required autoComplete="new-password" />
            </div>
            <CardFooter
              className="sm:col-span-2"
              actions={
                <ActionButton type="submit" disabled={busy} pending={working === "create"} failed={failed} pendingLabel="Creating…" successLabel="Created">
                  Create account
                </ActionButton>
              }
            />
          </form>
        </CardContent>
      </Card>

      <OperationStatus
        reserve
        pending={busy}
        pendingLabel=""
        error={message?.error ? message.text : null}
        success={message && !message.error ? message.text : null}
      />

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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
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
    </div>
  )
}
