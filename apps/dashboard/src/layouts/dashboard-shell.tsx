import { signOutThisBrowser } from "@/lib/sign-out"
import {
  BookOpen,
  Cable,
  ChevronRight,
  ChevronsUpDown,
  FlaskConical,
  History,
  Keyboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  LogOut,
  UserRound,
  X,
} from "lucide-react"
import { LayoutGroup, LazyMotion, m } from "motion/react"
import * as React from "react"
import { Drawer } from "vaul"

import { BrandLockup, BrandOrb } from "@/components/brand"

import type { AuthenticatedDashboardBootstrap } from "@/app/bootstrap"
import { NeedsYouBadge } from "@/components/atoms/needs-you-badge"
import {
  CommandPalette,
  ShortcutsDialog,
  type PaletteCommand,
  type ShortcutGroup,
} from "@/components/organisms/command-palette"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useHotkeys } from "@/hooks/use-hotkeys"
import { useFoldGlide } from "@/hooks/use-fold-glide"
import { useIsTablet } from "@/hooks/use-viewport"
import { loadMotionFeatures, SPRINGS } from "@/lib/motion"
import { navigateDashboard } from "@/state/use-dashboard-route"

type NavItem = {
  label: string
  href: string
  icon: typeof Radio
  sections: string[]
  /** The second key of its `g` jump. */
  key?: string
  /** The Settings-style tile colour in the phone's More sheet. */
  tone?: string
}

const navigation: NavItem[] = [
  { label: "Now", href: "/dashboard", icon: Radio, sections: ["inbox"], key: "n" },
  {
    label: "History",
    href: "/dashboard/inbox/notifications",
    icon: History,
    sections: ["inbox-notifications", "inbox-delivery"],
    key: "h",
  },
  {
    label: "Connections",
    href: "/dashboard/connections",
    icon: Cable,
    sections: ["connections", "connections-phones", "connections-clients"],
    key: "c",
  },
]

const secondaryNavigation: NavItem[] = [
  {
    label: "Account",
    href: "/dashboard/account",
    icon: UserRound,
    sections: ["account"],
    key: "a",
    tone: "tone-violet",
  },
  // A tool for checking delivery, not a place the owner visits daily: with the settings.
  {
    label: "Test Lab",
    href: "/dashboard/testing",
    icon: FlaskConical,
    sections: ["testing"],
    key: "t",
    tone: "tone-cyan",
  },
  // The public docs site: outside the dashboard, so a full page load.
  { label: "Documentation", href: "/docs", icon: BookOpen, sections: [], tone: "tone-mint" },
]

const allNavigation = [...navigation, ...secondaryNavigation]
const tabs = navigation.slice(0, 4)
const moreItems = allNavigation.filter((item) => !tabs.includes(item))

type Shell = AuthenticatedDashboardBootstrap["shell"]

const IS_APPLE =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_APPLE ? "⌘" : "Ctrl+"
const SIDEBAR_SHORTCUT = `${MOD}B`

const chordLabel = (item: NavItem) => (item.key ? `G ${item.key.toUpperCase()}` : undefined)

/** Sign-out, shared by the profile menu, the phone's More sheet and the command menu. */
function useSignOut() {
  const [pending, setPending] = React.useState(false)
  const signOut = React.useCallback(async () => {
    setPending(true)
    try {
      await signOutThisBrowser()
      window.location.assign("/")
    } finally {
      setPending(false)
    }
  }, [])
  return { pending, signOut }
}

function NavList({
  items,
  active,
  needsYou,
  label,
}: {
  items: NavItem[]
  active: string
  needsYou: number
  label: string
}) {
  const { state } = useSidebar()
  return (
    <nav aria-label={label}>
      <SidebarMenu className="gap-0.5">
        {items.map((item) => {
          const Icon = item.icon
          const current = item.sections.includes(active)
          const count = item.href === "/dashboard" ? needsYou : 0
          const chord = chordLabel(item)
          const tooltip = [item.label, count > 0 ? `${count} need you` : null, chord]
            .filter(Boolean)
            .join(" · ")
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={current} tooltip={tooltip} className="nav-link">
                <a href={item.href} aria-current={current ? "page" : undefined}>
                  {current ? (
                    // One lit pill for the whole sidebar: it glides to the page shown, and follows
                    // its row through a fold. Decorative; aria-current says which page it is.
                    <m.span
                      layoutId="nav-pill"
                      layoutDependency={state}
                      className="nav-pill"
                      style={{ borderRadius: 12 }}
                      transition={SPRINGS.snappy}
                      aria-hidden="true"
                    />
                  ) : null}
                  <Icon aria-hidden="true" />
                  <span className="nav-label flex-1">{item.label}</span>
                  <NeedsYouBadge
                    count={count}
                    variant={state === "collapsed" ? "dot" : "count"}
                    className="nav-badge"
                  />
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </nav>
  )
}

/**
 * The brand and the collapse control. Expanded: the lockup links to Now and a quiet button folds
 * the sidebar to its icon rail. Folded: the orb itself expands it again, turning into the open
 * icon on hover so the control is discoverable without taking a row.
 */
function SidebarBrand() {
  const { state, toggleSidebar } = useSidebar()
  if (state === "collapsed") {
    return (
      <SidebarHeader className="h-16 flex-row items-center px-2 py-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              className="sidebar-orb-toggle group/orb"
            >
              <BrandOrb className="size-7 transition-opacity group-hover/orb:opacity-0 group-focus-visible/orb:opacity-0" />
              <PanelLeftOpen
                className="absolute size-[18px] opacity-0 transition-opacity group-hover/orb:opacity-100 group-focus-visible/orb:opacity-100"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{`Expand sidebar · ${SIDEBAR_SHORTCUT}`}</TooltipContent>
        </Tooltip>
      </SidebarHeader>
    )
  }
  return (
    <SidebarHeader className="h-16 flex-row items-center gap-2 py-0 pr-2 pl-3.5">
      <a href="/dashboard" aria-label="Relo, Now" className="rounded-lg">
        <BrandLockup orbClassName="size-7" />
      </a>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            className="sidebar-icon-button ml-auto"
          >
            <PanelLeftClose className="size-[18px]" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{`Collapse sidebar · ${SIDEBAR_SHORTCUT}`}</TooltipContent>
      </Tooltip>
    </SidebarHeader>
  )
}

/** The sidebar opens as the owner last left it (the provider remembers it in a cookie). */
function sidebarOpenAtStart() {
  return (
    typeof document === "undefined" ||
    !/(?:^|;\s*)sidebar_state=false/.test(document.cookie)
  )
}

/** Tablets (768–1099px) always start on the icon rail; wider windows as the owner left them. */
function openAtStart() {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth
  return width >= 768 && width < 1100 ? false : sidebarOpenAtStart()
}

/** The selected tab's coral capsule: one element that glides between tabs (decorative). */
function TabPill() {
  return <m.span layoutId="tab-pill" className="tab-pill" transition={SPRINGS.snappy} aria-hidden="true" />
}

/**
 * The iPhone's tab bar on narrow screens; "More" opens the rest. Tapping the tab of the page shown
 * glides back to the top (the router handles that link).
 */
function MobileTabBar({
  active,
  needsYou,
}: {
  active: string
  needsYou: number
}) {
  const { openMobile, setOpenMobile } = useSidebar()
  const moreRef = React.useRef<HTMLButtonElement>(null)
  const wasOpen = React.useRef(false)

  // The sheet has no Radix trigger, so focus returns to More by hand when it closes.
  React.useEffect(() => {
    if (wasOpen.current && !openMobile) moreRef.current?.focus()
    wasOpen.current = openMobile
  }, [openMobile])

  const moreActive = !tabs.some((item) => item.sections.includes(active))
  return (
    <nav aria-label="Tabs" className="tab-bar" style={{ "--tab-count": tabs.length + 1 } as React.CSSProperties}>
      {tabs.map((item) => {
        const Icon = item.icon
        const current = item.sections.includes(active)
        return (
          <a key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
            {current ? <TabPill /> : null}
            <span className="tab-icon">
              <Icon aria-hidden="true" />
              {item.href === "/dashboard" ? (
                <NeedsYouBadge count={needsYou} className="tab-badge" />
              ) : null}
            </span>
            <span className="tab-label">{item.label}</span>
          </a>
        )
      })}
      <button
        ref={moreRef}
        type="button"
        id="mobile-nav-toggle"
        aria-controls="more-sheet"
        aria-expanded={openMobile}
        aria-haspopup="dialog"
        data-active={moreActive ? "true" : undefined}
        onClick={() => setOpenMobile(!openMobile)}
      >
        {moreActive ? <TabPill /> : null}
        <span className="tab-icon">
          <Menu aria-hidden="true" />
        </span>
        <span className="tab-label">More</span>
      </button>
    </nav>
  )
}

/**
 * The phone's More: a bottom sheet with a grabber, the owner, the pages without a tab as
 * Settings-style rows, sign out on its own row, and the version.
 */
function MoreSheet({ shell, active }: { shell: Shell; active: string }) {
  const { openMobile, setOpenMobile } = useSidebar()
  const { pending, signOut } = useSignOut()
  const { account } = shell
  return (
    <Drawer.Root open={openMobile} onOpenChange={setOpenMobile} autoFocus>
      <Drawer.Portal>
        <Drawer.Overlay className="more-sheet-scrim" />
        <Drawer.Content id="more-sheet" className="more-sheet" aria-describedby={undefined}>
          <div className="more-sheet-grabber" aria-hidden="true" />
          <div className="more-sheet-header">
            <Drawer.Title className="more-sheet-title">More</Drawer.Title>
            <Drawer.Close className="more-sheet-close size-11" aria-label="Close menu">
              <X aria-hidden="true" />
            </Drawer.Close>
          </div>
          <div className="more-sheet-body">
            <a
              href="/dashboard/account"
              className="more-sheet-profile"
              onClick={() => setOpenMobile(false)}
              aria-label={`${account.name}, ${account.email}, account`}
            >
              <span className="avatar size-12 text-lg">
                {account.initial}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[17px] font-semibold">{account.name}</span>
                <span className="block truncate text-sm text-muted-foreground">{account.email}</span>
              </span>
              <ChevronRight aria-hidden="true" className="more-sheet-chevron" />
            </a>
            <nav aria-label="More">
              <ul className="more-sheet-group">
                {moreItems.map((item) => {
                  const Icon = item.icon
                  const current = item.sections.includes(active)
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        aria-current={current ? "page" : undefined}
                        className="more-sheet-row"
                        onClick={() => setOpenMobile(false)}
                      >
                        <span className={`icon-tile ${item.tone ?? "tone-neutral"}`} aria-hidden="true">
                          <Icon />
                        </span>
                        <span className="flex-1">{item.label}</span>
                        <ChevronRight aria-hidden="true" className="more-sheet-chevron" />
                      </a>
                    </li>
                  )
                })}
              </ul>
            </nav>
            <div className="more-sheet-group">
              <button
                type="button"
                id="sign-out"
                className="more-sheet-row more-sheet-sign-out"
                disabled={pending}
                onClick={() => void signOut()}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            </div>
            <p className="more-sheet-version" data-release-identity={shell.releaseIdentity}>
              Relo {shell.releaseIdentity}
            </p>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function ProfileMenu({ shell }: { shell: Shell }) {
  const { pending, signOut } = useSignOut()
  const { state } = useSidebar()
  const { account } = shell
  const folded = state === "collapsed"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id="profile-menu"
        aria-label={`${account.name}, account menu`}
        title={`${account.name} · ${account.email}`}
        className="profile-trigger"
      >
        <span className="avatar size-8 text-sm">
          {account.initial}
        </span>
        <span className="nav-label min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {account.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {account.email}
          </span>
        </span>
        <ChevronsUpDown className="nav-label size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={folded ? "right" : "top"}
        align={folded ? "end" : "start"}
        sideOffset={folded ? 12 : 8}
        className="w-56"
      >
        <DropdownMenuItem asChild>
          <a href="/dashboard/account">
            <UserRound aria-hidden="true" />
            Account
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel
          className="text-xs font-normal text-muted-foreground"
          data-release-identity={shell.releaseIdentity}
        >
          Relo {shell.releaseIdentity}
        </DropdownMenuLabel>
        <DropdownMenuItem id="sign-out" disabled={pending} onSelect={() => void signOut()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "Go to",
    rows: allNavigation
      .filter((item) => item.key)
      .map((item) => ({ label: item.label, keys: ["G", item.key!.toUpperCase()] })),
  },
  {
    title: "Anywhere",
    rows: [
      { label: "Command menu", keys: [IS_APPLE ? "⌘" : "Ctrl", "K"] },
      { label: "Fold or open the sidebar", keys: [IS_APPLE ? "⌘" : "Ctrl", "B"] },
      { label: "Keyboard shortcuts", keys: ["?"] },
    ],
  },
]

/** Keyboard: `g` jumps, `?` lists the shortcuts, ⌘K opens the command menu. */
function KeyboardLayer({ isMobile }: { isMobile: boolean }) {
  const { state, toggleSidebar } = useSidebar()
  const { signOut } = useSignOut()
  const [palette, setPalette] = React.useState(false)
  const [help, setHelp] = React.useState(false)

  const go = React.useCallback((href: string) => {
    const here = `${window.location.pathname}${window.location.search}`
    if (here === href) return
    if (href === "/dashboard" || href.startsWith("/dashboard/")) navigateDashboard(href)
    else window.location.assign(href)
  }, [])

  const chords = React.useMemo(
    () =>
      Object.fromEntries(
        allNavigation.filter((item) => item.key).map((item) => [item.key!, () => go(item.href)])
      ),
    [go]
  )
  useHotkeys({
    chords,
    keys: { "?": () => setHelp(true) },
    mod: { k: () => setPalette((open) => !open) },
  })

  const commands = React.useMemo<PaletteCommand[]>(() => {
    const pages: PaletteCommand[] = allNavigation.map((item) => ({
      id: `go-${item.href}`,
      label: item.label,
      group: "Go to",
      icon: item.icon,
      shortcut: chordLabel(item),
      run: () => go(item.href),
    }))
    const sidebar: PaletteCommand[] = isMobile
      ? []
      : [
          {
            id: "sidebar",
            label: state === "collapsed" ? "Expand sidebar" : "Collapse sidebar",
            group: "Sidebar",
            icon: state === "collapsed" ? PanelLeftOpen : PanelLeftClose,
            shortcut: SIDEBAR_SHORTCUT,
            run: toggleSidebar,
          },
        ]
    return [
      ...pages,
      ...sidebar,
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        group: "Account",
        icon: Keyboard,
        shortcut: "?",
        run: () => setHelp(true),
      },
      { id: "sign-out", label: "Sign out", group: "Account", icon: LogOut, run: () => void signOut() },
    ]
  }, [go, isMobile, signOut, state, toggleSidebar])

  return (
    <>
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} groups={shortcutGroups} />
    </>
  )
}

/** Everything that needs the sidebar's context: the sidebar or tab bar, sheets and shortcuts. */
function ShellLayout({
  shell,
  isTablet,
  setOpen,
  children,
}: {
  shell: Shell
  isTablet: boolean
  setOpen: (open: boolean) => void
  children: React.ReactNode
}) {
  const { isMobile, open, setOpenMobile } = useSidebar()
  const needsYou = "counts" in shell && shell.counts ? shell.counts.pending : 0
  // The shell stays mounted across client navigation: each new page (a new bootstrap, so a new
  // shell object) is keyed by its path, which replays the page entrance and closes the sheets.
  // Read once per page, so a page's own client routes (Test Lab) never remount it.
  const path = React.useMemo(
    () => (typeof window === "undefined" ? "" : window.location.pathname),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shell]
  )
  const drawerOpen = isTablet && open
  const mainRef = React.useRef<HTMLDivElement>(null)
  // Folding the sidebar moves the page once, then glides it from where it stood (no per-frame reflow).
  useFoldGlide(mainRef, open, !isMobile && !isTablet)

  // A new page closes the phone's More sheet and the tablet's drawer.
  React.useEffect(() => {
    setOpenMobile(false)
    if (isTablet) setOpen(false)
    // Only a navigation (a new section or path) closes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell.active, path])

  React.useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen, setOpen])

  return (
    <>
      <a
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      {isMobile ? null : (
        <Sidebar collapsible="icon" variant="floating">
          <div id="dashboard-sidebar" className="flex h-full min-w-0 flex-col">
            <SidebarBrand />

            <SidebarContent className="gap-5 px-2 pt-3 group-data-[collapsible=icon]:gap-3">
              <LayoutGroup id="sidebar-nav">
              <NavList items={navigation} active={shell.active} needsYou={needsYou} label="Primary" />
              <div>
                <div className="nav-section-label">
                  <p className="micro nav-label px-3">Settings</p>
                  <SidebarSeparator className="nav-section-rule" />
                </div>
                <NavList items={secondaryNavigation} active={shell.active} needsYou={0} label="Settings" />
              </div>
              </LayoutGroup>
            </SidebarContent>

            <SidebarFooter className="p-2">
              <ProfileMenu shell={shell} />
            </SidebarFooter>
          </div>
          <SidebarRail />
        </Sidebar>
      )}
      {drawerOpen ? (
        <div className="sidebar-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      ) : null}

      {/* On a phone the tab bar is the navigation and each page titles itself: no brand bar on top. */}
      <div key={path} ref={mainRef} data-dashboard-main data-page-enter className="max-w-full min-w-0 flex-1">
        {children}
      </div>
      <MobileTabBar active={shell.active} needsYou={needsYou} />
      {isMobile ? <MoreSheet shell={shell} active={shell.active} /> : null}
      <KeyboardLayer isMobile={isMobile} />
    </>
  )
}

export function DashboardShell({
  shell,
  children,
}: {
  shell: Shell
  children: React.ReactNode
}) {
  const isTablet = useIsTablet()
  const [open, setOpen] = React.useState(openAtStart)
  const wasTablet = React.useRef(isTablet)

  // Crossing into the tablet range folds to the rail; leaving it restores the owner's choice.
  React.useEffect(() => {
    if (wasTablet.current === isTablet) return
    wasTablet.current = isTablet
    setOpen(isTablet ? false : sidebarOpenAtStart())
  }, [isTablet])

  return (
    // The rail's labels show at once: in a folded sidebar they are the only names.
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={loadMotionFeatures} strict>
      <SidebarProvider
        open={open}
        onOpenChange={setOpen}
        persistState={!isTablet}
        data-tablet={isTablet ? "true" : undefined}
      >
        <ShellLayout shell={shell} isTablet={isTablet} setOpen={setOpen}>
          {children}
        </ShellLayout>
      </SidebarProvider>
      </LazyMotion>
    </TooltipProvider>
  )
}
