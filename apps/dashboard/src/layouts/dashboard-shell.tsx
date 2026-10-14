import { revokeCurrentBrowser } from "@/lib/e2ee/browser-link"
import { forgetBrowserKeys } from "@/lib/e2ee/keys"
import {
  BookOpen,
  Cable,
  ChevronsUpDown,
  FlaskConical,
  FolderKanban,
  History,
  Menu,
  Radio,
  LogOut,
  UserRound,
} from "lucide-react"
import * as React from "react"

import { BrandLockup } from "@/components/brand"

import type { AuthenticatedDashboardBootstrap } from "@/app/bootstrap"
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
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"

const navigation = [
  {
    label: "Now",
    href: "/dashboard",
    icon: Radio,
    sections: ["inbox"],
  },
  {
    label: "History",
    href: "/dashboard/inbox/notifications",
    icon: History,
    sections: ["inbox-notifications", "inbox-delivery"],
  },
  {
    label: "Projects",
    href: "/dashboard/projects",
    icon: FolderKanban,
    sections: ["projects"],
  },
  {
    label: "Connections",
    href: "/dashboard/connections",
    icon: Cable,
    sections: [
      "connections",
      "connections-phones",
      "connections-clients",
    ],
  },
  {
    label: "Test Lab",
    href: "/dashboard/testing",
    icon: FlaskConical,
    sections: ["testing"],
  },
]

const secondaryNavigation = [
  {
    label: "Account",
    href: "/dashboard/account",
    icon: UserRound,
    sections: ["account"],
  },
  {
    label: "Documentation",
    href: "/dashboard/docs",
    icon: BookOpen,
    sections: ["docs"],
  },
]

type Shell = AuthenticatedDashboardBootstrap["shell"]

type NavItem = (typeof navigation)[number]

const navLinkClass =
  "relative min-h-10 gap-3 rounded-xl px-3 text-muted-foreground hover:text-foreground data-active:bg-white/[0.06] data-active:text-foreground data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-[var(--primary)] [&[data-active=true]>svg]:text-[var(--primary)]"

function NavList({ items, active, needsYou, label }: { items: NavItem[]; active: string; needsYou: number; label: string }) {
  return (
    <nav aria-label={label}>
      <SidebarMenu className="gap-1">
        {items.map((item) => {
          const Icon = item.icon
          const current = item.sections.includes(active)
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={current} className={navLinkClass}>
                <a href={item.href} aria-current={current ? "page" : undefined}>
                  <Icon aria-hidden="true" />
                  <span className="flex-1">{item.label}</span>
                  {item.href === "/dashboard" && needsYou > 0 ? (
                    <span className="min-w-5 rounded-full bg-[var(--neon-orange)] px-1.5 text-center text-[11px] leading-5 font-bold text-[#1b0905]" aria-label={`${needsYou} need you`}>
                      {needsYou}
                    </span>
                  ) : null}
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </nav>
  )
}

/** The iPhone's tab bar on narrow screens; "More" opens the full menu. */
function MobileTabBar({ active, needsYou }: { active: string; needsYou: number }) {
  const { openMobile, setOpenMobile } = useSidebar()
  const moreRef = React.useRef<HTMLButtonElement>(null)
  const wasOpen = React.useRef(false)

  React.useEffect(() => {
    if (wasOpen.current && !openMobile) moreRef.current?.focus()
    wasOpen.current = openMobile
  }, [openMobile])

  const tabs = navigation.slice(0, 4)
  const moreActive = !tabs.some((item) => item.sections.includes(active))
  return (
    <nav aria-label="Tabs" className="tab-bar">
      {tabs.map((item) => {
        const Icon = item.icon
        const current = item.sections.includes(active)
        return (
          <a key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
            <Icon aria-hidden="true" />
            {item.label}
            {item.href === "/dashboard" && needsYou > 0 ? (
              <span className="tab-badge" aria-label={`${needsYou} need you`}>{needsYou}</span>
            ) : null}
          </a>
        )
      })}
      <button
        ref={moreRef}
        type="button"
        id="mobile-nav-toggle"
        aria-controls="dashboard-sidebar"
        aria-expanded={openMobile}
        aria-current={moreActive ? "page" : undefined}
        onClick={() => setOpenMobile(!openMobile)}
      >
        <Menu aria-hidden="true" />
        More
      </button>
    </nav>
  )
}

function ProfileMenu({ shell }: { shell: Shell }) {
  const [pending, setPending] = React.useState(false)
  const signOut = async () => {
    setPending(true)
    try {
      await revokeCurrentBrowser()
      try {
        const response = await fetch("/api/auth/sign-out", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        if (!response.ok) throw new Error("Sign out failed")
      } finally {
        // Keys go even if the server's sign-out fails: nothing this browser could read stays readable.
        await forgetBrowserKeys()
      }
      window.location.assign("/")
    } finally {
      setPending(false)
    }
  }
  const { account } = shell
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id="profile-menu"
        className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
      >
        <span className="brand-gradient grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold text-primary-foreground">
          {account.initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {account.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {account.email}
          </span>
        </span>
        <ChevronsUpDown
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
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
        <DropdownMenuItem
          id="sign-out"
          disabled={pending}
          onSelect={() => void signOut()}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardShell({
  shell,
  children,
}: {
  shell: Shell
  children: React.ReactNode
}) {
  const needsYou = "counts" in shell && shell.counts ? shell.counts.pending : 0
  return (
    <SidebarProvider>
      <a
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      <Sidebar collapsible="offcanvas" aria-label="Dashboard navigation">
        <aside
          id="dashboard-sidebar"
          className="flex h-full min-w-0 flex-col"
          aria-label="Dashboard navigation"
        >
          <SidebarHeader className="h-16 flex-row items-center gap-2.5 px-5 py-0">
            <a href="/dashboard" aria-label="Relo, Now" className="rounded-lg">
              <BrandLockup orbClassName="size-7" />
            </a>
            <SidebarTrigger
              className="ml-auto size-11 md:hidden"
              aria-label="Close menu"
            />
          </SidebarHeader>

          <SidebarContent className="gap-6 px-3 pt-2">
            <NavList items={navigation} active={shell.active} needsYou={needsYou} label="Primary" />
            <div>
              <p className="micro mb-2 px-3">Settings</p>
              <NavList items={secondaryNavigation} active={shell.active} needsYou={0} label="Settings" />
            </div>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <ProfileMenu shell={shell} />
          </SidebarFooter>
        </aside>
      </Sidebar>

      {/* On a phone the tab bar is the navigation and each page titles itself: no brand bar on top. */}
      <div data-dashboard-main className="max-w-full min-w-0 flex-1">
        {children}
      </div>
      <MobileTabBar active={shell.active} needsYou={needsYou} />
    </SidebarProvider>
  )
}
