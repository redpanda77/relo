import { LazyMotion } from "motion/react"
import * as React from "react"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { SelectionIndicator } from "@/components/atoms/selection-indicator"
import { toolLabel } from "@/components/atoms/source-logo"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Input } from "@/components/ui/input"
import { SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Access } from "@/features/connections/computer-panel/access"
import { Overview } from "@/features/connections/computer-panel/overview"
import { OnYourIphone } from "@/features/connections/computer-panel/on-your-iphone"
import { Settings } from "@/features/connections/computer-panel/settings"
import { Setup } from "@/features/connections/computer-panel/setup"
import { errorText } from "@/features/connections/computer-panel/error-text"
import { PanelSection } from "@/features/connections/computer-panel/shared"
import type { ConnectionComputer } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"
import { loadMotionFeatures } from "@/lib/motion"
import type { ConnectionsService } from "@/services/connections-service"

const SECTIONS = [
  { key: "overview", title: "Overview" },
  { key: "iphone", title: "On your iPhone" },
  { key: "setup", title: "Setup" },
  { key: "settings", title: "Settings" },
  { key: "access", title: "Access" },
] as const
type SectionKey = (typeof SECTIONS)[number]["key"]

/** The name, edited in place: Enter or leaving the field saves, Escape puts the old name back, empty goes back to the login's name. */
function NameField({ computer, api, onChange }: { computer: ConnectionComputer; api: ConnectionsService; onChange(record: ConnectionComputer): void }) {
  const [draft, setDraft] = React.useState(computer.name)
  const [state, setState] = React.useState<{ pending: boolean; error: string | null; saved: boolean }>({ pending: false, error: null, saved: false })
  async function save() {
    const trimmed = draft.trim()
    if (trimmed === computer.name || (trimmed === "" && computer.name === computer.label)) {
      setDraft(computer.name)
      return
    }
    setState({ pending: true, error: null, saved: false })
    try {
      // Empty means "use the login's name again".
      const record = await api.updateComputer(computer.id, { name: trimmed === "" ? null : trimmed })
      onChange(record)
      setDraft(record.name)
      setState({ pending: false, error: null, saved: true })
    } catch (cause) {
      setDraft(computer.name)
      setState({ pending: false, error: errorText(cause), saved: false })
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <NameInput value={draft} onChange={setDraft} onSave={() => void save()} onRevert={() => setDraft(computer.name)} />
      <OperationStatus
        className="mt-1 text-xs"
        pending={state.pending}
        pendingLabel="Saving…"
        error={state.error}
        success={state.saved ? "Saved" : null}
      />
    </div>
  )
}

function NameInput({ value, onChange, onSave, onRevert }: { value: string; onChange(value: string): void; onSave(): void; onRevert(): void }) {
  return (
    <Input
      aria-label="Computer name"
      data-name-field=""
      value={value}
      maxLength={80}
      placeholder="Name this computer"
      className="h-10 border-transparent bg-transparent px-2 text-lg font-semibold hover:border-[var(--hairline)] focus-visible:bg-white/[0.04]"
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onSave}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          // Revert first, so leaving the field has nothing to save.
          onRevert()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** The section pills: they scroll the panel to a section, and follow it as it scrolls. */
function SectionNav({ active, onGo }: { active: SectionKey; onGo(key: SectionKey): void }) {
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <nav aria-label="Computer sections" className="sticky top-0 z-10 border-y border-[var(--divider)] bg-popover/95 backdrop-blur-md">
        <div className="flex gap-2 overflow-x-auto px-4 py-2 sm:px-6" data-glide-pills>
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              type="button"
              className="pill shrink-0"
              aria-current={active === section.key ? "true" : undefined}
              aria-pressed={active === section.key}
              onClick={() => onGo(section.key)}
            >
              {active === section.key ? <SelectionIndicator layoutId="computer-panel-section" /> : null}
              {section.title}
            </button>
          ))}
        </div>
      </nav>
    </LazyMotion>
  )
}

export function ComputerPanel({
  computer,
  api,
  onChange,
  onSignedOut,
}: {
  computer: ConnectionComputer
  api: ConnectionsService
  onChange(update: (current: ConnectionComputer) => ConnectionComputer): void
  onSignedOut(): void
}) {
  const uid = React.useId()
  const scroller = React.useRef<HTMLDivElement>(null)
  const [active, setActive] = React.useState<SectionKey>("overview")
  const idFor = (key: SectionKey) => `${uid}-${key}`
  const Glyph = COMPUTER_ICON_META[computer.icon].glyph

  // The pill that matches the section under the top of the scrolled panel.
  React.useEffect(() => {
    const root = scroller.current
    if (!root || typeof IntersectionObserver === "undefined") return
    const seen = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting ? entry.boundingClientRect.top : Number.POSITIVE_INFINITY)
        const first = SECTIONS.find((section) => (seen.get(idFor(section.key)) ?? Number.POSITIVE_INFINITY) !== Number.POSITIVE_INFINITY)
        if (first) setActive(first.key)
      },
      { root, rootMargin: "-56px 0px -60% 0px" }
    )
    for (const section of SECTIONS) {
      const element = document.getElementById(idFor(section.key))
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = (key: SectionKey) => {
    setActive(key)
    document.getElementById(idFor(key))?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
  }

  const meta = [
    computer.tools.length ? computer.tools.map(toolLabel).join(", ") : null,
    computer.lastSeenAt ? `seen ${relativeTime(computer.lastSeenAt)}` : "not used yet",
    computer.report ? `CLI ${computer.report.cli.version}` : null,
  ].filter(Boolean).join(" · ")

  return (
    <SheetContent
      ref={scroller}
      className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-[44rem]"
      // Escape in the name field puts the old name back; it closes the panel only from anywhere else.
      onEscapeKeyDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.hasAttribute("data-name-field")) event.preventDefault()
      }}
    >
      <div className="flex items-start gap-3 px-4 pt-5 pr-14 pb-4 sm:px-6">
        <button
          type="button"
          aria-label="Change icon"
          className="icon-tile press shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          data-size="md"
          style={{ width: 48, height: 48 }}
          onClick={() => {
            go("iphone")
            document.getElementById(idFor("iphone"))?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true })
          }}
        >
          <Glyph aria-hidden="true" className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <SheetTitle className="sr-only">{computer.name}</SheetTitle>
          <NameField key={computer.name} computer={computer} api={api} onChange={(record) => onChange((current) => ({ ...current, ...record }))} />
          <SheetDescription className="mt-0.5 truncate px-2 text-xs">{meta}</SheetDescription>
        </div>
      </div>
      <SectionNav active={active} onGo={go} />
      <div className="pt-6">
        <PanelSection id={idFor("overview")} title="Overview" first>
          <Overview computer={computer} />
        </PanelSection>
        <PanelSection id={idFor("iphone")} title="On your iPhone" description="How this computer's cards look on your phone. A change reaches cards that are already open.">
          <OnYourIphone computer={computer} api={api} onChange={onChange} />
        </PanelSection>
        <PanelSection id={idFor("setup")} title="Setup">
          <Setup computer={computer} />
        </PanelSection>
        <PanelSection id={idFor("settings")} title="Settings">
          <Settings computer={computer} />
        </PanelSection>
        <PanelSection id={idFor("access")} title="Access">
          <Access
            computer={computer}
            api={api}
            onHookRevoked={(id) => onChange((current) => ({ ...current, hooks: current.hooks.filter((hook) => hook.id !== id) }))}
            onSignedOut={onSignedOut}
          />
        </PanelSection>
      </div>
    </SheetContent>
  )
}
