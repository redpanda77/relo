/**
 * "Stay in control" on the Mac: the notch app's open Relo tab (apps/notch ReloNotchView), beside the
 * phone and on the same chapter. Left, the agents rail: each computer, its harnesses and a dot per
 * session. Right, the sections the server derives: what needs you (answerable right there), what runs,
 * and what finished while you were away.
 */

import { Check, Clock, HardDrive, Laptop, X } from "lucide-react"
import * as React from "react"

import { SourceMark } from "@/components/atoms/source-mark"
import { BrandOrb } from "@/components/brand"

type Dot = "working" | "waiting" | "idle"

const machines: ReadonlyArray<{
  icon: typeof Laptop
  name: string
  summary: string
  harnesses: ReadonlyArray<{ source: string; dots: readonly Dot[] }>
}> = [
  {
    icon: Laptop,
    name: "MacBook Pro",
    summary: "2 working",
    harnesses: [
      { source: "Claude Code", dots: ["working", "idle"] },
      { source: "Codex", dots: ["working"] },
    ],
  },
  { icon: HardDrive, name: "Home server", summary: "1 job", harnesses: [{ source: "Nightly backup", dots: ["working"] }] },
]

function Caption({ title, count, tone }: { title: string; count: number; tone: string }) {
  return (
    <p className="mac-caption">
      {title}
      <span style={{ color: `rgb(${tone})` }}>{count}</span>
    </p>
  )
}

function Row({
  tone,
  title,
  detail,
  progress,
  children,
}: {
  tone: string
  title: string
  detail: string
  progress?: number
  children?: React.ReactNode
}) {
  return (
    <div className="mac-row" style={{ "--n": tone } as React.CSSProperties}>
      <div className="mac-row-head">
        <i />
        <span>
          <b>{title}</b>
          <small>{detail}</small>
        </span>
      </div>
      {progress !== undefined ? (
        <span className="mac-bar">
          <span style={{ width: `${progress}%` }} />
        </span>
      ) : null}
      {children}
    </div>
  )
}

const CYAN = "92 225 255"
const ORANGE = "255 138 61"
const RED = "244 63 94"
const MINT = "52 211 153"

const plan = [
  { step: "Reproduce the flaky test", state: "done" },
  { step: "Find the cause", state: "done" },
  { step: "Fix the race", state: "now" },
  { step: "Run the full suite", state: "next" },
] as const

/** What the notch's list shows for each chapter of "Stay in control". */
function NotchList({ chapter }: { chapter: number }) {
  switch (chapter) {
    case 1:
      return (
        <>
          <Caption title="Needs you" count={1} tone={ORANGE} />
          <Row tone={ORANGE} title="Deploy to production?" detail="Claude Code · api is waiting on you">
            <span className="mac-actions">
              <span>Decline</span>
              <span className="mac-approve">Approve</span>
            </span>
          </Row>
          <Caption title="Stalled" count={1} tone={RED} />
          <Row tone={RED} title="Nightly backup" detail="No progress for 40 minutes · Home server" />
        </>
      )
    case 2:
      return (
        <>
          <Caption title="Running" count={3} tone={CYAN} />
          <Row tone={CYAN} title="Fix the flaky sign-in test" detail="Claude Code · 3 of 4" progress={68}>
            <ol className="mac-plan">
              {plan.map(({ step, state }) => (
                <li key={step} data-state={state}>
                  <i>{state === "done" ? <Check className="size-2" strokeWidth={4} /> : null}</i>
                  {step}
                </li>
              ))}
            </ol>
          </Row>
          <p className="mac-more">+2 more running</p>
        </>
      )
    case 3:
      return (
        <>
          <p className="mac-recap">
            <Clock className="size-2.5" />
            Since you looked: 2 finished, 1 failed
          </p>
          <Caption title="Recent" count={3} tone={MINT} />
          <div className="mac-outcome" data-tone="mint">
            <i><Check className="size-2" strokeWidth={4} /></i>
            <span><b>Fix the flaky sign-in test</b><small>412 of 412 passing · 32 min</small></span>
          </div>
          <div className="mac-outcome" data-tone="red">
            <i><X className="size-2" strokeWidth={4} /></i>
            <span><b>Nightly backup failed</b><small>Disk full on the home server</small></span>
          </div>
          <div className="mac-outcome" data-tone="mint">
            <i><Check className="size-2" strokeWidth={4} /></i>
            <span><b>Weekly report sent</b><small>Codex · 6 min</small></span>
          </div>
        </>
      )
    default:
      return (
        <>
          <Caption title="Running" count={3} tone={CYAN} />
          <Row tone={CYAN} title="Fix the flaky sign-in test" detail="Claude Code · 1 of 4 · Reproduce the flaky test" progress={18} />
          <Row tone={CYAN} title="Weekly report" detail="Codex · Drafting the summary" progress={54} />
          <Row tone={CYAN} title="Nightly backup" detail="Home server · 12 of 40 GB" progress={30} />
        </>
      )
  }
}

export function ControlMac({ chapter }: { chapter: number }) {
  return (
    <div className="mac" aria-hidden="true">
      <div className="mac-lid">
        <div className="mac-screen">
          <div className="mac-menubar">
            <span>
              <b>Code</b> File Edit View
            </span>
            <span className="mac-menubar-right">
              <BrandOrb className="size-2.5" />
              Wed 14 Oct 9:41
            </span>
          </div>
          <div className="mac-notch">
            <div className="mac-notch-tabs">
              <span data-active>
                <BrandOrb className="size-2.5" />
                Relo
              </span>
              <span>Music</span>
              <span>Shelf</span>
            </div>
            <div className="mac-notch-body">
              <div className="mac-rail">
                {machines.map(({ icon: Icon, name, summary, harnesses }) => (
                  <div key={name} className="mac-machine">
                    <div className="mac-machine-head">
                      <Icon className="size-3" />
                      <span>
                        <b>{name}</b>
                        <small>{summary}</small>
                      </span>
                    </div>
                    {harnesses.map(({ source, dots }) => (
                      <div key={source} className="mac-harness">
                        <span className="mac-harness-mark">
                          <SourceMark name={source} size={10} />
                        </span>
                        <span className="mac-harness-name">{source}</span>
                        <span className="mac-dots">
                          {dots.map((dot, index) => (
                            <i key={index} data-dot={dot} />
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div key={chapter} className="mac-list">
                <NotchList chapter={chapter} />
              </div>
            </div>
          </div>
          <div className="mac-window">
            <div className="mac-window-bar">
              <i /> <i /> <i />
            </div>
            <div className="mac-window-lines">
              {[72, 54, 88, 40, 66, 80, 48].map((width, index) => (
                <span key={index} style={{ width: `${width}%` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mac-base" />
    </div>
  )
}
