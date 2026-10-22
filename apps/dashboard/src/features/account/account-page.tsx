import { useRef, useState } from "react"
import { Info, LogOut, Terminal } from "lucide-react"

import { IconTile } from "@/components/atoms/icon-tile"
import { Badge } from "@/components/card"
import { List, Row, Section } from "@/components/list"
import { ActionButton } from "@/components/molecules/action-button"
import { CopyButton } from "@/components/molecules/copy-button"
import { Notice } from "@/components/molecules/notice"
import {
  OperationStatus,
  type OperationState,
} from "@/components/molecules/operation-status"
import { IndexedSections, Page } from "@/components/page"

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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AccountDashboardBootstrap } from "@/features/account/types"
import { SoundCard } from "@/features/account/sound-card"
import { ServerAdminCard } from "@/features/account/server-admin"
import { EncryptionPolicyCard } from "@/features/encryption-policy/encryption-policy-card"
import { TwoFactorCard } from "@/features/two-factor/two-factor-card"
import { DevicesSection } from "@/features/devices/devices-section"
import { ColorAppearance } from "@/features/presentation-policy/color-appearance"
import { signOutThisBrowser } from "@/lib/sign-out"
import { focusAndSelect } from "@/lib/use-shake"
import {
  createHttpAccountService,
  type AccountService,
} from "@/services/account-service"

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
      <Input id={name} name={name} {...props} />
    </div>
  )
}

const idle: OperationState = { status: "idle" }

/** The account page's sections, in order; the wide layout lists them in a sticky index. */
const SECTIONS = [
  { id: "computers", title: "Computers" },
  { id: "security", title: "Security" },
  { id: "command-line", title: "Command line (advanced)" },
  { id: "server", title: "Server" },
  { id: "shared-access", title: "Shared access" },
  { id: "preferences", title: "Preferences" },
  { id: "sign-in", title: "Sign-in" },
  { id: "danger-zone", title: "Danger zone" },
] as const

function SignOutRow() {
  const [state, setState] = useState<OperationState>(idle)
  return (
    <List label="This browser">
      <Row
        leading={<IconTile icon={LogOut} />}
        title="Sign out of this browser"
        meta="Ends this session and forgets this browser's keys."
        busy={state.status === "pending"}
        actions={
          <ActionButton
            type="button"
            variant="outline"
            size="sm"
            phase={state.status}
            pendingLabel="Signing out…"
            successLabel={null}
            onClick={() => {
              setState({ status: "pending" })
              signOutThisBrowser()
                .then(() => window.location.assign("/"))
                .catch((cause: unknown) =>
                  setState({ status: "error", message: cause instanceof Error ? cause.message : "Sign out failed" })
                )
            }}
          >
            Sign out
          </ActionButton>
        }
      >
        <OperationStatus state={state} pendingLabel="Signing out…" className="px-4 pb-3 text-xs" />
      </Row>
    </List>
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
  // Installs the CLI this server hands out (with Node.js 22 if missing), then signs in with the link and QR code.
  const cliLoginCommand = `curl -fsSL ${initial.account.serverOrigin}/install.sh | sh && ~/.local/bin/relo auth login --api-url ${JSON.stringify(initial.account.serverOrigin)}`
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
      // The button shakes; the current password is ready to retype.
      focusAndSelect(form.elements.namedItem("currentPassword") as HTMLInputElement | null)
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

  function cliCopyFailed() {
    cliCommandInput.current?.focus()
    cliCommandInput.current?.select()
    setCliCopyStatus(
      "Automatic clipboard access is unavailable. The command is selected for manual copy."
    )
  }

  const host = typeof window === "undefined" ? "" : window.location.host
  const hasShared = users.some((user) => user.role === "member")
  const sections = SECTIONS.filter(
    (section) =>
      (section.id !== "server" || initial.server) &&
      (section.id !== "shared-access" || hasShared)
  )
  return (
    <Page title={initial.shell.title}>
      <section
        aria-label="Signed in"
        className="glass flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card px-5 py-4"
      >
        <span aria-hidden="true" className="brand-orb size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold tracking-tight">{initial.account.name}</p>
          <p className="truncate text-sm text-muted-foreground">{initial.account.email}</p>
        </div>
        {host ? (
          <Badge tone="mint" variant="hairline" mono title="This server">
            {host}
          </Badge>
        ) : null}
      </section>

      <IndexedSections label="Account sections" sections={sections}>
        <Section id="computers" title="Computers" description="The computers and servers that report to you, and the agents set up on each.">
          <DevicesSection accountId={initial.shell.account.id} scope="computers" />
        </Section>

        <Section id="security" title="Security">
          <div className="grid gap-4">
            <section id="devices" aria-labelledby="account-devices" className="grid scroll-mt-6 gap-3">
              <div>
                <h3 id="account-devices" className="text-[17px] font-semibold tracking-tight">Devices</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Your phones and browsers, and what each one can read.
                </p>
              </div>
              <DevicesSection accountId={initial.shell.account.id} />
            </section>
            <EncryptionPolicyCard />
            <TwoFactorCard />
          </div>
        </Section>

        <Section id="command-line" title="Command line (advanced)">
          <Card id="connect-cli">
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5">
                <IconTile icon={Terminal} tone="violet" />
                Install without a code
              </CardTitle>
              <CardDescription>
                For advanced use. For a new computer, start with Connect a computer (Computers → Add a computer):
                one command with no sign-in, and it sets up the agents too. This is the install without a code: it
                installs the CLI from this server, then runs relo auth login, which shows a code to approve here or
                on your iPhone.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <Label htmlFor="cli-login-command">Install and sign in</Label>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  ref={cliCommandInput}
                  id="cli-login-command"
                  value={cliLoginCommand}
                  readOnly
                  spellCheck={false}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyButton
                  value={cliLoginCommand}
                  label="Copy command"
                  variant="default"
                  announce={false}
                  onCopied={() => setCliCopyStatus("Login command copied.")}
                  onFailed={cliCopyFailed}
                />
              </div>
              <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
                {cliCopyStatus}
              </p>
            </CardContent>
          </Card>
        </Section>

        {initial.server ? (
          <Section id="server" title="Server">
            <ServerAdminCard initial={initial.server} service={service} />
          </Section>
        ) : null}

        {hasShared ? (
          <Section
            id="shared-access"
            title="Shared access"
            description="These people were added to your account before accounts became separate, so they see your data. Disable them, revoke their sessions and phones, or set a replacement password. New people get their own account."
          >
            <div className="grid gap-3">
              <List label="People with shared access" items={users} getKey={(user) => user.id}>
                {(user) => (
                  <Row
                    wrap
                    title={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {user.name}
                        <Badge tone="neutral" variant="hairline">{user.role}</Badge>
                        {user.disabled ? <Badge tone="red">Disabled</Badge> : null}
                      </span>
                    }
                    meta={`${user.email} · ${user.sessions} session${user.sessions === 1 ? "" : "s"} · ${user.devices} phone${user.devices === 1 ? "" : "s"}`}
                  >
                    <div className="flex flex-wrap gap-2 px-4 pb-3.5">
                      <form
                        className="flex gap-2"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const value = new FormData(event.currentTarget).get("newPassword")
                          void userAction(user.id, "reset", String(value ?? ""))
                          event.currentTarget.reset()
                        }}
                      >
                        <Input name="newPassword" type="password" minLength={8} maxLength={128} required placeholder="New password" aria-label={`New password for ${user.name}`} className="w-40" />
                        <Button type="submit" variant="outline">Reset</Button>
                      </form>
                      <Button variant="outline" onClick={() => void userAction(user.id, "revoke")}>Revoke access</Button>
                      {user.role !== "owner" ? (
                        <Button variant={user.disabled ? "outline" : "destructive"} onClick={() => void userAction(user.id, "toggle")}>
                          {user.disabled ? "Enable" : "Disable"}
                        </Button>
                      ) : null}
                    </div>
                  </Row>
                )}
              </List>
              <OperationStatus state={userState} pendingLabel="" />
            </div>
          </Section>
        ) : null}

        <Section id="preferences" title="Preferences">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Card appearance</CardTitle>
                <CardDescription>
                  Computers and webhooks use these unless you change them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ColorAppearance
                  inheritLabel="Use the Relo default"
                  initialPolicy={initial.account.liveActivityPolicy}
                  initialSource={initial.account.liveActivityPolicySource}
                  canInherit
                  onSave={(policy) => service.saveLiveActivityPolicy(policy)}
                  onReset={() => service.resetLiveActivityPolicy()}
                />
              </CardContent>
            </Card>
            <SoundCard />
          </div>
        </Section>

        <Section id="sign-in" title="Sign-in">
          <div className="grid gap-4">
            <Card>
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
                  <Label className="min-h-9 w-fit cursor-pointer gap-3 pr-3 pointer-coarse:min-h-11">
                    <input
                      name="revokeOtherSessions"
                      type="checkbox"
                      className="size-5 accent-primary"
                      defaultChecked
                    />
                    <span>Sign out other sessions</span>
                  </Label>
                  <CardFooter
                    meta={<OperationStatus state={passwordState} pendingLabel="" />}
                    actions={
                      <ActionButton
                        type="submit"
                        phase={passwordState.status}
                        pendingLabel="Changing password…"
                        successLabel="Changed"
                      >
                        Change password
                      </ActionButton>
                    }
                  />
                </form>
                <Notice variant="quiet" tone="neutral" icon={<Info />}>
                  Email reset is intentionally unavailable. A protected Relo server
                  recovery command can replace the owner password and revoke every
                  active session; see the operations guide.
                </Notice>
              </CardContent>
            </Card>
            <SignOutRow />
          </div>
        </Section>

        <Section id="danger-zone" title="Danger zone">
          <Card className="border-destructive/40">
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
                <CardFooter
                  meta={<OperationStatus state={deletionState} pendingLabel="" />}
                  actions={
                    <ActionButton
                      type="submit"
                      variant="destructive"
                      phase={deletionState.status}
                      pendingLabel="Deleting account…"
                      successLabel={null}
                    >
                      Delete account
                    </ActionButton>
                  }
                />
              </form>
            </CardContent>
          </Card>
        </Section>
      </IndexedSections>

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
              disabled={deletionState.status === "pending"}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
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
