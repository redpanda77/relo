import {
  Activity,
  ArrowRight,
  Cloud,
  HardDrive,
  Laptop,
  Workflow,
  BellRing,
  Check,
  ListTree,
  MessageSquareReply,
} from "lucide-react"
import * as React from "react"

import { BrandLockup, BrandOrb } from "@/components/brand"
import { GITHUB_URL, GitHubMark } from "@/features/auth/github"
import "@/features/landing/landing.css"
import { ControlSection } from "@/features/landing/landing-control"
import { FeatureViz, type FeatureVisual } from "@/features/landing/landing-features"
import { LandingFilm } from "@/features/landing/landing-film"
import { setupLandingMotion } from "@/features/landing/landing-motion"
import type { LandingScene } from "@/features/landing/landing-scene"

/** The docs this server serves: the install guide starts at Get started. */
const DOCS_PATH = "/docs"

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

const privacy: ReadonlyArray<{ tone: string; title: string; text: string; visual: FeatureVisual }> = [
  {
    tone: "92 225 255",
    title: "Sealed on your computer",
    text: "Encrypted before it leaves the machine your agent runs on.",
    visual: "seal",
  },
  {
    tone: "139 124 255",
    title: "Unreadable on the way",
    text: "Your server stores and delivers it, but only ever sees ciphertext.",
    visual: "transit",
  },
  {
    tone: "52 211 153",
    title: "Opens only on your devices",
    text: "Your iPhone, and browsers you link from it, hold the only keys.",
    visual: "devices",
  },
  {
    tone: "214 92 240",
    title: "Then it's gone",
    text: "Wiped from your server and your devices after hours. Keys rotate every 10 hours, so an old copy can never be opened again.",
    visual: "expiry",
  },
]

const features: ReadonlyArray<{ tone: string; title: string; text: string; visual: FeatureVisual; wide?: boolean }> = [
  {
    tone: "92 225 255",
    title: "A human in the loop for your apps",
    text: "Your product asks, you decide: a new sign-up, a large refund, an access request. It calls the HTTP API, waits, and gets your answer by signed callback.",
    visual: "apps",
    wide: true,
  },
  {
    tone: "139 124 255",
    title: "Every session at a glance",
    text: "Know which Claude Code and Gemini CLI sessions are working, waiting on you, idle or done (with hooks on).",
    visual: "sessions",
  },
  {
    tone: "255 138 61",
    title: "Only you can say yes",
    text: "Approvals are signed on your phone, so nothing and no one else can approve for you.",
    visual: "approval",
  },
  {
    tone: "52 211 153",
    title: "On your desk too",
    text: "The same view in any browser you link from your phone: what's live, what happened, by project.",
    visual: "desk",
  },
  {
    tone: "214 92 240",
    title: "See the plan, not just a spinner",
    text: "Long work shows its steps, so you know what's done, what's next and when to expect it.",
    visual: "plan",
  },
  {
    tone: "255 107 87",
    title: "Your scripts and services too",
    text: "Cron jobs, deploy pipelines and webhooks report in the same place as your agents, with the CLI or a simple HTTP call.",
    visual: "sources",
    wide: true,
  },
]

/** Offset of an element inside an ancestor, from layout alone (reveal transforms never skew it). */
function offsetWithin(element: HTMLElement, ancestor: HTMLElement) {
  let x = 0
  let y = 0
  let node: HTMLElement | null = element
  while (node && node !== ancestor) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return { x, y }
}

/**
 * The dotted lines of "One place": from the middle of each source card into the orb's white core,
 * and from the core out to each outcome. Measured from the layout, so they meet the core exactly
 * at any width (desktop only; phones use the beam in CSS).
 */
function FlowLines() {
  const svg = React.useRef<SVGSVGElement>(null)
  const [geometry, setGeometry] = React.useState<{ width: number; height: number; paths: string[] } | null>(null)

  React.useLayoutEffect(() => {
    const flow = svg.current?.parentElement
    if (!flow) return
    const measure = () => {
      const orb = flow.querySelector<HTMLElement>(".flow-hub .brand-orb")
      const [sources, outcomes] = [...flow.querySelectorAll<HTMLElement>(".flow-column")].map((column) => [
        ...column.querySelectorAll<HTMLElement>(".flow-card"),
      ])
      if (!orb || !sources || !outcomes || flow.offsetWidth === 0) return
      const core = offsetWithin(orb, flow)
      const cx = core.x + orb.offsetWidth / 2
      const cy = core.y + orb.offsetHeight / 2
      const curve = (x0: number, y0: number, x1: number, y1: number) => {
        const dx = x1 - x0
        return `M ${x0} ${y0} C ${x0 + dx * 0.55} ${y0}, ${x1 - dx * 0.45} ${y1}, ${x1} ${y1}`
      }
      const paths = [
        ...sources.map((card) => {
          const at = offsetWithin(card, flow)
          return curve(at.x + card.offsetWidth, at.y + card.offsetHeight / 2, cx, cy)
        }),
        ...outcomes.map((card) => {
          const at = offsetWithin(card, flow)
          return curve(cx, cy, at.x, at.y + card.offsetHeight / 2)
        }),
      ]
      setGeometry({ width: flow.offsetWidth, height: flow.offsetHeight, paths })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(flow)
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [])

  const half = geometry ? geometry.paths.length / 2 : 0
  return (
    <svg
      ref={svg}
      className="flow-lines"
      viewBox={geometry ? `0 0 ${geometry.width} ${geometry.height}` : undefined}
      aria-hidden="true"
    >
      {geometry?.paths.map((d, index) => (
        <path key={index} className={index < half ? "flow-line" : "flow-line flow-line-out"} d={d} />
      ))}
    </svg>
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

export function LandingPage({ signInPath = "/sign-in", filmBase }: { signInPath?: string; filmBase?: string }) {
  const signUpPath = `${signInPath}?mode=sign-up`
  const rootRef = React.useRef<HTMLDivElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const sceneRef = React.useRef<LandingScene | null>(null)
  // The scene runs only while on screen and the tab is visible.
  const pauseRef = React.useRef({ offscreen: false, hidden: false })
  const [fallback, setFallback] = React.useState(false)

  const applyPause = React.useCallback(() => {
    const { offscreen, hidden } = pauseRef.current
    sceneRef.current?.setPaused(offscreen || hidden)
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
    return () => motion.dispose()
  }, [])

  return (
    <div ref={rootRef} className="landing">
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
            <a className="landing-nav-link" href={DOCS_PATH}>Docs</a>
            <a className="landing-nav-link inline-flex items-center gap-2" href={GITHUB_URL} rel="external noopener" target="_blank">
              <GitHubMark className="size-4" />
              GitHub
            </a>
          </nav>
          <div className="flex items-center gap-1.5">
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
                <a href={signUpPath} className="capsule-cta magnetic max-sm:w-full">
                  Create account
                  <ArrowRight className="size-[18px]" aria-hidden="true" />
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

        {/* ---------- The film ---------- */}
        {filmBase ? <LandingFilm base={filmBase} /> : null}

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
              <FlowLines />

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

        <ControlSection />

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
            <div className="landing-head-wide">
              <SectionHeading title={<>Total privacy.<br />For confidential work.</>}>
                Your agents work on client code, unreleased plans and personal matters. Everything Relo carries is
                encrypted on your computer and opens only on your devices. Nobody in between can read it, not even
                your own server.
              </SectionHeading>
            </div>

            <div className="bento bento-privacy mt-14" data-bento>
              {privacy.map(({ tone, title, text, visual }) => (
                <article key={title} className="bento-card landing-reveal" style={{ "--tone": tone } as React.CSSProperties}>
                  <FeatureViz kind={visual} />
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>

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
              {features.map(({ tone, title, text, visual, wide }) => (
                <article
                  key={title}
                  className={`bento-card landing-reveal ${wide ? "wide" : ""}`}
                  style={{ "--tone": tone } as React.CSSProperties}
                >
                  <FeatureViz kind={visual} />
                  <h3>{title}</h3>
                  <p>{text}</p>
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
                <a href={signUpPath} className="capsule-cta magnetic">
                  Create account
                  <ArrowRight className="size-[18px]" aria-hidden="true" />
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
            <a className="landing-footer-link" href={DOCS_PATH}>
              Docs
            </a>
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
