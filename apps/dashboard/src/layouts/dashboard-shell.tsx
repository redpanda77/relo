import {
  BellRing,
  BookOpen,
  Cable,
  ChevronsUpDown,
  FlaskConical,
  FolderKanban,
  Inbox,
  LogOut,
  UserRound,
} from "lucide-react"
import * as React from "react"

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
    label: "Inbox",
    href: "/dashboard",
    icon: Inbox,
    sections: ["inbox", "inbox-notifications", "inbox-delivery"],
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

type Shell = AuthenticatedDashboardBootstrap["shell"]

function MobileSidebarTrigger() {
  const { openMobile } = useSidebar()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const wasOpen = React.useRef(false)

  React.useEffect(() => {
    if (wasOpen.current && !openMobile) triggerRef.current?.focus()
    wasOpen.current = openMobile
  }, [openMobile])

  return (
    <SidebarTrigger
      ref={triggerRef}
      id="mobile-nav-toggle"
      aria-controls="dashboard-sidebar"
      aria-expanded={openMobile}
      aria-label={openMobile ? "Close menu" : "Open menu"}
      className="size-11 md:hidden"
    />
  )
}

function ProfileMenu({ shell }: { shell: Shell }) {
  const [pending, setPending] = React.useState(false)
  const signOut = async () => {
    setPending(true)
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      if (!response.ok) throw new Error("Sign out failed")
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
        className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
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
        <DropdownMenuItem asChild>
          <a href="/dashboard/docs">
            <BookOpen aria-hidden="true" />
            Documentation
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
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <BellRing className="size-4" aria-hidden="true" />
            </span>
            <span className="font-semibold tracking-tight text-foreground">
              Relo
            </span>
            <SidebarTrigger
              className="ml-auto size-11 md:hidden"
              aria-label="Close menu"
            />
          </SidebarHeader>

          <SidebarContent className="px-3 pt-2">
            <nav aria-label="Primary">
              <SidebarMenu className="gap-1">
                {navigation.map((item) => {
                  const Icon = item.icon
                  const active = item.sections.includes(shell.active)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        className="min-h-10 gap-3 rounded-xl px-3 text-muted-foreground hover:text-foreground data-active:bg-accent data-active:text-foreground [&[data-active=true]>svg]:text-primary"
                      >
                        <a
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                        >
                          <Icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </nav>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <ProfileMenu shell={shell} />
          </SidebarFooter>
        </aside>
      </Sidebar>

      <div data-dashboard-main className="max-w-full min-w-0 flex-1">
        <header
          data-mobile-shell-header
          className="glass-strong sticky top-0 z-30 flex h-16 items-center gap-3 border-b px-4 md:hidden"
        >
          <MobileSidebarTrigger />
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
            <BellRing className="size-3.5" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">Relo</span>
        </header>
        {children}
      </div>
    </SidebarProvider>
  )
}
