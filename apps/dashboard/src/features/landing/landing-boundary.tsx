import * as React from "react"

import { BrandLockup } from "@/components/brand"
import { GITHUB_URL } from "@/features/auth/github"

/** If the landing chunk fails to load or throws, the visitor still gets the essentials, never a blank page. */
export class LandingBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main id="main-content" className="canvas grid min-h-[100dvh] place-items-center px-6 text-center">
        <div>
          <BrandLockup orbClassName="size-8" className="justify-center" />
          <h1 className="mt-6 font-[family-name:var(--font-rounded)] text-4xl font-bold tracking-tight">
            Every agent. <span className="text-[var(--muted-foreground)]">One place.</span>
          </h1>
          <p className="mt-3 text-[var(--muted-foreground)]">Live status for your AI agents, on your iPhone's Lock Screen.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a href="/sign-in" className="capsule-cta inline-flex items-center px-7">Sign in</a>
            <a href={GITHUB_URL} className="inline-flex min-h-[52px] items-center rounded-full border border-white/15 px-6" rel="external noopener">
              GitHub
            </a>
          </div>
        </div>
      </main>
    )
  }
}
