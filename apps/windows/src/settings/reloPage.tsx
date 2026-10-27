// The Relo page (ReloSettingsView.swift `ReloSettingsView`): who this PC is signed in as and how it is connected (from the
// notch's `owner_state` reports), where its cards come from, encryption, and the Updates group. Sign in and Sign out emit
// `settings_sign_in` / `settings_sign_out`, which the notch handles.
import { useEffect, useState } from "react"
import { useLocalState } from "../local/api"
import { LocalGroup, RunHereGroup } from "../local/LocalSettings"
import { INITIAL_STATUS, accountButton, accountLine, approvalLine, displayAddress, isSignedIn, isSignedOut, readOwnerPayload, statusLine, updateCheckLine, type OwnerStatus } from "./account"
import { encryptionDetail, encryptionNote, encryptionTitle } from "@relo/owner-client"
import { appVersion, broadcast, computerName, onEvent, onOwnerPayload, ownerStateGet, updaterCheck, updaterEnabled, updaterInstall, type UpdateCheck } from "./ipc"
import type { ReloSettings, SettingsPatch } from "./store"
import { Btn, Group, Row, Page, Select, ToggleRow } from "./ui"

interface PageProps {
  s: ReloSettings
  set: (patch: SettingsPatch) => void
}

/** The owner's status, now and as the notch reports it. */
function useOwnerStatus(): OwnerStatus {
  const [status, setStatus] = useState<OwnerStatus>(INITIAL_STATUS)
  useEffect(() => {
    let live = true
    const off = onOwnerPayload((raw) => setStatus((cur) => readOwnerPayload(raw, cur, Date.now())))
    void ownerStateGet().then((raw) => raw && live && setStatus((cur) => (cur === INITIAL_STATUS ? readOwnerPayload(raw, cur, Date.now()) : cur)))
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

function Fact({ title, value, mono }: { title: string; value: string; mono?: boolean }) {
  return (
    <Row title={title}>
      <span className={mono ? "mono" : undefined} style={{ userSelect: "text" }}>
        {value}
      </span>
    </Row>
  )
}

/** What the notch reports about the account's encryption policy (`encryption_state`, client/native.ts `EncryptionReport`). */
export interface EncryptionView {
  mode: "on" | "off" | "auto" | null
  phoneTrusted: boolean
  problem: string | null
  busy: boolean
}

/** Pure: a payload from the notch as a view, ignoring anything that is not one. */
export function readEncryptionView(raw: unknown): EncryptionView | null {
  const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null
  if (!p) return null
  const mode = p.mode === "on" || p.mode === "off" || p.mode === "auto" ? p.mode : null
  return { mode, phoneTrusted: p.phoneTrusted === true, problem: typeof p.problem === "string" && p.problem ? p.problem.slice(0, 200) : null, busy: p.busy === true }
}

/**
 * The server's encryption choice (ReloEncryptionGroup): read through the notch, which holds the connection (a request event
 * `settings_encryption`, the answer `encryption_state`). Picking Always or Automatic changes the account on the server; Off is the
 * Dashboard's.
 */
function useEncryption(): EncryptionView {
  const [view, setView] = useState<EncryptionView>({ mode: null, phoneTrusted: false, problem: null, busy: false })
  useEffect(() => {
    const off = onEvent<unknown>("encryption_state", (raw) => setView((cur) => readEncryptionView(raw) ?? cur))
    broadcast("settings_encryption", { action: "refresh" })
    return off
  }, [])
  return view
}

type Choice = "auto" | "on" | "off"

function EncryptionGroup({ approval }: { approval: string | null }) {
  const policy = useEncryption()
  const note = encryptionNote(policy.mode ? { mode: policy.mode, required: policy.mode === "on" } : null, policy.phoneTrusted)
  return (
    <Group title="Encryption">
      <Row title="Encryption" detail={policy.mode ? encryptionDetail(policy.mode) : "Reading the server's choice…"}>
        {policy.mode && (
          <Select<Choice>
            label={`Encryption: ${encryptionTitle(policy.mode)}`}
            value={policy.mode}
            options={[
              ...(policy.mode === "off" ? [{ value: "off" as const, label: "Off" }] : []),
              { value: "auto", label: "Automatic" },
              { value: "on", label: "Always" },
            ]}
            onChange={(choice) => {
              if (policy.busy || choice === "off" || choice === policy.mode) return
              broadcast("settings_encryption", { action: "set", always: choice === "on" })
            }}
          />
        )}
      </Row>
      {note && <p className="warn" style={{ margin: "0 20px 14px" }}>{note}</p>}
      {policy.problem && <p className="warn" style={{ margin: "0 20px 14px" }}>{policy.problem}</p>}
      {approval && <Row title={approval} />}
      <Row title="Turn off in the Dashboard" detail="Turning encryption off needs you signed in there.">
        <Btn onClick={() => broadcast("settings_encryption", { action: "open_security" })}>Open</Btn>
      </Row>
    </Group>
  )
}

function UpdatesGroup({ s, set, local }: PageProps & { local: boolean }) {
  const [version, setVersion] = useState("")
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheck | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  useEffect(() => {
    void appVersion().then(setVersion)
    void updaterEnabled().then(setEnabled)
  }, [])
  const check = async () => {
    setChecking(true)
    setInstallError(null)
    setResult(await updaterCheck())
    setChecking(false)
  }
  const footer =
    enabled === false
      ? "This build does not take updates. Download the latest Relo for Windows."
      : local
        ? "Relo for Windows keeps itself, Relo on this PC and your agents' setup up to date."
        : "Updates come from your Relo server. Off: Relo for Windows asks before it installs one."
  return (
    <Group title="Updates" footer={footer}>
      <Row title="Relo for Windows" detail={result ? (installError ?? updateCheckLine(result)) : version ? `Version ${version}` : undefined}>
        {enabled && result && (result.state === "available" || result.state === "ready") && (
          <Btn primary onClick={() => void updaterInstall().then(setInstallError)}>
            Install and restart
          </Btn>
        )}
        {enabled && (
          <Btn disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check for Updates…"}
          </Btn>
        )}
      </Row>
      {enabled && <ToggleRow title="Install updates automatically" checked={s.autoInstallUpdates} onChange={(autoInstallUpdates) => set({ autoInstallUpdates })} />}
    </Group>
  )
}

export function ReloPage({ s, set }: PageProps) {
  const local = useLocalState()
  const owner = useOwnerStatus()
  const [pc, setPc] = useState("This PC")
  useEffect(() => void computerName().then(setPc), [])
  // An uninstall turns local mode off while its "removed, quit" row is still to be read: that row stays until Relo quits.
  const [removed, setRemoved] = useState(false)

  // Relo runs on this PC: no account, server address or encryption to show; the local group and Updates only.
  if (local.mode || removed) {
    return (
      <Page title="Relo" orb detail="Relo on this PC, your agents, and how it stays current">
        <LocalGroup s={s} set={set} removed={removed} onRemoved={() => setRemoved(true)} />
        <UpdatesGroup s={s} set={set} local />
      </Page>
    )
  }

  // Until the notch has reported, a saved account means "signed in, connecting".
  const c = owner.connection === "starting" && s.accountEmail ? "connecting" : owner.connection
  const button = accountButton(c)
  const signedOut = isSignedOut(c)
  const approval = approvalLine(owner.approval)
  return (
    <Page title="Relo" orb detail="Who this PC is, where its cards go, and how it stays current">
      <div>
        <div className="sheet" style={{ overflow: "hidden" }}>
          <div className="account">
            <div className="avatar" data-live={c === "live" ? "" : undefined} aria-hidden>
              {s.accountEmail ? s.accountEmail[0]!.toUpperCase() : "?"}
            </div>
            <div className="row-text">
              <div className="account-name">{s.accountEmail ?? accountLine(c)}</div>
              <div className="row-detail">{statusLine(c, owner.at)}</div>
            </div>
            <Btn
              primary={button.action === "signIn"}
              disabled={button.action === null || (button.action === "signIn" && !s.serverOrigin)}
              onClick={() => (button.action === "signIn" ? broadcast("settings_sign_in", { origin: s.serverOrigin }) : broadcast("settings_sign_out"))}
            >
              {button.label}
            </Btn>
          </div>
          {owner.problem && <p className="warn" style={{ margin: "0 20px 14px" }}>{owner.problem}</p>}
          <Fact title="Server" value={displayAddress(s.serverOrigin)} mono />
          {!signedOut && <Fact title="This PC" value={pc} />}
        </div>
        {signedOut && <p className="group-foot">Sign in to your Relo account in the browser. If you use an iPhone, approve this PC there to read private work.</p>}
        {isSignedIn(c) && (
          <p className="group-foot">This PC shows your server's cards. To have this PC's agents report there, use Add a computer in your server's Dashboard.</p>
        )}
      </div>
      <RunHereGroup s={s} set={set} />
      {isSignedIn(c) && <EncryptionGroup approval={approval} />}
      <UpdatesGroup s={s} set={set} local={false} />
    </Page>
  )
}
