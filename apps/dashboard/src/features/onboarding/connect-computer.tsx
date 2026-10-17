import type { ComputerInviteStatus } from "@relo/notification-contracts"
import { Check, Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { CopyButton } from "@/components/molecules/copy-button"
import { Notice } from "@/components/molecules/notice"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { connectNowLive } from "@/features/inbox/use-now-live"
import { toolLabel } from "@/components/atoms/source-logo"
import { currentBrowserLink, type BrowserLink } from "@/lib/e2ee/browser-link"
import {
  createHttpConnectService,
  AGENT_STALL_MS,
  STATUS_POLL_MS,
  agentPrompt,
  bindingMatches,
  lastInvite,
  madeInvite,
  newBind,
  withBind,
  rememberInvite,
  rememberMade,
  SETUP_AGENTS,
  type ComputerInvite,
  type ConnectService,
} from "@/features/onboarding/connect-service"

const httpService = createHttpConnectService()

const LEVELS = [
  { value: "notify", label: "Notify", help: "Questions and notifications only." },
  { value: "track", label: "Track", help: "Live cards with plans. Recommended." },
  { value: "guide", label: "Guide", help: "Track, plus sessions and continuity." },
  { value: "optimize", label: "Optimize", help: "Guide, with lean context." },
]

const AGENT_NAMES: Record<string, string> = {
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  amp: "Amp",
}
const agentName = (id: string) => AGENT_NAMES[id] ?? toolLabel(id)

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** "abcd efgh", "ABCD-EFGH" or "abcdefgh" -> "ABCD-EFGH"; null unless it holds exactly 8 letters or digits. */
export function normalizeUserCode(raw: string): string | null {
  const clean = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null
}

type Way = "command" | "agent" | "code"
type Stage = "how" | "code" | "agents" | "test" | "apps"
const STAGES: Stage[] = ["how", "code", "agents", "test", "apps"]
const TITLES: Record<Stage, string> = {
  how: "Connect a computer",
  code: "Run it on your computer",
  agents: "Your agents",
  test: "Send a test",
  apps: "Get the apps",
}

const TEST_COMMAND = 'relo notify "Relo is set up"'

function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="grid gap-2">
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-[13px] leading-relaxed"><code>{text}</code></pre>
      <CopyButton value={text} label={label} variant="default" className="min-h-11 w-full sm:w-auto sm:justify-self-start" />
    </div>
  )
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-[15px]">
      <Check className="mt-0.5 size-4 shrink-0 text-[var(--neon-mint)]" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[15px] text-muted-foreground" role="status">
      <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function FailingChecks({ status }: { status: ComputerInviteStatus | null }) {
  const check = status?.computer?.check
  if (!check || check.ok) return null
  return (
    <Notice tone="yellow" title="Its self-check found a problem">
      {check.failing.length ? `Failing: ${check.failing.join(", ")}.` : "A check failed."} Run <code>relo doctor</code> on that computer to see why.
    </Notice>
  )
}

/** The computer joined after a phone existed: its notifications stay locked on the phone until a device approves it. */
function ApprovalLine({ name }: { name: string }) {
  return (
    <Notice tone="yellow" variant="quiet" title={`Approve ${name} on your iPhone`}>
      Approve {name} on your iPhone. Until then its notifications stay locked there.
    </Notice>
  )
}

function KeyCheckLine({ result }: { result: "approved" | "mismatch" | "not_linked" | null }) {
  if (result === "approved") return <Done>Approved on this browser — your devices can read what it sends</Done>
  if (result === "mismatch") {
    return <Notice tone="yellow" title="This computer's key doesn't match the code">This computer's key doesn't match the code. It was not approved.</Notice>
  }
  if (result === "not_linked") {
    return <Notice tone="neutral" variant="quiet" title="Your iPhone will ask to approve this computer">Link this browser to approve computers here.</Notice>
  }
  return null
}

function Wizard({
  service,
  resumeId,
  fallbackMs,
  pollMs,
  link,
  navigate,
  onClose,
}: {
  navigate: (url: string) => void
  service: ConnectService
  link?: BrowserLink | null
  resumeId: string | null
  fallbackMs: number
  pollMs: number
  onClose: (finished: boolean) => void
}) {
  // A code this tab made still has its command and binding in memory: resuming reopens on it.
  const resumed = useRef(madeInvite(resumeId)).current
  const [chosen, setStage] = useState<Stage>(resumeId ? "code" : "how")
  const [way, setWay] = useState<Way>(resumed?.way ?? "command")
  const [level, setLevel] = useState(resumed?.level ?? "track")
  const [approvals, setApprovals] = useState(resumed?.approvals ?? false)
  const [pickAgents, setPickAgents] = useState(resumed?.agents != null)
  const [picked, setPicked] = useState<string[]>(resumed?.agents ?? [])
  const [typedCode, setTypedCode] = useState("")
  const [invite, setInvite] = useState<ComputerInvite | null>(resumed?.invite ?? null)
  const [prompt, setPrompt] = useState<string | null>(resumed?.prompt ?? null)
  const [inviteId, setInviteId] = useState<string | null>(resumeId)
  const [status, setStatus] = useState<ComputerInviteStatus | null>(null)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [stalled, setStalled] = useState(false)
  const [showCommand, setShowCommand] = useState(false)
  const [phone, setPhone] = useState<boolean | null>(null)
  // The binding half of the code lives in this wizard's memory only: after a reload nothing can vouch for the key.
  const bindRef = useRef<string | null>(resumed?.bind ?? null)
  const [keyCheck, setKeyCheck] = useState<"approved" | "mismatch" | "not_linked" | null>(null)
  const checkedKey = useRef<string | null>(null)

  const state = status?.state
  // The computer reported: on to its agents. A resumed wizard picks up wherever the computer got to.
  const stage: Stage = chosen === "code" && (state === "reported" || state === "tested") ? "agents" : chosen
  const expired = gone || state === "expired"
  const settled = expired || state === "tested"

  const refetch = useCallback(async () => {
    if (!inviteId) return
    try {
      const next = await service.status(inviteId)
      if (next) setStatus(next)
      else setGone(true)
    } catch { /* the next hint or poll tries again */ }
  }, [inviteId, service])

  // Read the status at once, on every hint from the live stream, and on a slow poll as the fallback.
  useEffect(() => {
    if (!inviteId || settled) return
    const first = window.setTimeout(() => void refetch(), 0)
    const stop = connectNowLive(() => void refetch())
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refetch() }, pollMs)
    return () => { window.clearTimeout(first); stop(); window.clearInterval(timer) }
  }, [inviteId, settled, refetch, pollMs])

  useEffect(() => { if (state === "tested") rememberInvite(null) }, [state])

  // The computer's key is approved here only when its binding proves the code's holder published it.
  const clientId = status?.computer?.clientId
  const identityKey = status?.computer?.identityKey
  const binding = status?.computer?.binding
  useEffect(() => {
    const bind = bindRef.current
    if (!bind || !clientId || !identityKey || !binding) return
    const marker = `${clientId}|${identityKey}|${binding}`
    if (checkedKey.current === marker) return
    checkedKey.current = marker
    void (async () => {
      try {
        if (!(await bindingMatches(bind, clientId, identityKey, binding))) { setKeyCheck("mismatch"); return }
        const browser = link === undefined ? currentBrowserLink() : link
        const result = browser ? await browser.approveBoundComputer(clientId, identityKey) : "not_linked"
        if (result === "failed") checkedKey.current = null
        else {
          setKeyCheck(result)
          // The approval was signed here: read the status now instead of waiting for the next hint.
          if (result === "approved") void refetch()
        }
      } catch { checkedKey.current = null }
    })()
  }, [clientId, identityKey, binding, link, refetch])

  // A computer that reported nothing yet stays on the code screen with its progress.
  useEffect(() => {
    if (stage !== "code" || way !== "agent" || state !== "waiting" || !invite) return
    const timer = window.setTimeout(() => setStalled(true), fallbackMs)
    return () => window.clearTimeout(timer)
  }, [stage, way, state, invite, fallbackMs])

  useEffect(() => {
    if (stage !== "test") return
    let active = true
    void service.hasPhone().then((value) => { if (active) setPhone(value) }, () => undefined)
    return () => { active = false }
  }, [stage, service])

  async function makeCode() {
    setBusy(true)
    setError("")
    try {
      const bind = newBind()
      const agents = pickAgents && picked.length ? SETUP_AGENTS.filter((id) => picked.includes(id)) : undefined
      const made = withBind(await service.invite({ level, approvals, ...(agents ? { agents } : {}) }), bind)
      const madePrompt = agentPrompt(window.location.origin, made.code, level)
      bindRef.current = bind
      checkedKey.current = null
      setKeyCheck(null)
      rememberInvite(made.inviteId)
      rememberMade({ invite: made, prompt: madePrompt, bind, way: way === "agent" ? "agent" : "command", level, approvals, agents: agents ?? null })
      setInvite(made)
      setPrompt(madePrompt)
      setInviteId(made.inviteId)
      setStatus(null)
      setGone(false)
      setStalled(false)
      setShowCommand(false)
      setStage("code")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The command could not be made.")
    } finally {
      setBusy(false)
    }
  }

  function submitCode() {
    const code = normalizeUserCode(typedCode)
    if (code) navigate(`/cli/authorize?code=${encodeURIComponent(code)}`)
  }

  const computer = status?.computer ?? null
  // Locked on the phone until approved. Not while this browser is signing the approval right now.
  const checking = keyCheck === null && !!bindRef.current && !!identityKey && !!binding
  const approvalWaiting = computer?.approval === "waiting" && keyCheck !== "approved" && !checking
  const restartNames = (computer?.harnesses ?? []).filter((item) => item.detected && item.level !== "none").map((item) => agentName(item.id))
  const stepNumber = STAGES.indexOf(stage) + 1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="grid gap-1 pr-8">
        <p className="micro" aria-hidden="true">Step {stepNumber} of {STAGES.length}</p>
        <DialogTitle className="text-xl font-semibold tracking-tight">{TITLES[stage]}</DialogTitle>
        <DialogDescription className="sr-only">Connect a computer to your Relo account in {STAGES.length} steps.</DialogDescription>
      </header>

      <div className="mt-4 grid min-h-0 flex-1 content-start gap-4 overflow-y-auto pb-2">
        {stage === "how" ? (
          <>
            <fieldset className="grid gap-2">
              <legend className="sr-only">Who runs it</legend>
              {([
                ["command", "I'll run a command", "Paste one line into a terminal on the computer."],
                ["agent", "Let my agent do it", "Paste one message into Claude Code, Codex, OpenCode or another agent on the computer."],
                ["code", "My computer shows a code", "Use this when the computer ran relo auth login and shows a code."],
              ] as const).map(([value, title, help]) => (
                <label key={value} className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 has-[:checked]:border-[var(--neon-violet,currentColor)] has-[:checked]:bg-muted/50">
                  <input type="radio" name="connect-way" className="mt-1" checked={way === value} onChange={() => setWay(value)} />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{title}</span>
                    <span className="text-sm text-muted-foreground">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {way === "code" ? (
              <div className="grid gap-2">
                <Label htmlFor="connect-user-code">Code on the computer</Label>
                <Input
                  id="connect-user-code"
                  value={typedCode}
                  onChange={(event) => setTypedCode(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") submitCode() }}
                  placeholder="ABCD-EFGH"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={16}
                  className="min-h-11 max-w-48 font-mono tracking-widest"
                />
                <p className="text-sm text-muted-foreground">Use this when the computer ran <code>relo auth login</code> and shows a code.</p>
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="connect-level">How much Relo does there</Label>
                  <NativeSelect id="connect-level" value={level} onChange={(event) => setLevel(event.target.value)} className="min-h-11">
                    {LEVELS.map((item) => <NativeSelectOption key={item.value} value={item.value}>{item.label}: {item.help}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                <details className="group rounded-xl border border-border p-3.5">
                  <summary className="min-h-6 cursor-pointer font-medium">Options</summary>
                  <div className="mt-3 grid gap-4">
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                      <input type="checkbox" checked={approvals} onChange={(event) => setApprovals(event.target.checked)} />
                      Ask permission on my iPhone too
                    </label>
                    <fieldset className="grid gap-2">
                      <legend className="mb-1 text-sm font-medium">Agents to set up</legend>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                        <input type="radio" name="connect-agents" checked={!pickAgents} onChange={() => setPickAgents(false)} />
                        Every agent it finds
                      </label>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                        <input type="radio" name="connect-agents" checked={pickAgents} onChange={() => setPickAgents(true)} />
                        Only the ones I pick
                      </label>
                      {pickAgents ? (
                        <div className="grid grid-cols-1 gap-1 pl-7 min-[420px]:grid-cols-2">
                          {SETUP_AGENTS.map((id) => (
                            <label key={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                              <input
                                type="checkbox"
                                checked={picked.includes(id)}
                                onChange={(event) => setPicked((now) => event.target.checked ? [...now, id] : now.filter((item) => item !== id))}
                              />
                              {agentName(id)}
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </fieldset>
                  </div>
                </details>
              </>
            )}
            <OperationStatus error={error || null} />
          </>
        ) : null}

        {stage === "code" ? (
          <>
            {invite && !expired && (way === "command" || showCommand) ? (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">Paste this into a terminal on the computer. It works once, for 30 minutes.</p>
                <CopyLine text={invite.command} label="Copy command" />
              </div>
            ) : null}
            {invite && !expired && way === "agent" && !showCommand ? (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">
                  Paste this into your agent on that computer. It may ask your permission to run the command; allow it.
                </p>
                <CopyLine text={prompt ?? agentPrompt(window.location.origin, invite.code, level)} label="Copy prompt" />
              </div>
            ) : null}
            {invite && !expired && way === "agent" && stalled && !showCommand && !computer ? (
              <Notice tone="neutral" variant="quiet" title="Your agent has not picked it up yet"
                action={<Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setShowCommand(true)}>Run it yourself instead</Button>}>
                Same code, one line in a terminal.
              </Notice>
            ) : null}
            {expired ? (
              <Notice tone="yellow" title="Code expired" action={
                <Button type="button" size="sm" className="min-h-11" disabled={busy} onClick={() => void makeCode()}>New command</Button>
              }>
                A code works once, for 30 minutes.
              </Notice>
            ) : computer ? (
              <Done><b>{computer.name}</b> connected{computer.cliVersion ? ` · CLI ${computer.cliVersion}` : ""}</Done>
            ) : (
              <Waiting>Waiting for your computer…</Waiting>
            )}
            {computer && !expired ? <Waiting>Setting up its agents…</Waiting> : null}
            {computer && approvalWaiting ? <ApprovalLine name={computer.name} /> : null}
            <KeyCheckLine result={keyCheck} />
            <FailingChecks status={status} />
            <OperationStatus error={error || null} />
          </>
        ) : null}

        {stage === "agents" ? (
          <>
            {computer ? <Done><b>{computer.name}</b> connected{computer.cliVersion ? ` · CLI ${computer.cliVersion}` : ""}</Done> : null}
            {computer && approvalWaiting ? <ApprovalLine name={computer.name} /> : null}
            <KeyCheckLine result={keyCheck} />
            {computer?.harnesses.some((item) => item.detected) ? (
              <ul className="grid gap-3">
                {computer.harnesses.filter((item) => item.detected).map((item) => item.level !== "none" ? (
                  <li key={item.id}><Done>{agentName(item.id)} connected ({item.level})</Done></li>
                ) : (
                  <li key={item.id} className="grid gap-2">
                    <p className="text-[15px]">{agentName(item.id)} found, not connected</p>
                    <CopyLine text={`relo setup --agent ${item.id}`} label="Copy command" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[15px] text-muted-foreground">
                No agents found here. Relo works with Claude Code, Codex, OpenCode, Gemini CLI, Cursor and GitHub Copilot, and scripts can use <code>relo notify</code>.
              </p>
            )}
            {computer && restartNames.length ? (
              <p className="text-sm text-muted-foreground">
                Restart {joinNames(restartNames)} on {computer.name} so they load Relo. Sessions already open don't see it until then.
              </p>
            ) : null}
            <FailingChecks status={status} />
          </>
        ) : null}

        {stage === "test" ? (
          <>
            {state === "tested" ? (
              <Done>
                First notification sent
                {phone === false ? "" : approvalWaiting && computer ? `. It opens on your iPhone once you approve ${computer.name}.` : ". Look at your iPhone."}
              </Done>
            ) : (
              <>
                {phone === false ? null : (
                  <div className="grid gap-2">
                    <Waiting>Your computer sends a first notification when it finishes setting up…</Waiting>
                    <p className="text-sm text-muted-foreground">Nothing after a minute? Send one from that computer:</p>
                    <CopyLine text={TEST_COMMAND} label="Copy command" />
                  </div>
                )}
              </>
            )}
            {phone !== false && computer && approvalWaiting ? <ApprovalLine name={computer.name} /> : null}
            {phone === false ? (
              <Notice tone="neutral" variant="quiet" title="Install the iPhone app to see it">
                Notifications, questions and cards show on your Lock Screen. You can finish the setup without it.
              </Notice>
            ) : null}
            <FailingChecks status={status} />
          </>
        ) : null}

        {stage === "apps" ? (
          <ul className="grid gap-3 text-[15px]">
            <li><b>Relo for iPhone</b> shows your cards on the Lock Screen and asks you before anything risky.</li>
            <li><b>Relo for Mac</b> puts the same status in the notch, always in view.</li>
          </ul>
        ) : null}
      </div>

      <footer className="mt-3 grid gap-2 border-t border-border pt-3 sm:flex sm:justify-end">
        {stage === "how" ? (
          way === "code" ? (
            <Button type="button" className="min-h-12 sm:min-h-9" disabled={!normalizeUserCode(typedCode)} onClick={submitCode}>Open the approval page</Button>
          ) : (
            <Button type="button" className="min-h-12 sm:min-h-9" disabled={busy || (pickAgents && picked.length === 0)} onClick={() => void makeCode()}>
              {busy ? "Making…" : way === "agent" ? "Make the prompt" : "Make the command"}
            </Button>
          )
        ) : null}
        {stage === "code" ? (
          <Button type="button" variant="outline" className="min-h-12 sm:min-h-9" onClick={() => onClose(false)}>Close, keep waiting</Button>
        ) : null}
        {stage === "agents" ? (
          <Button type="button" className="min-h-12 sm:min-h-9" onClick={() => setStage("test")}>
            {computer?.harnesses.some((item) => item.detected && item.level !== "none") ? "Continue" : "Skip"}
          </Button>
        ) : null}
        {stage === "test" ? (
          <Button type="button" variant={state === "tested" ? "default" : "outline"} className="min-h-12 sm:min-h-9" onClick={() => setStage("apps")}>
            {state === "tested" ? "Continue" : "Continue without a test"}
          </Button>
        ) : null}
        {stage === "apps" ? (
          <Button type="button" className="min-h-12 sm:min-h-9" onClick={() => onClose(true)}>Done</Button>
        ) : null}
      </footer>
    </div>
  )
}

/**
 * Connect a computer (plan 13): a full-screen sheet on a phone, a dialog on a desk. The wizard unmounts when it closes,
 * so every open starts clean (or, with `resumeId`, picks up where that computer got to).
 */
export function ConnectComputerDialog({
  open,
  onOpenChange,
  service = httpService,
  resumeId = null,
  fallbackMs = AGENT_STALL_MS,
  pollMs = STATUS_POLL_MS,
  link,
  navigate = (url: string) => window.location.assign(url),
  onFinished,
}: {
  /** Opens a page in this tab (the approval page for "My computer shows a code"); tests pass a spy. */
  navigate?: (url: string) => void
  /** The browser link that signs approvals; defaults to this tab's (tests pass one, or null for unlinked). */
  link?: BrowserLink | null
  open: boolean
  onOpenChange: (open: boolean) => void
  service?: ConnectService
  resumeId?: string | null
  fallbackMs?: number
  pollMs?: number
  /** The owner pressed Done on the last step. */
  onFinished?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          className="flex max-h-dvh flex-col max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:p-5 sm:max-w-lg"
        >
          <Wizard
            service={service}
            resumeId={resumeId}
            fallbackMs={fallbackMs}
            pollMs={pollMs}
            link={link}
            navigate={navigate}
            onClose={(finished) => { onOpenChange(false); if (finished) onFinished?.() }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

/**
 * Settings → Computers: "Add a computer" opens the wizard; a computer whose last code got as far as connecting but not
 * to a test shows "Setup not finished · Resume".
 */
export function AddComputerControl({ service = httpService }: { service?: ConnectService }) {
  const [open, setOpen] = useState(false)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [unfinished, setUnfinished] = useState<{ id: string; name: string | null } | null>(null)

  useEffect(() => {
    const id = lastInvite()
    if (!id) return
    let active = true
    void service.status(id).then((status) => {
      if (!active) return
      if (status?.computer && (status.state === "redeemed" || status.state === "key_published" || status.state === "reported")) {
        setUnfinished({ id, name: status.computer.name })
      } else if (status?.state === "waiting" && madeInvite(id)) {
        // This tab still holds the command: closing the wizard did not lose it.
        setUnfinished({ id, name: null })
      } else rememberInvite(null)
    }, () => undefined)
    return () => { active = false }
  }, [service])

  return (
    <>
      {unfinished ? (
        <Notice tone="yellow" variant="quiet" title={unfinished.name ? `${unfinished.name}: setup not finished` : "A computer is not connected yet"}
          action={<Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => { setResumeId(unfinished.id); setOpen(true) }}>Resume</Button>}>
          {unfinished.name ? "It connected, but the test has not gone through." : "Its command is still waiting to be run."}
        </Notice>
      ) : null}
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground">Another computer or a server, with its agents set up in one step.</p>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => { setResumeId(null); setOpen(true) }}>Add a computer</Button>
      </div>
      <ConnectComputerDialog open={open} onOpenChange={setOpen} service={service} resumeId={resumeId} onFinished={() => setUnfinished(null)} />
    </>
  )
}
