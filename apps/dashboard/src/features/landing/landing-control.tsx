/**
 * "Stay in control": four promises, and the iPhone and the Mac's notch that show each of them. The chapters advance on
 * their own while the section is on screen (the active chapter's rail is the timer); a click picks
 * one. The live card inside the phone is animated by landing-motion (liveDemo).
 */

import { Check, X } from "lucide-react"
import * as React from "react"

import { BrandOrb } from "@/components/brand"
import { ControlMac } from "@/features/landing/landing-mac"

const liveSteps = ["Reproduce the flaky test", "Find the cause", "Fix the race", "Run the full suite"]

const chapters = [
  {
    tone: "92 225 255",
    title: "See everything that's running",
    short: "Running",
    text: "Progress updates as the work happens, wherever it runs, without opening anything.",
  },
  {
    tone: "255 138 61",
    title: "Catch what's stuck",
    short: "Stuck",
    text: "Questions, failures and stalled work break through before they cost hours. Everything else updates quietly.",
  },
  {
    tone: "139 124 255",
    title: "The full picture, one tap away",
    short: "Details",
    text: "The plan, every step and the details, in plain words.",
  },
  {
    tone: "52 211 153",
    title: "Know how it went",
    short: "Outcomes",
    text: "Every outcome, finished or failed, and what ran while you were away.",
  },
] as const

function LiveCard() {
  return (
    <div className="live-card" data-live-card>
      <div className="flex items-center gap-2">
        <BrandOrb className="size-5" />
        <span className="text-[12px] font-semibold text-white/85">Claude Code</span>
        <span className="text-[12px] text-white/60">· relo</span>
        <span data-live-badge className="ml-auto text-[11.5px] font-semibold text-[var(--neon-cyan)]">
          Running
        </span>
      </div>
      <p className="mt-2 text-[15px] leading-snug font-semibold text-white">Fix the flaky sign-in test</p>
      <ul className="mt-2">
        {liveSteps.map((step, index) => (
          <li key={step} className="live-step" data-live-step={index} data-state={index === 0 ? "now" : "next"}>
            <i>
              <Check className="size-2.5" strokeWidth={3.5} />
            </i>
            <span>{step}</span>
          </li>
        ))}
      </ul>
      <div className="live-bar mt-2.5">
        <span data-live-bar />
      </div>
      <p data-live-status className="mt-2 truncate text-[12px] text-white/70">
        Reproducing it in a loop…
      </p>
    </div>
  )
}

function Notice({
  tone,
  label,
  when,
  title,
  text,
  children,
}: {
  tone: string
  label: string
  when: string
  title: string
  text: string
  children?: React.ReactNode
}) {
  return (
    <div className="cp-notice" style={{ "--n": tone } as React.CSSProperties}>
      <div className="cp-notice-head">
        <BrandOrb className="size-4" />
        <span>{label}</span>
        <time>{when}</time>
      </div>
      <b>{title}</b>
      <p>{text}</p>
      {children}
    </div>
  )
}

/** Chapter 2: a question and a stalled job break through; the running card steps back. */
function StuckLayer() {
  return (
    <div className="cp-layer cp-stuck">
      <Notice tone="255 138 61" label="Time sensitive" when="now" title="Deploy to production?" text="Claude Code · api is waiting on you">
        <div className="cp-notice-actions">
          <span>Decline</span>
          <span className="cp-approve">Approve</span>
        </div>
      </Notice>
      <Notice tone="244 63 94" label="Stalled" when="2m ago" title="Nightly backup" text="No progress for 40 minutes on the home server" />
    </div>
  )
}

const planDetail = [
  { step: "Reproduce the flaky test", state: "done", note: "Fails 1 run in 20" },
  { step: "Find the cause", state: "done", note: "Two requests race for the cookie" },
  { step: "Fix the race", state: "now", note: "Serialising the refresh" },
  { step: "Run the full suite", state: "next", note: "" },
] as const

/** Chapter 3: one tap opens the work: its plan, each step's note and the facts. */
function DetailLayer() {
  return (
    <div className="cp-layer cp-sheet">
      <span className="cp-grabber" />
      <div className="cp-sheet-source">
        <BrandOrb className="size-4" />
        Claude Code · relo
        <em>Running</em>
      </div>
      <h4>Fix the flaky sign-in test</h4>
      <ol className="cp-plan">
        {planDetail.map(({ step, state, note }) => (
          <li key={step} data-state={state}>
            <i>{state === "done" ? <Check className="size-2.5" strokeWidth={3.5} /> : null}</i>
            <span>
              <b>{step}</b>
              {note ? <small>{note}</small> : null}
            </span>
          </li>
        ))}
      </ol>
      <dl className="cp-facts">
        <div><dt>Started</dt><dd>9:12</dd></div>
        <div><dt>Updated</dt><dd>20 s ago</dd></div>
        <div><dt>Step</dt><dd>3 of 4</dd></div>
      </dl>
      <p className="cp-log-title">Activity</p>
      <ol className="cp-log">
        <li><time>9:41</time>Serialising the refresh</li>
        <li><time>9:33</time>Found it: two requests race for the cookie</li>
        <li><time>9:12</time>Started on your laptop</li>
      </ol>
    </div>
  )
}

/** Chapter 4: outcomes waiting on the Lock Screen, finished and failed alike. */
function OutcomesLayer() {
  return (
    <div className="cp-layer cp-outcomes">
      <p className="cp-away">While you were away</p>
      <div className="cp-outcome" data-tone="mint">
        <i><Check className="size-3" strokeWidth={3.5} /></i>
        <span><b>Fix the flaky sign-in test</b><small>412 of 412 passing · 32 min</small></span>
      </div>
      <div className="cp-outcome" data-tone="red">
        <i><X className="size-3" strokeWidth={3.5} /></i>
        <span><b>Nightly backup failed</b><small>Disk full on the home server</small></span>
      </div>
      <div className="cp-outcome" data-tone="mint">
        <i><Check className="size-3" strokeWidth={3.5} /></i>
        <span><b>Weekly report sent</b><small>Codex · 6 min</small></span>
      </div>
    </div>
  )
}

function ControlPhone({ chapter }: { chapter: number }) {
  return (
    <div className="phone cp-phone" data-chapter={chapter} aria-hidden="true">
      <div className="phone-screen">
        <div className="phone-island">
          <span className="cp-island-live">
            <span className="flex items-center gap-1.5">
              <BrandOrb className="size-4" />
              <span data-island-label className="text-[var(--neon-cyan)]">1/4</span>
            </span>
            <span data-island-done className="text-[var(--neon-mint)] opacity-0">Done</span>
          </span>
          <span className="cp-island-alert">
            <i />
            Needs you
          </span>
        </div>
        <p className="phone-time">9:41</p>
        <p className="phone-date">Wednesday 14 October</p>
        <div className="cp-live">
          <LiveCard />
        </div>
        <StuckLayer />
        <OutcomesLayer />
        <DetailLayer />
      </div>
    </div>
  )
}

export function ControlSection() {
  const sectionRef = React.useRef<HTMLElement>(null)
  const [chapter, setChapter] = React.useState(0)
  const [onScreen, setOnScreen] = React.useState(false)
  const [held, setHeld] = React.useState(false)

  React.useEffect(() => {
    const section = sectionRef.current
    if (!section || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(Boolean(entry?.isIntersecting)), {
      threshold: 0.35,
    })
    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  const playing = onScreen && !held
  return (
    <section id="control" ref={sectionRef} className="landing-section control">
      <div
        className="landing-glow control-glow top-[18%] right-[-8%] size-[560px]"
        style={{ background: `rgb(${chapters[chapter]!.tone} / 0.2)` }}
      />
      <div className="landing-wrap">
        <header className="control-head">
          <h2 className="landing-h2 landing-split">Stay in control.</h2>
          <p className="landing-lede landing-reveal">
            The more you hand to agents and automations, the more you need to see them. Every agent, script and app
            keeps its status live on your Lock Screen, so nothing waits on you unnoticed.
          </p>
        </header>

        <div className="control-stage">
          <div
            className="control-chapters landing-reveal"
            role="tablist"
            aria-label="What you see on your iPhone and Mac"
            onPointerEnter={(event) => event.pointerType === "mouse" && setHeld(true)}
            onPointerLeave={() => setHeld(false)}
          >
            {chapters.map((item, index) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                id={`control-tab-${index}`}
                aria-selected={index === chapter}
                className="control-chapter"
                data-active={index === chapter || undefined}
                style={{ "--tone": item.tone } as React.CSSProperties}
                onClick={() => setChapter(index)}
              >
                <span className="control-rail">
                  {index === chapter ? (
                    <span
                      key={chapter}
                      className="control-rail-fill"
                      data-playing={playing || undefined}
                      onAnimationEnd={() => setChapter((current) => (current + 1) % chapters.length)}
                    />
                  ) : null}
                </span>
                <span className="control-chapter-short">{item.short}</span>
                <span className="control-chapter-body">
                  <span className="control-chapter-title">{item.title}</span>
                  <span className="control-chapter-text">
                    <span>{item.text}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="control-caption" aria-hidden="true">
            <b>{chapters[chapter]!.title}</b>
            <p>{chapters[chapter]!.text}</p>
          </div>

          <div className="control-devices landing-reveal" role="tabpanel" aria-labelledby={`control-tab-${chapter}`}>
            <p className="sr-only">{chapters[chapter]!.text} On your iPhone and in your Mac's notch.</p>
            <div className="control-mac">
              <ControlMac chapter={chapter} />
            </div>
            <div className="control-phone" data-live-phone>
              <ControlPhone chapter={chapter} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
