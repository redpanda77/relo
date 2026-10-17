/**
 * The "Built for how agents actually work" diagrams: each card shows its mechanism, not a picture of
 * it. Pure markup and CSS loops (landing.css, "Feature diagrams"): they run only while their card is
 * on screen, and under reduced motion every diagram rests on its settled frame.
 */

import { Bot, Check, Clock, GitBranch, Globe, KeyRound, Laptop, Lock, Monitor, Server, Smartphone, Terminal, Webhook, X } from "lucide-react"
import type * as React from "react"

import { BrandOrb } from "@/components/brand"

export type FeatureVisual =
  | "apps"
  | "sessions"
  | "approval"
  | "desk"
  | "plan"
  | "sources"
  | "seal"
  | "transit"
  | "devices"
  | "expiry"

export function FeatureViz({ kind }: { kind: FeatureVisual }) {
  const Diagram = diagrams[kind]
  return (
    <div className={`fv fv-${kind}`} aria-hidden="true">
      <Diagram />
    </div>
  )
}

/** A packet riding a trace; `delay` is its start as a share of the card's loop. */
function Packet({ delay, back = false, tone }: { delay: number; back?: boolean; tone?: string }) {
  return (
    <i
      className={back ? "fv-packet fv-packet-back" : "fv-packet"}
      style={{ "--at": delay, ...(tone ? { "--c": tone } : {}) } as React.CSSProperties}
    />
  )
}

/** Your app asks over HTTP, the phone answers, a signed callback carries the answer back. */
function AppsDiagram() {
  return (
    <>
      <div className="fv-apps-row">
        <div className="fv-node" data-node="app">
          <span className="fv-node-icon"><Globe className="size-3.5" /></span>
          <span className="fv-node-text"><b><span className="fv-wide">Your app</span><span className="fv-narrow">App</span></b><small>signup-81</small></span>
          <span className="fv-node-ok"><Check className="size-3" strokeWidth={3} /> 200</span>
        </div>
        <div className="fv-trace"><Packet delay={0.06} /></div>
        <div className="fv-node fv-node-hub">
          <BrandOrb className="size-5" />
          <span className="fv-node-text"><b>Relo</b><small>holds it</small></span>
        </div>
        <div className="fv-trace"><Packet delay={0.2} /></div>
        <div className="fv-node fv-ask">
          <span className="fv-ask-title"><Smartphone className="size-3" /> New sign-up?</span>
          <span className="fv-ask-buttons">
            <span>No</span>
            <span className="fv-ask-yes"><span className="fv-ask-label">Approve</span><span className="fv-ask-done"><Check className="size-2.5" strokeWidth={3} /> Yes</span></span>
          </span>
          <i className="fv-tap" />
        </div>
      </div>
      <div className="fv-return">
        <div className="fv-trace fv-trace-mint"><Packet delay={0.55} back tone="52 211 153" /></div>
        <span className="fv-return-label">signed callback</span>
      </div>
      <div className="fv-log">
        <span className="fv-log-line fv-log-out"><em>›</em> POST /api/interactions <span>kind: "approval"</span></span>
        <span className="fv-log-line fv-log-in"><em className="ok">‹</em> callback <span>action: "approve" · Relo-Signature ✓</span></span>
      </div>
    </>
  )
}

const sessions = [
  { harness: "Claude Code", project: "web", state: "working", tool: "Bash" },
  { harness: "Gemini CLI", project: "api", state: "waiting", tool: "" },
  { harness: "Claude Code", project: "docs", state: "working", tool: "Edit" },
  { harness: "Gemini CLI", project: "infra", state: "idle", tool: "" },
] as const

const sessionLabel = { working: "Working", waiting: "Waiting on you", idle: "Idle" } as const

/** Hook events stream past for working sessions; a waiting one stops and calls for you. */
function SessionsDiagram() {
  return (
    <ul className="fv-session-list">
      {sessions.map(({ harness, project, state, tool }) => (
        <li key={project} data-state={state}>
          <span className="fv-session-name"><i />{harness}<small>{project}</small></span>
          <span className="fv-session-track">{tool ? <span className="fv-session-tool">{tool}</span> : null}</span>
          <span className="fv-session-state">{sessionLabel[state]}</span>
        </li>
      ))}
    </ul>
  )
}

/** Two answers reach the check: the phone's signature passes, anything else is refused. */
function ApprovalDiagram() {
  return (
    <>
      <div className="fv-sign-payload">
        <span>approve · deploy to production</span>
      </div>
      <div className="fv-lane" data-lane="phone">
        <span className="fv-lane-from"><span className="fv-lane-icon"><KeyRound className="size-3" /></span>Your iPhone<small>Secure Enclave key</small></span>
        <div className="fv-lane-path">
          <div className="fv-trace fv-trace-mint"><Packet delay={0.04} tone="52 211 153" /></div>
          <span className="fv-verdict fv-verdict-ok"><Check className="size-3" strokeWidth={3} /> Signed</span>
        </div>
      </div>
      <div className="fv-lane" data-lane="other">
        <span className="fv-lane-from"><span className="fv-lane-icon"><Bot className="size-3" /></span>Anyone else<small>agent, server, script</small></span>
        <div className="fv-lane-path">
          <div className="fv-trace fv-trace-red"><Packet delay={0.5} tone="244 63 94" /></div>
          <span className="fv-verdict fv-verdict-no"><X className="size-3" strokeWidth={3} /> Refused</span>
        </div>
      </div>
      <div className="fv-sig">ecdsa-p256 · 3045·0221·00c8·9f1e·…</div>
    </>
  )
}

function DeskCard() {
  return (
    <span className="fv-mini-card">
      <b>Deploy · api</b>
      <span className="fv-mini-bar"><span /></span>
      <small>Migrating</small>
    </span>
  )
}

/** The phone signs a browser in; from then on both show the same live card. */
function DeskDiagram() {
  return (
    <>
      <div className="fv-desk-phone">
        <span className="fv-desk-island" />
        <DeskCard />
      </div>
      <div className="fv-desk-link">
        <div className="fv-trace"><Packet delay={0} /><Packet delay={0.5} back /></div>
        <span>linked · signed</span>
      </div>
      <div className="fv-desk-browser">
        <span className="fv-desk-chrome"><i /><i /><i /></span>
        <DeskCard />
        <span className="fv-desk-rows"><i /><i /></span>
      </div>
    </>
  )
}

const planSteps = [
  { text: "Reproduce the bug", state: "done" },
  { text: "Find the cause", state: "done" },
  { text: "Fix the race", state: "done" },
  { text: "Add a regression test", state: "now", added: true },
  { text: "Run the full suite", state: "next" },
] as const

/** Steps tick by, the agent adds one it just realised it needs, the plan carries on (landing-motion). */
function PlanDiagram() {
  return (
    <div className="fv-plan-wrap" data-plan>
      <ol className="fv-plan-list">
        {planSteps.map(({ text, state, ...rest }) => (
          <li key={text} className="fv-plan-step" data-plan-step data-state={state} data-plan-added={"added" in rest || undefined}>
            <span className="fv-plan-row">
              <i><Check className="size-2.5" strokeWidth={3.5} /></i>
              <span>{text}</span>
              {"added" in rest ? <em>added</em> : null}
            </span>
          </li>
        ))}
      </ol>
      <span className="fv-plan-eta"><Clock className="size-3" /><span data-plan-eta>About 2 min left</span></span>
    </div>
  )
}

const sources = [
  { icon: Clock, label: "cron · 0 2 * * *", event: "Nightly backup finished", tone: "52 211 153" },
  { icon: GitBranch, label: "GitHub Actions", event: "Deploy main · passed", tone: "92 225 255" },
  { icon: Webhook, label: "webhook", event: "Payment retry · 3 failed", tone: "255 138 61" },
  { icon: Terminal, label: "curl /api/…/works", event: "Import · 812 of 1,000", tone: "139 124 255" },
] as const

/** Scripts, pipelines and webhooks send only their changes; they land on one timeline. */
function SourcesDiagram() {
  return (
    <>
      <ul className="fv-src-list">
        {sources.map(({ icon: Icon, label, tone }, index) => (
          <li key={label} style={{ "--c": tone } as React.CSSProperties}>
            <span className="fv-src-chip"><Icon className="size-3" /><span>{label}</span></span>
            <div className="fv-trace"><Packet delay={0.04 + index * 0.2} /></div>
          </li>
        ))}
      </ul>
      <div className="fv-src-bus" />
      <div className="fv-src-timeline">
        <span className="fv-src-head"><BrandOrb className="size-3.5" /> One timeline <small>changes only</small></span>
        <ol>
          {sources.map(({ event, tone }, index) => (
            <li key={event} className={`fv-src-event fv-src-${index + 1}`} style={{ "--c": tone } as React.CSSProperties}>
              <i /><span>{event}</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

const CIPHER = "9f3a·c41e·77b0·e2d9·05aa·1b6f·d83c·4e21"

/** A one-line message that turns between plain text and ciphertext under a scan line, in a fixed box. */
function SealedLine({ plain, cipher = CIPHER, opens = false }: { plain: string; cipher?: string; opens?: boolean }) {
  return (
    <span className={opens ? "fv-msg fv-msg-open" : "fv-msg"}>
      <span className="fv-msg-plain">{plain}</span>
      <span className="fv-msg-cipher">{cipher}</span>
      <i className="fv-msg-scan" />
    </span>
  )
}

/** Privacy 1: what the agent writes is sealed before it leaves the computer. */
function SealDiagram() {
  return (
    <>
      <span className="fv-tag"><Laptop className="size-3" /> Your computer · Claude Code</span>
      <SealedLine plain="Migration finished · 0 errors" />
      <span className="fv-seal-meta">
        <span className="fv-seal-lock"><Lock className="size-3" /> Sealed</span>
        <span>HPKE · P-256 · AES-256-GCM</span>
      </span>
    </>
  )
}

/** Privacy 2: the server stores and delivers, and only ever sees ciphertext. */
function TransitDiagram() {
  return (
    <>
      <span className="fv-end"><Laptop className="size-3.5" /></span>
      <div className="fv-trace fv-trace-mint"><Packet delay={0.05} tone="52 211 153" /><Packet delay={0.55} tone="52 211 153" /></div>
      <div className="fv-server">
        <span className="fv-server-head"><Server className="size-3" /> Your server sees</span>
        <span className="fv-server-feed">
          <span>
            {["9f3a·c41e·77b0·e2d9", "05aa·1b6f·d83c·4e21", "b7e0·3c9a·f412·6d05", "e81c·0a4f·9b27·c3d6", "9f3a·c41e·77b0·e2d9", "05aa·1b6f·d83c·4e21", "b7e0·3c9a·f412·6d05", "e81c·0a4f·9b27·c3d6"].map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </span>
        </span>
      </div>
      <div className="fv-trace fv-trace-mint"><Packet delay={0.3} tone="52 211 153" /><Packet delay={0.8} tone="52 211 153" /></div>
      <span className="fv-end"><Smartphone className="size-3.5" /></span>
    </>
  )
}

const deviceRows = [
  { icon: Smartphone, label: "Your iPhone", key: true },
  { icon: Monitor, label: "Linked browser", key: true },
  { icon: Bot, label: "Anyone else", key: false },
] as const

/** Privacy 3: only the owner's devices hold a key; the same message stays sealed for anyone else. */
function DevicesDiagram() {
  return (
    <ul className="fv-device-list">
      {deviceRows.map(({ icon: Icon, label, key }) => (
        <li key={label} data-key={key || undefined}>
          <span className="fv-device"><Icon className="size-3" />{label}</span>
          <span className="fv-device-key">{key ? <KeyRound className="size-3" /> : <Lock className="size-3" />}</span>
          {key ? <SealedLine plain="Build passed · 412 tests" opens /> : <span className="fv-msg fv-msg-locked"><span>{CIPHER}</span></span>}
        </li>
      ))}
    </ul>
  )
}

/** Privacy 4: keys rotate every 10 hours and items are wiped after hours, so nothing lasts. */
function ExpiryDiagram() {
  return (
    <>
      <span className="fv-tag"><KeyRound className="size-3" /> A new key every 10 hours</span>
      <span className="fv-keys">
        {["0 h", "10 h", "20 h"].map((at, index) => (
          <span key={at} className={`fv-key fv-key-${index + 1}`}><i />{at}</span>
        ))}
      </span>
      <span className="fv-item">
        <span className="fv-item-text">Deploy finished · api</span>
        <span className="fv-item-gone">Wiped</span>
        <span className="fv-item-life"><span /></span>
      </span>
    </>
  )
}

const diagrams: Record<FeatureVisual, () => React.JSX.Element> = {
  apps: AppsDiagram,
  sessions: SessionsDiagram,
  approval: ApprovalDiagram,
  desk: DeskDiagram,
  plan: PlanDiagram,
  sources: SourcesDiagram,
  seal: SealDiagram,
  transit: TransitDiagram,
  devices: DevicesDiagram,
  expiry: ExpiryDiagram,
}
