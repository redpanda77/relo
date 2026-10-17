/**
 * Landing choreography. Scrolling stays native and free: sections reveal once as they arrive, demo
 * loops play only while on screen, and nothing is pinned or scrubbed into a story. Everything is
 * skipped under prefers-reduced-motion, where the page is already complete without it.
 */

import { gsap } from "gsap"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"
import { TextPlugin } from "gsap/TextPlugin"

gsap.registerPlugin(ScrollTrigger, SplitText, ScrambleTextPlugin, TextPlugin)

const liveStatus = [
  "Reproducing it in a loop…",
  "Two requests race for the session cookie",
  "Serialising the refresh, adding a test",
  "412 of 412 passing",
]

const ASK_COMMAND = 'relo ask "Deploy to production?" --approval'

/** Everything the demos write into React-owned DOM, restored when the motion is torn down. */
const DEMO_NODES =
  "[data-live-step],[data-live-badge],[data-live-status],[data-island-label],[data-ask-command],[data-ask-badge],[data-ask-approve],[data-plan-step],[data-plan-eta]"

/** Plays a looping timeline only while its element is on screen. */
function whileVisible(element: Element | null, timeline: gsap.core.Timeline) {
  if (!element) return
  ScrollTrigger.create({
    trigger: element,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => (self.isActive ? timeline.play() : timeline.pause()),
  })
}

function liveDemo(root: HTMLElement) {
  const phone = root.querySelector("[data-live-phone]")
  const steps = [...root.querySelectorAll<HTMLElement>("[data-live-step]")]
  const bar = root.querySelector("[data-live-bar]")
  const status = root.querySelector("[data-live-status]")
  const badge = root.querySelector("[data-live-badge]")
  const island = root.querySelector<HTMLElement>(".phone-island")
  const islandLabel = root.querySelector("[data-island-label]")
  const islandDone = root.querySelector("[data-island-done]")
  if (!phone || !bar || !status || !badge || !island || !islandLabel || !islandDone) return

  const setStep = (current: number) => {
    steps.forEach((step, index) => {
      step.dataset.state = index < current ? "done" : index === current ? "now" : "next"
    })
    islandLabel.textContent = `${Math.min(current + 1, steps.length)}/${steps.length}`
  }

  const timeline = gsap.timeline({ repeat: -1, paused: true, repeatDelay: 0.6 })
  timeline
    .call(() => {
      setStep(0)
      badge.textContent = "Running"
      badge.setAttribute("style", "color: var(--neon-cyan)")
    })
    .set(bar, { width: "4%" })
    .set(status, { text: liveStatus[0] })
    .set(island, { width: 112 })
    .set(islandDone, { opacity: 0 })
  steps.forEach((_, index) => {
    if (index === 0) {
      timeline.to(bar, { width: "22%", duration: 1.6, ease: "power2.inOut" })
      return
    }
    timeline
      .call(() => setStep(index), undefined, "+=0.5")
      .to(status, { duration: 0.6, scrambleText: { text: liveStatus[index]!, chars: "lowerCase", speed: 0.6 } }, "<")
      .to(bar, { width: `${22 + index * 26}%`, duration: 1.4, ease: "power2.inOut" }, "<")
  })
  timeline
    .call(() => {
      setStep(steps.length)
      badge.textContent = "Finished"
      badge.setAttribute("style", "color: var(--neon-mint)")
    }, undefined, "+=0.6")
    .to(bar, { width: "100%", duration: 0.5, ease: "power2.out" }, "<")
    .to(island, { width: 190, duration: 0.7, ease: "back.out(1.7)" }, "<")
    .to(islandDone, { opacity: 1, duration: 0.3 }, "<0.3")
    .to({}, { duration: 2.6 })
    .to(island, { width: 112, duration: 0.5, ease: "power3.inOut" })
    .to(islandDone, { opacity: 0, duration: 0.2 }, "<")
  whileVisible(phone, timeline)
}

function askDemo(root: HTMLElement) {
  const demo = root.querySelector("[data-ask-demo]")
  const command = root.querySelector("[data-ask-command]")
  const wait = root.querySelector("[data-ask-wait]")
  const ok = root.querySelector("[data-ask-ok]")
  const next = root.querySelector("[data-ask-next]")
  const card = root.querySelector("[data-ask-card]")
  const badge = root.querySelector("[data-ask-badge]")
  const approve = root.querySelector<HTMLElement>("[data-ask-approve]")
  const tap = root.querySelector("[data-ask-tap]")
  if (!demo || !command || !wait || !ok || !next || !card || !badge || !approve || !tap) return
  const full = ASK_COMMAND

  const timeline = gsap.timeline({ repeat: -1, paused: true, repeatDelay: 1 })
  timeline
    .set([wait, ok, next], { opacity: 0 })
    .set(command, { text: "" })
    .set(card, { y: 24, opacity: 0, scale: 0.96 })
    .set(tap, { opacity: 0, scale: 1.6 })
    .call(() => {
      badge.textContent = "Needs you"
      badge.setAttribute("style", "color: var(--neon-orange)")
      approve.textContent = "Approve"
      approve.style.background = "var(--action-fill)"
      approve.style.color = "#fff"
    })
    .to(command, { text: full, duration: 1.5, ease: "none" })
    .to(wait, { opacity: 1, duration: 0.3 })
    .to(card, { y: 0, opacity: 1, scale: 1, duration: 0.8, ease: "expo.out" }, "+=0.2")
    .to(tap, { opacity: 1, scale: 1, duration: 0.35, ease: "power2.out" }, "+=1")
    .to(tap, { opacity: 0, scale: 0.7, duration: 0.25 })
    .call(() => {
      badge.textContent = "Approved"
      badge.setAttribute("style", "color: var(--neon-mint)")
      approve.textContent = "✓ Approved"
      approve.style.background = "var(--neon-mint)"
      approve.style.color = "#04130c"
    }, undefined, "<")
    .to(ok, { opacity: 1, duration: 0.3 }, "+=0.4")
    .to(next, { opacity: 1, duration: 0.3 }, "+=0.5")
    .to({}, { duration: 2.4 })
  whileVisible(demo, timeline)
}

const planEta = ["About 6 min left", "About 5 min left", "About 4 min left", "About 2 min left", "About 1 min left", "Finished"]

/** The feature card's plan: steps tick by, one step is added mid-run, the plan carries on. */
function planDemo(root: HTMLElement) {
  const plan = root.querySelector("[data-plan]")
  const steps = [...root.querySelectorAll<HTMLElement>("[data-plan-step]")]
  const added = root.querySelector<HTMLElement>("[data-plan-added]")
  const eta = root.querySelector("[data-plan-eta]")
  if (!plan || !added || !eta || steps.length === 0) return
  const addedAt = steps.indexOf(added)

  const setStep = (current: number) => {
    steps.forEach((step, index) => {
      step.dataset.state = index < current ? "done" : index === current ? "now" : "next"
    })
    eta.textContent = planEta[Math.min(current, planEta.length - 1)]!
  }

  const timeline = gsap.timeline({ repeat: -1, paused: true, repeatDelay: 0.4 })
  timeline
    .call(() => setStep(0))
    // Clipped only while it grows, so the current step's ring is never cut off.
    .set(added, { height: 0, opacity: 0, overflow: "hidden" })
  for (let current = 1; current <= steps.length; current++) {
    timeline.call(() => setStep(current), undefined, "+=1.3")
    // While the step before it runs, the agent realises it needs one more and adds it in place.
    if (current === addedAt - 1) timeline.to(added, { height: "auto", opacity: 1, duration: 0.6, ease: "expo.out", onComplete: () => gsap.set(added, { overflow: "visible" }) }, "+=0.7")
  }
  timeline.to({}, { duration: 2.4 })
  whileVisible(plan, timeline)
}

export type LandingMotion = {
  dispose(): void
}

export function setupLandingMotion(
  root: HTMLElement,
  { onHeroScroll }: { onHeroScroll(progress: number): void }
): LandingMotion {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  const nav = document.querySelector<HTMLElement>("[data-landing-nav]")
  const hero = root.querySelector<HTMLElement>("[data-landing-hero]")
  const snapshot = [...root.querySelectorAll<HTMLElement>(DEMO_NODES)].map((node) => ({
    node,
    // Only leaf nodes get their text back: restoring text on a node with children would erase them.
    text: node.childElementCount === 0 ? node.textContent : null,
    style: node.getAttribute("style"),
    state: node.dataset.state,
  }))
  const removers: Array<() => void> = []
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ) => {
    target.addEventListener(type, handler, options)
    removers.push(() => target.removeEventListener(type, handler))
  }

  const build = () => {
    ScrollTrigger.create({
      start: 24,
      end: "max",
      onToggle: (self) => nav?.setAttribute("data-scrolled", String(self.isActive)),
    })
    if (hero) {
      ScrollTrigger.create({
        trigger: hero,
        start: "top top",
        end: "bottom top",
        onUpdate: (self) => onHeroScroll(self.progress),
      })
    }
    if (reduced) return

    // Hero entrance: the copy starts at once and never waits for WebGL; the scene fades in on its own.
    gsap
      .timeline({ defaults: { ease: "expo.out" }, delay: 0.05 })
      .from(".hero-line > span", {
        yPercent: 130,
        duration: 1.4,
        stagger: 0.1,
        // At rest the lines stop clipping, so descenders and the glow never get cut.
        onComplete: () => gsap.set(".landing-line", { overflow: "visible" }),
      })
      .from(".hero-sub", { opacity: 0, y: 24, duration: 1.2 }, "<0.5")
      // The row moves, not the buttons: their own x/y belong to the magnetic hover.
      .from(".hero-cta", { opacity: 0, y: 20, duration: 1 }, "<0.15")
      .from(".landing-chip", { opacity: 0, scale: 0.85, y: 24, duration: 1.2, stagger: 0.18, ease: "back.out(1.4)" }, "<0.2")
    gsap.utils.toArray<HTMLElement>(".landing-chip").forEach((chip, index) => {
      // yPercent, so the float never fights the entrance's y.
      gsap.to(chip, { yPercent: index % 2 ? 22 : -22, duration: 3.2 + index * 0.7, ease: "sine.inOut", yoyo: true, repeat: -1 })
    })
    gsap.to(".hero-copy", {
      yPercent: -10,
      opacity: 0.15,
      ease: "none",
      scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: true },
    })

    // Section titles rise line by line; everything else lifts in once, in small batches.
    // Section titles rise line by line inside masks padded for descenders; once a title has
    // arrived the split is undone, so text at rest is plain and never clipped.
    gsap.utils.toArray<HTMLElement>(".landing-split").forEach((title) => {
      const split = SplitText.create(title, { type: "lines", mask: "lines", linesClass: "split-line" })
      gsap.from(split.lines, {
        yPercent: 130,
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.09,
        scrollTrigger: { trigger: title, start: "top 88%", once: true },
        onComplete: () => split.revert(),
      })
    })
    gsap.set(".landing-reveal", { opacity: 0, y: 44 })
    root.classList.add("motion-ready")
    ScrollTrigger.batch(".landing-reveal", {
      start: "top 90%",
      once: true,
      onEnter: (batch) =>
        gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: "expo.out", stagger: 0.08, overwrite: true, clearProps: "transform" }),
    })

    // Sources drift by; hovering slows them down.
    const track = root.querySelector<HTMLElement>("[data-marquee]")
    if (track) {
      const drift = gsap.to(track, { xPercent: -50, duration: 38, ease: "none", repeat: -1 })
      const slow = () => gsap.to(drift, { timeScale: 0.2, duration: 0.6 })
      const resume = () => gsap.to(drift, { timeScale: 1, duration: 0.6 })
      listen(track, "pointerenter", slow)
      listen(track, "pointerleave", resume)
    }

    // Primary actions lean toward the pointer.
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      gsap.utils.toArray<HTMLElement>(".magnetic").forEach((button) => {
        const x = gsap.quickTo(button, "x", { duration: 0.5, ease: "power3.out" })
        const y = gsap.quickTo(button, "y", { duration: 0.5, ease: "power3.out" })
        listen(button, "pointermove", (event) => {
          const box = button.getBoundingClientRect()
          x((event.clientX - box.left - box.width / 2) * 0.25)
          y((event.clientY - box.top - box.height / 2) * 0.35)
        })
        listen(button, "pointerleave", () => {
          x(0)
          y(0)
        })
      })
    }

    liveDemo(root)
    askDemo(root)
    planDemo(root)

    // The feature diagrams loop in CSS, and only while their card is on screen.
    gsap.utils.toArray<HTMLElement>(".bento-card").forEach((card) => {
      ScrollTrigger.create({
        trigger: card,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => card.toggleAttribute("data-playing", self.isActive),
      })
    })
  }

  const context = gsap.context(() => {})
  const teardown = () => {
    removers.splice(0).forEach((remove) => remove())
    context.revert()
    root.classList.remove("motion-ready")
    root.querySelectorAll("[data-playing]").forEach((card) => card.removeAttribute("data-playing"))
    for (const { node, text, style, state } of snapshot) {
      if (text !== null) node.textContent = text
      if (style === null) node.removeAttribute("style")
      else node.setAttribute("style", style)
      if (state === undefined) delete node.dataset.state
      else node.dataset.state = state
    }
  }
  try {
    context.add(build)
    // Late font swaps move every trigger; measure again once fonts settle.
    void document.fonts?.ready.then(() => ScrollTrigger.refresh())
  } catch {
    // Motion is decoration: on any failure the page falls back to its complete, static state.
    teardown()
  }

  // Bento cards light up under the pointer.
  for (const bento of root.querySelectorAll<HTMLElement>("[data-bento]")) {
    listen(bento, "pointermove", (event) => {
      const card = (event.target as Element).closest<HTMLElement>(".bento-card")
      if (!card) return
      const box = card.getBoundingClientRect()
      card.style.setProperty("--mx", `${event.clientX - box.left}px`)
      card.style.setProperty("--my", `${event.clientY - box.top}px`)
    })
  }

  return {
    dispose: teardown,
  }
}
