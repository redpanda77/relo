import {
  Activity,
  ArrowRight,
  Cloud,
  HardDrive,
  Laptop,
  Workflow,
  BadgeCheck,
  BellRing,
  Check,
  ListTree,
  Monitor,
  MessageSquareReply,
  Pause,
  Play,
  Server,
  Smartphone,
  Users,
  Timer,
  Webhook,
} from "lucide-react"
import * as React from "react"

import { BrandLockup, BrandOrb } from "@/components/brand"
import { GITHUB_URL, GitHubMark } from "@/features/auth/github"
import "@/features/landing/landing.css"
import { setupLandingMotion, type LandingMotion } from "@/features/landing/landing-motion"
import type { LandingScene } from "@/features/landing/landing-scene"

const INSTALL_URL = `${GITHUB_URL}#install-relo`

/** Harnesses the CLI sets up (`relo setup`, `--mcp`), then everything that speaks HTTP. */
const sources = [
  "Claude Code",
  "Codex",
  "Gemini CLI",
  "Cursor",
  "GitHub Copilot CLI",
  "OpenCode",
  "Amp",
  "Claude Desktop",
  "VS Code",
  "GitHub Actions",
  "Cron jobs",
  "Webhooks",
  "HTTP API",
  "Your own apps",
]

/** The value proposition (docs/VALUE-PROPOSITION.md): sources anywhere, one place, four things you get. */
const flowSources = [
  { icon: Laptop, what: "Claude Code", where: "Agent · on your laptop", tone: "92 225 255" },
  { icon: HardDrive, what: "Codex and your own harness", where: "Agents · another computer", tone: "139 124 255" },
  { icon: Cloud, what: "Nightly backup, CI, cron", where: "Scripts and jobs · home server or cloud", tone: "52 211 153" },
  { icon: Workflow, what: "New sign-up needs approval", where: "Your app · via the HTTP API", tone: "255 107 87" },
] as const

const flowOutcomes = [
  { icon: Activity, title: "Live status", text: "What's running and how far along, on the Lock Screen", tone: "92 225 255" },
  { icon: BellRing, title: "Time-sensitive alerts", text: "Only what needs you now breaks through", tone: "255 138 61" },
  { icon: ListTree, title: "The details", text: "The plan, the steps, the payload, on demand", tone: "139 124 255" },
  { icon: MessageSquareReply, title: "Your input", text: "Approve, decline or answer, and it carries on", tone: "52 211 153" },
] as const

const liveSteps = ["Reproduce the flaky test", "Find the cause", "Fix the race", "Run the full suite"]

const features = [
  {
    icon: Workflow,
    tone: "92 225 255",
    title: "A human in the loop for your apps",
    text: "Your product asks, you decide: a new sign-up, a large refund, an access request. It calls the HTTP API, waits, and gets your answer by signed callback.",
    visual: "apps",
  },
  {
    icon: Users,
    tone: "139 124 255",
    title: "Every session at a glance",
    text: "Know which Claude Code and Gemini CLI sessions are working, waiting on you, idle or done (with hooks on).",
  },
  {
    icon: BadgeCheck,
    tone: "255 138 61",
    title: "Only you can say yes",
    text: "Approvals are signed on your phone, so nothing and no one else can approve for you.",
  },
  {
    icon: Monitor,
    tone: "52 211 153",
    title: "On your desk too",
    text: "The same view in any browser you link from your phone: what's live, what happened, by project.",
  },
  {
    icon: ListTree,
    tone: "214 92 240",
    title: "See the plan, not just a spinner",
    text: "Long work shows its steps, so you know what's done, what's next and when to expect it.",
  },
  {
    icon: Webhook,
    tone: "255 107 87",
    title: "Your scripts and services too",
    text: "Cron jobs, deploy pipelines and webhooks report in the same place as your agents, with the CLI or a simple HTTP call.",
    visual: "sources",
  },
] as const

const controls = [
  {
    tone: "var(--neon-cyan)",
    title: "See everything that's running",
    text: "Progress updates as the work happens, wherever it runs, without opening anything.",
  },
  {
    tone: "var(--neon-orange)",
    title: "Catch what's stuck",
    text: "Questions, failures and stalled work break through before they cost hours. Everything else updates quietly.",
  },
  {
    tone: "var(--neon-violet)",
    title: "The full picture, one tap away",
    text: "The plan, every step and the details, in plain words.",
  },
  {
    tone: "var(--neon-mint)",
    title: "Know how it went",
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

function Phone({ children, island }: { children: React.ReactNode; island?: React.ReactNode }) {
  return (
    <div className="phone" aria-hidden="true">
      <div className="phone-screen">
        <div className="phone-island">{island}</div>
        <p className="phone-time">9:41</p>
        <p className="phone-date">Wednesday 14 October</p>
        {children}
      </div>
    </div>
  )
}

function SectionHeading({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div>
      <h2 className="landing-h2 landing-split">{title}</h2>
      {children ? <p className="landing-lede landing-reveal mt-6">{children}</p> : null}
    </div>
  )
}

function Chip({
  tone,
  icon: Icon,
  title,
  detail,
  className = "",
}: {
  tone: string
  icon: typeof Activity
  title: string
  detail: string
  className?: string
}) {
  return (
    <div className={`landing-chip glass ${className}`}>
      <span className="icon-dot" style={{ color: `rgb(${tone})`, background: `rgb(${tone} / 0.14)` }}>
        <Icon className="size-4" />
      </span>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
    </div>
  )
}

export function LandingPage({ signInPath = "/sign-in" }: { signInPath?: string }) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const sceneRef = React.useRef<LandingScene | null>(null)
  const motionRef = React.useRef<LandingMotion | null>(null)
  // The scene runs only while on screen, the tab is visible and the visitor hasn't paused motion.
  const pauseRef = React.useRef({ offscreen: false, hidden: false, user: false })
  const [fallback, setFallback] = React.useState(false)
  const [paused, setPaused] = React.useState(false)

  const applyPause = React.useCallback(() => {
    const { offscreen, hidden, user } = pauseRef.current
    sceneRef.current?.setPaused(offscreen || hidden || user)
  }, [])

  // The WebGL hero loads after first paint; the copy never waits for it.
  React.useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    let disposed = false
    let observer: IntersectionObserver | undefined
    const ready = () => stage.dispatchEvent(new Event("landing:stage-ready", { bubbles: true }))
    const fail = () => {
      sceneRef.current?.dispose()
      sceneRef.current = null
      setFallback(true)
      ready()
    }
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    import("@/features/landing/landing-scene")
      .then(({ createLandingScene, supportsWebGL }) => {
        if (disposed) return
        if (!supportsWebGL()) return fail()
        sceneRef.current = createLandingScene(canvas, {
          reducedMotion,
          onReady: () => {
            stage.setAttribute("data-ready", "true")
            ready()
          },
          onLost: fail,
        })
        applyPause()
        observer = new IntersectionObserver(([entry]) => {
          pauseRef.current.offscreen = !entry?.isIntersecting
          applyPause()
        })
        observer.observe(stage)
      })
      .catch(() => {
        if (!disposed) fail()
      })
    const onVisibility = () => {
      pauseRef.current.hidden = document.hidden
      applyPause()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [applyPause])

  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const motion = setupLandingMotion(root, {
      onHeroScroll: (progress) => sceneRef.current?.setScroll(progress),
    })
    motionRef.current = motion
    return () => {
      motionRef.current = null
      motion.dispose()
    }
  }, [])

  function toggleMotion() {
    const next = !paused
    setPaused(next)
    pauseRef.current.user = next
    applyPause()
    motionRef.current?.setPaused(next)
  }

  return (
    <div ref={rootRef} className={`landing ${paused ? "motion-paused" : ""}`}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-black focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="landing-nav" data-landing-nav>
        <div className="landing-wrap flex h-[72px] items-center justify-between gap-4">
          <a href="/" aria-label="Relo home" className="shrink-0">
            <BrandLockup orbClassName="size-7" />
          </a>
          <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
            <a className="landing-nav-link" href="#one-place">Why Relo</a>
            <a className="landing-nav-link" href="#private">Privacy</a>
            <a className="landing-nav-link" href="#features">Features</a>
            <a className="landing-nav-link" href={INSTALL_URL} rel="external noopener" target="_blank">Install</a>
            <a className="landing-nav-link inline-flex items-center gap-2" href={GITHUB_URL} rel="external noopener" target="_blank">
              <GitHubMark className="size-4" />
              GitHub
            </a>
          </nav>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="landing-nav-link landing-icon-button"
              aria-pressed={paused}
              aria-label={paused ? "Play motion" : "Pause motion"}
              title={paused ? "Play motion" : "Pause motion"}
              onClick={toggleMotion}
            >
              {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
            </button>
            <a
              className="landing-nav-link landing-icon-button landing-phone-only"
              href={GITHUB_URL}
              rel="external noopener"
              target="_blank"
              aria-label="Relo on GitHub"
            >
              <GitHubMark className="size-5" />
            </a>
            <a href={signInPath} className="capsule-cta landing-nav-cta">
              Sign in
            </a>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="outline-none">
        {/* ---------- Hero ---------- */}
        <section className="landing-hero" data-landing-hero aria-labelledby="landing-title">
          <div ref={stageRef} className="landing-stage" aria-hidden="true">
            {fallback ? <div className="landing-stage-fallback" /> : <canvas ref={canvasRef} />}
          </div>
          <div className="landing-wrap relative">
            <div className="hero-copy max-w-[52rem]">
              <h1 id="landing-title" className="landing-display">
                <span className="landing-line hero-line">
                  <span>Every agent.</span>
                </span>
                <span className="landing-line hero-line">
                  <span className="muted">One place.</span>
                </span>
              </h1>
              <p className="hero-sub landing-lede landing-hero-lede mt-7">
                Live status, alerts and approvals from every agent, script and app you run, wherever it runs. On your iPhone.
              </p>
              <div className="hero-cta mt-9 flex flex-wrap items-center gap-3">
                <a href={INSTALL_URL} className="capsule-cta magnetic max-sm:w-full" rel="external noopener" target="_blank">
                  <GitHubMark className="size-[18px]" />
                  Get Relo
                </a>
                <a href={signInPath} className="ghost-cta magnetic max-sm:w-full">
                  Sign in
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </div>

            <div className="pointer-events-none absolute inset-y-0 right-[var(--landing-gutter)] hidden w-[46%] xl:block" aria-hidden="true">
              <Chip className="top-[-2%] left-[16%]" tone="92 225 255" icon={Activity} title="Running the suite" detail="Claude Code · 3 of 4 steps" />
              <Chip className="top-[62%] right-[-4%]" tone="255 138 61" icon={MessageSquareReply} title="Deploy to production?" detail="Needs you · approve or decline" />
              <Chip className="bottom-[-4%] left-[16%]" tone="52 211 153" icon={Check} title="Release notes published" detail="Finished · 2 min ago" />
            </div>
          </div>
          <div className="scroll-cue" aria-hidden="true">
            <span />
          </div>
        </section>

        {/* ---------- Sources ---------- */}
        <section id="one-place" aria-labelledby="one-place-title" className="landing-section !pb-16">
          <div className="landing-wrap">
            <div className="mx-auto max-w-5xl text-center">
              <h2 id="one-place-title" className="landing-for landing-reveal text-balance">
                Wherever it runs. <span className="text-[#b4b4c8]">Whatever runs it.</span>
              </h2>
              <p className="landing-lede landing-reveal mx-auto mt-5 !max-w-[44rem] text-balance">
                Claude Code on your laptop, Codex on another computer, a script on your home server, a job in the
                cloud, your own app waiting for an approval. Relo brings them together on your iPhone.
              </p>
            </div>

            <div className="flow mt-14" data-flow>
              <svg className="flow-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {[12.5, 37.5, 62.5, 87.5].map((y) => (
                  <path key={`in-${y}`} className="flow-line" d={`M 40 ${y} C 46 ${y}, 45 50, 50 50`} />
                ))}
                {[12.5, 37.5, 62.5, 87.5].map((y) => (
                  <path key={`out-${y}`} className="flow-line flow-line-out" d={`M 50 50 C 55 50, 54 ${y}, 60 ${y}`} />
                ))}
              </svg>

              <div className="flow-column">
                <p className="flow-caption">Wherever it runs</p>
                <ul className="grid gap-3">
                  {flowSources.map(({ icon: Icon, where, what, tone }) => (
                    <li key={where} className="flow-card landing-reveal">
                      <span className="flow-icon" style={{ color: `rgb(${tone})`, background: `rgb(${tone} / 0.12)` }}>
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <b>{what}</b>
                        <small>{where}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flow-hub landing-reveal" aria-hidden="true">
                <BrandOrb className="size-16 lg:size-20" />
                <span className="wordmark mt-3 text-[1.6rem]">relo</span>
              </div>

              <div className="flow-column">
                <p className="flow-caption">What you get</p>
                <ul className="grid gap-3">
                  {flowOutcomes.map(({ icon: Icon, title, text, tone }) => (
                    <li key={title} className="flow-card landing-reveal">
                      <span className="flow-icon" style={{ color: `rgb(${tone})`, background: `rgb(${tone} / 0.12)` }}>
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <b>{title}</b>
                        <small>{text}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
        <div className="landing-marquee">
          <div className="landing-marquee-track" data-marquee>
            {[0, 1].map((copy) => (
              <ul key={copy} className="flex" aria-label={copy === 0 ? "Works with" : undefined} aria-hidden={copy === 1 ? "true" : undefined}>
                {sources.map((source, index) => (
                  <li key={source} className="landing-marquee-item">
                    <span
                      className="ink-dot"
                      aria-hidden="true"
                      style={{ background: ["var(--neon-cyan)", "var(--neon-violet)", "var(--neon-coral)", "var(--neon-mint)"][index % 4] }}
                    />
                    {source}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>

        {/* ---------- Control ---------- */}
        <section id="control" className="landing-section">
          <div className="landing-glow top-[20%] left-[-10%] size-[520px] bg-[rgb(92_225_255/0.22)]" />
          <div className="landing-wrap grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-20">
            <div>
              <SectionHeading title={<>Stay in control.</>}>
                The more you hand to agents and automations, the more you need to see them. Every agent, script and
                app keeps its status live on your Lock Screen, so work keeps moving and nothing waits on you unnoticed.
              </SectionHeading>
              <div className="landing-reveal mt-12 flex justify-center lg:justify-start" data-live-phone>
                <Phone
                  island={
                    <>
                      <span className="flex items-center gap-1.5">
                        <BrandOrb className="size-4" />
                        <span data-island-label className="text-[var(--neon-cyan)]">1/4</span>
                      </span>
                      <span data-island-done className="text-[var(--neon-mint)] opacity-0">Done</span>
                    </>
                  }
                >
                  <LiveCard />
                </Phone>
              </div>
            </div>
            <div className="self-center border-b border-white/[0.07]">
              {controls.map((item) => (
                <div key={item.title} className="landing-question landing-reveal">
                  <span className="dot" aria-hidden="true" style={{ background: item.tone, boxShadow: `0 0 24px ${item.tone}` }} />
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Ask ---------- */}
        <section className="landing-section !pt-0">
          <div className="landing-glow top-[30%] left-[-12%] size-[560px] bg-[rgb(255_138_61/0.18)]" />
          <div className="landing-wrap grid items-center gap-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)] lg:gap-24">
            <div className="order-2 lg:order-1" data-ask-demo>
              <p className="sr-only">
                Example: an agent runs relo ask "Deploy to production?", the owner approves on the iPhone, and the
                agent continues with the deploy.
              </p>
              <div className="relative mx-auto flex max-w-[640px] flex-col gap-5 sm:block sm:pb-[130px]" aria-hidden="true">
                <div className="terminal landing-reveal sm:mr-16">
                  <div className="terminal-bar">
                    <i /> <i /> <i />
                    <span className="ml-2 text-[12px] text-white/60">agent · ~/relo</span>
                  </div>
                  <div className="terminal-body sm:min-h-[230px]">
                    <div>
                      <span className="prompt">$ </span>
                      <span data-ask-command>relo ask "Deploy to production?" --approval</span>
                    </div>
                    <div data-ask-wait className="dim">  waiting for the owner…</div>
                    <div data-ask-ok className="ok">  ✓ approved · exit 0</div>
                    <div data-ask-next>
                      <span className="prompt">$ </span>pnpm deploy <span className="cyan">→ production</span>
                    </div>
                  </div>
                </div>
                <div className="landing-reveal sm:absolute sm:right-0 sm:bottom-0 sm:w-[340px]">
                  <div className="glass rounded-[26px] p-5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.9)]" data-ask-card>
                    <div className="flex items-center gap-2 text-[12px]">
                      <BrandOrb className="size-5" />
                      <span className="font-semibold">Claude Code</span>
                      <span data-ask-badge className="ml-auto font-semibold text-[var(--neon-orange)]">Needs you</span>
                    </div>
                    <p className="mt-2 text-[17px] font-semibold">Deploy to production?</p>
                    <div className="relative mt-4 flex gap-2">
                      <span className="ask-button grid place-items-center border border-white/12 bg-white/[0.06]">Decline</span>
                      <span data-ask-approve className="ask-button grid place-items-center bg-[var(--action-fill)] text-white">
                        Approve
                      </span>
                      <span
                        data-ask-tap
                        className="pointer-events-none absolute top-1/2 right-[22%] size-10 -translate-y-1/2 rounded-full border-2 border-white/80 opacity-0"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <SectionHeading title={<>Say yes<br />from anywhere.</>}>
                Before anything risky, your agent, script or app asks on its card: deploy to production, approve a new
                sign-up. Approve, decline or answer on your iPhone and it carries on the moment you do. No answer means
                no.
              </SectionHeading>
            </div>
          </div>
        </section>

        {/* ---------- Private ---------- */}
        <section id="private" className="landing-section !pt-0">
          <div className="landing-glow top-[10%] right-[5%] size-[480px] bg-[rgb(52_211_153/0.16)]" />
          <div className="landing-wrap">
            <div className="max-w-3xl">
              <SectionHeading title={<>Total privacy.<br />For confidential work.</>}>
                Your agents work on client code, unreleased plans and personal matters. Everything Relo carries is
                encrypted on your computer and opens only on your devices. Nobody in between can read it, not even
                your own server.
              </SectionHeading>
            </div>

            <ol className="journey mt-14" data-seal>
              <li className="journey-stop landing-reveal">
                <span className="journey-icon"><Laptop className="size-5" aria-hidden="true" /></span>
                <h3>Sealed on your computer</h3>
                <p>Encrypted before it leaves the machine your agent runs on.</p>
              </li>
              <li className="journey-stop landing-reveal">
                <span className="journey-icon"><Server className="size-5" aria-hidden="true" /></span>
                <h3>Unreadable on the way</h3>
                <p>Your server stores and delivers it, but only ever sees this:</p>
                <p data-seal-cipher className="seal-text journey-cipher" aria-hidden="true">
                  9f3a·c41e·77b0·e2d9·05aa·1b6f·d83c·4e21
                </p>
              </li>
              <li className="journey-stop landing-reveal" data-tone="mint">
                <span className="journey-icon"><Smartphone className="size-5" aria-hidden="true" /></span>
                <h3>Opens only on your devices</h3>
                <p>Your iPhone, and browsers you link from it, hold the only keys:</p>
                <p data-seal-plain className="seal-text journey-plain" aria-hidden="true">
                  Migration finished · 3 tables, 0 errors
                </p>
              </li>
              <li className="journey-stop landing-reveal">
                <span className="journey-icon"><Timer className="size-5" aria-hidden="true" /></span>
                <h3>Then it's gone</h3>
                <p>Wiped from your server and your devices after hours, not kept forever. Keys rotate every 10 hours, so even an old copy can never be opened again.</p>
              </li>
            </ol>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-[14px] text-[#c3c3d3]">
              {[
                "End-to-end encrypted by default",
                "Keys never leave your devices",
                "Approvals signed on your phone",
                "Self-hosted and source-available, so you can check",
              ].map((text) => (
                <li key={text} className="landing-reveal inline-flex items-center gap-2">
                  <Check className="size-4 text-[var(--neon-mint)]" aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- Everything else ---------- */}
        <section id="features" className="landing-section !pt-0">
          <div className="landing-wrap">
            <SectionHeading title={<>Built for how agents<br />actually work.</>} />
            <div className="bento mt-14" data-bento>
              {features.map(({ icon: Icon, tone, title, text, ...rest }) => (
                <article
                  key={title}
                  className={`bento-card landing-reveal ${"visual" in rest ? "wide" : ""}`}
                  style={{ "--tone": tone } as React.CSSProperties}
                >
                  <span className="bento-icon">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                  {"visual" in rest && rest.visual === "apps" ? (
                    <div className="mt-6 flex flex-wrap items-center gap-2" aria-hidden="true">
                      <span className="plan-pill" data-state="now">New sign-up · approve?</span>
                      <span className="plan-pill">Refund over $500 · confirm?</span>
                      <span className="plan-pill" data-state="done"><Check className="size-3" strokeWidth={3} /> Access request approved</span>
                    </div>
                  ) : null}
                  {"visual" in rest && rest.visual === "sources" ? (
                    <div className="mt-6 flex flex-wrap gap-2" aria-hidden="true">
                      {["cron", "GitHub Actions", "webhooks", "HTTP API", "relo CLI"].map((source) => (
                        <span key={source} className="plan-pill font-mono">{source}</span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Finale ---------- */}
        <section className="landing-section !pt-0" aria-labelledby="finale-title">
          <div className="landing-wrap">
            <div className="landing-finale landing-reveal">
              <BrandOrb className="mx-auto size-20" />
              <h2 id="finale-title" className="landing-h2 mx-auto mt-8 max-w-3xl">
                Stop checking on your agents.
              </h2>
              <p className="landing-lede mx-auto mt-6 text-center">
                Source-available under PolyForm Noncommercial. Free for personal and noncommercial use.
              </p>
              <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                <a href={INSTALL_URL} className="capsule-cta magnetic" rel="external noopener" target="_blank">
                  <GitHubMark className="size-[18px]" />
                  Install Relo
                </a>
                <a href={signInPath} className="ghost-cta magnetic">
                  Sign in
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] py-8">
        <div className="landing-wrap flex flex-col items-start justify-between gap-4 text-[13px] text-[var(--muted-foreground)] sm:flex-row sm:items-center">
          <BrandLockup orbClassName="size-6" />
          <p>Source-available under the PolyForm Noncommercial License 1.0.0.</p>
          <div className="flex gap-2">
            <a className="landing-footer-link" href={GITHUB_URL} rel="external noopener" target="_blank">
              GitHub
            </a>
            <a className="landing-footer-link" href={signInPath}>
              Sign in
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
